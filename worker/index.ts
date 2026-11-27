/**
 * Worker process (document 03 "Worker behavior"). A separate OS process from the web app:
 *
 *   pnpm worker:dev      # TypeScript, watches nothing, reads .env
 *   pnpm worker:start    # bundled build produced by `pnpm build`
 *
 * It claims durable jobs from PostgreSQL with a lease, runs the registered handlers, records a
 * heartbeat, and runs idempotent maintenance sweeps. On SIGTERM/SIGINT it stops claiming, lets
 * in-flight jobs finish and gives back what it could not finish. It holds no business state in
 * memory: killing it at any point leaves every instruction resumable from the database.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import "@/server/bootstrap";
import { EXPECTED_MIGRATION } from "@/server/db/migrations";
import { getDeps } from "@/server/deps";
import { getEnv } from "@/server/env";
import { runMaintenance } from "@/server/jobs/maintenance";
import { registeredJobTypes, runWorker } from "@/server/jobs/runner";
import { logError, logInfo } from "@/server/logging";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

async function main(): Promise<void> {
  const env = getEnv();
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const startedAt = new Date();
  const buildId = process.env["BUILD_ID"] ?? null;
  const pollMs = intEnv("WORKER_POLL_MS", 500, 50, 60_000);
  const leaseMs = intEnv("WORKER_LEASE_MS", 60_000, 5_000, 900_000);
  const concurrency = intEnv("WORKER_CONCURRENCY", 5, 1, 32);
  const maintenanceMs = intEnv("WORKER_MAINTENANCE_MS", 15_000, 1_000, 3_600_000);

  const deps = await getDeps();
  // Refuse to process against a schema this build does not understand.
  const rows = await deps.db.$queryRaw<Array<{ migration_name: string }>>`
    SELECT "migration_name" FROM "_prisma_migrations"
     WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
     ORDER BY "migration_name" DESC LIMIT 1`;
  if (rows[0]?.migration_name !== EXPECTED_MIGRATION) {
    throw new Error(`Database migration level does not match this build (expected ${EXPECTED_MIGRATION}). Run \`pnpm db:migrate\`.`);
  }

  const controller = new AbortController();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logInfo("worker", "shutdown requested", { workerId, signal });
    controller.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  logInfo("worker", "started", {
    workerId,
    mode: env.appMode,
    coreAdapter: env.coreAdapter,
    concurrency,
    pollMs,
    jobTypes: registeredJobTypes().join(","),
  });

  let lastMaintenance = 0;
  await runWorker({
    workerId,
    pollMs,
    leaseMs,
    concurrency,
    signal: controller.signal,
    getDeps,
    heartbeat: async (db, processed) => {
      await db.workerHeartbeat.upsert({
        where: { workerId },
        create: { workerId, hostname: hostname(), pid: process.pid, startedAt, lastSeenAt: new Date(), jobsProcessed: processed, buildId },
        update: { lastSeenAt: new Date(), jobsProcessed: processed },
      });
      if (Date.now() - lastMaintenance >= maintenanceMs) {
        lastMaintenance = Date.now();
        await runMaintenance(await getDeps());
      }
    },
  });

  // A stopped worker must not look alive on the operations screen.
  await deps.db.workerHeartbeat.deleteMany({ where: { workerId } }).catch(() => undefined);
  await deps.db.$disconnect();
  logInfo("worker", "stopped", { workerId });
}

main().catch((error: unknown) => {
  logError("worker", "fatal", error);
  process.exit(1);
});
