/**
 * `pnpm worker:status` — is a worker alive, and what is waiting for it? (document 11)
 *
 * Reads the runtime database with the runtime role and prints counts only: no payload, no
 * reference, no amount and no personal data. Exit code 0 when a worker reported within the
 * last 30 seconds and nothing is dead-lettered, 1 otherwise — so it can be used as a check.
 */
import { readClockOffsetMs } from "../src/server/adapters/core/simulator-state";
import { getDb } from "../src/server/db/client";
import { getEnv } from "../src/server/env";
import { queueDiagnostics } from "../src/server/jobs/queue";

const HEALTHY_SECONDS = 30;

async function main(): Promise<void> {
  const env = getEnv();
  const db = getDb(env.databaseUrl);
  try {
    const wallNow = new Date();
    // Jobs become due on the sandbox business clock, which an operator may have moved forward.
    const businessNow = new Date(wallNow.getTime() + (await readClockOffsetMs(db)));
    const workers = await db.workerHeartbeat.findMany({ orderBy: { lastSeenAt: "desc" }, take: 5 });
    const queue = await queueDiagnostics(db, businessNow);
    const [unknown, deadDeliveries, pendingDeliveries, unpublished] = await Promise.all([
      db.executionAttempt.count({ where: { state: "UNKNOWN" } }),
      db.webhookDelivery.count({ where: { state: "DEAD" } }),
      // FAILED = an attempt failed and the next one is scheduled.
      db.webhookDelivery.count({ where: { state: { in: ["PENDING", "FAILED"] } } }),
      db.outboxEvent.count({ where: { publishedAt: null } }),
    ]);

    const latest = workers[0];
    const ageSeconds = latest ? Math.round((wallNow.getTime() - latest.lastSeenAt.getTime()) / 1000) : null;
    const alive = ageSeconds !== null && ageSeconds <= HEALTHY_SECONDS;

    console.log(`Worker        ${alive ? "ALIVE" : "NOT RUNNING"}${latest ? ` — last heartbeat ${ageSeconds}s ago (pid ${latest.pid}, started ${latest.startedAt.toISOString()}, ${latest.jobsProcessed} jobs processed)` : " — no worker has ever reported"}`);
    for (const other of workers.slice(1)) console.log(`              earlier worker pid ${other.pid}: last heartbeat ${other.lastSeenAt.toISOString()}`);
    console.log(`Queue         ${queue.pending} pending, ${queue.running} running, ${queue.dead} dead-lettered; oldest due job waiting ${queue.oldestPendingAgeSeconds ?? 0}s`);
    console.log(`Executions    ${unknown} with an unknown outcome (resolve by inquiry in Bank → Operations; never a blind retry)`);
    console.log(`Events        ${unpublished} not yet published; webhook deliveries: ${pendingDeliveries} waiting, ${deadDeliveries} given up`);
    console.log(`Clocks        wall ${wallNow.toISOString()} · sandbox business ${businessNow.toISOString()}`);
    if (!alive) console.log("\nStart the worker in its own terminal: `pnpm worker:start` (compiled) or `pnpm worker:dev`.");
    if (queue.dead > 0) console.log("\nDead-lettered jobs need attention: see Bank → Operations.");
    process.exitCode = alive && queue.dead === 0 ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Names only: never a connection string or a stack trace with credentials.
  console.error(`worker:status failed — ${error instanceof Error ? error.name : "error"}: check DATABASE_URL and that migrations are applied.`);
  process.exit(1);
});
