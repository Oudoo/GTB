import { EXPECTED_MIGRATION } from "@/server/db/migrations";
import { query, type AnyOperation } from "../framework";

export const healthOperations: AnyOperation[] = [
  query({
    id: "healthLive",
    method: "GET",
    path: "/health/live",
    summary: "Process liveness",
    tag: "Health",
    scope: "public",
    handler: async () => ({ data: { status: "ok" } }),
  }),

  query({
    id: "healthReady",
    method: "GET",
    path: "/health/ready",
    summary: "Readiness: database, migration level and adapter mode",
    description: "Minimal public response. Never exposes credentials, topology or error traces.",
    tag: "Health",
    scope: "public",
    handler: async ({ deps }) => {
      let database = false;
      let migrations = false;
      try {
        const rows = await deps.db.$queryRaw<Array<{ migration_name: string }>>`
          SELECT "migration_name" FROM "_prisma_migrations"
           WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
           ORDER BY "migration_name" DESC LIMIT 1`;
        database = true;
        migrations = rows[0]?.migration_name === EXPECTED_MIGRATION;
      } catch {
        database = false;
      }
      const ready = database && migrations;
      return {
        status: ready ? 200 : 503,
        data: {
          status: ready ? "ready" : "not_ready",
          mode: "sandbox",
          coreAdapter: "simulated",
          checks: { database, migrations },
        },
      };
    },
  }),
];
