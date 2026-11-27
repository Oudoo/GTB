/**
 * `pnpm db:reset-demo -- --yes` — drop and rebuild the LOCAL sandbox database, then migrate and
 * seed the synthetic demo data. Destructive by design, so it is fenced:
 *
 *   - only with APP_MODE=sandbox and SEED_DEMO_ENABLED=true;
 *   - only for a database on localhost whose name ends in `_dev`, `_demo` or `_test`;
 *   - only with the explicit `--yes` flag.
 *
 * It never touches another database and is not part of any automated start-up path.
 *
 * `--clock=<ISO instant>` starts the SANDBOX clock at that instant (stored as an offset from
 * real time) before seeding, so cut-off and calendar behaviour is reproducible in tests.
 */
import pg from "pg";
import { SIM_KEYS, resetSandboxClockCache, writeSetting } from "../src/server/adapters/core/simulator-state";
import { getDb } from "../src/server/db/client";
import { migrateAndGrant } from "../src/server/db/provision";
import { getDeps } from "../src/server/deps";
import { getEnv } from "../src/server/env";
import { seedDemo } from "../src/server/seed/demo";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = getEnv();
  if (!process.argv.includes("--yes")) fail("Refusing to reset without --yes. This DROPS the local sandbox database.");
  if (!env.seedDemoEnabled) fail("Refusing to reset: SEED_DEMO_ENABLED must be true (sandbox only).");
  if (!env.demoPassword || env.demoPassword.length < 12) fail("Refusing to reset: DEMO_PASSWORD must be set. Run `pnpm setup:env`.");
  const migrationUrl = env.migrationDatabaseUrl;
  if (!migrationUrl) fail("MIGRATION_DATABASE_URL must be set to reset the database.");

  const target = new URL(migrationUrl);
  const database = decodeURIComponent(target.pathname.slice(1));
  const runtimeDatabase = decodeURIComponent(new URL(env.databaseUrl).pathname.slice(1));
  if (!["127.0.0.1", "localhost", "::1", "db"].includes(target.hostname)) fail("Refusing to reset a database that is not local.");
  if (!/^[a-z0-9_]+_(dev|demo|test)$/.test(database)) fail("Refusing to reset: the database name must end in _dev, _demo or _test.");
  if (database !== runtimeDatabase) fail("Refusing to reset: DATABASE_URL and MIGRATION_DATABASE_URL name different databases.");

  const adminUrl = new URL(migrationUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database]);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
  console.log(`Database "${database}" recreated.`);

  await migrateAndGrant({ migrationUrl, runtimeUrl: env.databaseUrl });

  const clockArg = process.argv.find((arg) => arg.startsWith("--clock="))?.slice("--clock=".length);
  if (clockArg) {
    const start = new Date(clockArg).getTime();
    if (Number.isNaN(start)) fail("--clock must be an ISO-8601 instant, e.g. 2026-11-23T07:00:00.000Z");
    await writeSetting(getDb(env.databaseUrl), SIM_KEYS.clockOffsetMs, start - Date.now());
    resetSandboxClockCache();
    console.log(`Sandbox clock starts at ${new Date(start).toISOString()}.`);
  }

  const deps = await getDeps();
  const summary = await seedDemo(deps, { password: env.demoPassword as string });
  console.log(
    `Demo data ready: ${summary.peopleCreated} identities, ${summary.openingBalancesBooked} opening balances, Corporate B activated: ${summary.corporateBActivated}.`,
  );
  await getDb(env.databaseUrl).$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Reset failed");
  process.exit(1);
});
