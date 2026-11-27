/**
 * Integration/contract test bootstrap. REAL PostgreSQL is mandatory: if the server is not
 * reachable or migrations fail, this throws and the whole run fails — nothing is skipped and
 * nothing falls back to SQLite or an in-memory fake (document 07).
 *
 * It builds one migrated + seeded TEMPLATE database with separate owner and runtime roles;
 * each test world is then a cheap `CREATE DATABASE … TEMPLATE …` copy, so every test file (or
 * test) starts from identical, isolated state.
 */
import { existsSync } from "node:fs";
import pg from "pg";

const TEST_PASSWORD = "Synthetic-Test-Password-01";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const ownerUrl = process.env["TEST_MIGRATION_DATABASE_URL"] ?? process.env["MIGRATION_DATABASE_URL"];
  const runtimeUrl = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!ownerUrl || !runtimeUrl) {
    throw new Error("Integration tests need MIGRATION_DATABASE_URL and DATABASE_URL (run `pnpm setup:env` and `pnpm db:local`).");
  }

  const runId = `${process.pid.toString(36)}${Date.now().toString(36)}`;
  const template = `alqarib_test_tpl_${runId}`;
  const prefix = `alqarib_test_${runId}_`;
  const adminUrl = withDatabase(ownerUrl, "postgres");

  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `PostgreSQL is not reachable for integration tests (${(error as Error).name}). These tests are required and are never skipped.`,
    );
  }
  await admin.query(`CREATE DATABASE "${template}"`);
  await admin.end();

  // Test processes use deterministic synthetic configuration only.
  process.env["APP_MODE"] = "sandbox";
  process.env["CORE_ADAPTER"] = "simulated";
  process.env["APP_BASE_URL"] = "http://localhost:3000";
  process.env["BANK_TIMEZONE"] = "Africa/Tripoli";
  process.env["LOG_LEVEL"] = process.env["TEST_LOG_LEVEL"] ?? "silent";
  process.env["AUTH_SECRET"] = "integration-test-auth-secret-0123456789abcdef0123456789";
  process.env["DATA_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["SEED_DEMO_ENABLED"] = "true";
  process.env["DEMO_PASSWORD"] = TEST_PASSWORD;
  process.env["TEST_OWNER_URL"] = ownerUrl;
  process.env["TEST_RUNTIME_URL"] = runtimeUrl;
  process.env["TEST_TEMPLATE_DB"] = template;
  process.env["TEST_DB_PREFIX"] = prefix;
  process.env["DATABASE_URL"] = withDatabase(runtimeUrl, template);
  process.env["MIGRATION_DATABASE_URL"] = withDatabase(ownerUrl, template);

  const { migrateAndGrant } = await import("@/server/db/provision");
  await migrateAndGrant({ migrationUrl: withDatabase(ownerUrl, template), runtimeUrl: withDatabase(runtimeUrl, template) });

  // Seed through the runtime role, exactly as `pnpm db:seed` does, at the fixture instant.
  const { createDb } = await import("@/server/db/client");
  const { makeDeps } = await import("@/server/deps");
  const { ManualClock } = await import("@/server/clock");
  const { seedDemo } = await import("@/server/seed/demo");
  const { TEST_NOW } = await import("@/server/seed/fixtures");
  const db = createDb(withDatabase(runtimeUrl, template), { poolSize: 4 });
  try {
    const deps = makeDeps({ db, clock: new ManualClock(TEST_NOW), timeZone: "Africa/Tripoli", storagePath: "./storage/test", appOrigin: "http://localhost:3000" });
    await seedDemo(deps, { password: TEST_PASSWORD });
  } finally {
    await db.$disconnect();
  }

  return async () => {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      const { rows } = await cleanup.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2",
        [template, `${prefix}%`],
      );
      for (const row of rows) {
        await cleanup.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
      }
    } finally {
      await cleanup.end();
    }
  };
}
