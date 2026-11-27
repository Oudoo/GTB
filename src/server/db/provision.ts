/**
 * Schema provisioning shared by `pnpm db:migrate` and the integration-test harness:
 * reviewed migrations (never `db push`), then least-privilege grants for the runtime role.
 */
import { spawnSync } from "node:child_process";
import pg from "pg";
import { MODULE_REGISTRY } from "@/contracts/modules";

/** Tables the runtime role may only INSERT into and SELECT from (append-only). */
export const APPEND_ONLY_TABLES = [
  '"AuditEvent"',
  '"SecurityEvent"',
  '"TimelineEvent"',
  '"ApprovalVote"',
  '"PaymentRevision"',
  '"ReconciliationResolution"',
  '"DepositAllocation"',
  '"simcore"."SimCoreJournal"',
  '"simcore"."SimCoreEntry"',
] as const;

/**
 * Tables where the runtime role may DELETE: ephemeral or security state only. Financial and
 * governance records are never hard deleted, so every other table has no DELETE privilege.
 */
export const DELETABLE_TABLES = [
  '"AuthSession"',
  '"AuthVerification"',
  '"AuthRateLimit"',
  '"LoginThrottle"',
  '"AccountGrant"',
  '"IdempotencyRecord"',
  '"ApiQuotaWindow"',
  '"LocalInboxMessage"',
  '"WorkerHeartbeat"',
  '"simcore"."SimFault"',
  '"simcore"."SimReconOverlay"',
] as const;

export function roleFromUrl(url: string): string {
  const role = decodeURIComponent(new URL(url).username);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("Unsupported database role name");
  return role;
}

export function runMigrateDeploy(migrationUrl: string, cwd: string = process.cwd()): void {
  const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl },
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed with exit code ${result.status ?? "unknown"}`);
  }
}

/** Grant the runtime role exactly what the application needs; idempotent. */
export async function applyRuntimeGrants(migrationUrl: string, runtimeRole: string): Promise<void> {
  const ownerRole = roleFromUrl(migrationUrl);
  if (ownerRole === runtimeRole) {
    // Single-role setups (e.g. a throwaway container) still work; privilege separation is then
    // provided only by the triggers. Documented as not recommended.
    return;
  }
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const role = `"${runtimeRole}"`;
    await client.query("BEGIN");
    await client.query(`GRANT USAGE ON SCHEMA public, simcore TO ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA public, simcore FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public, simcore FROM ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public, simcore TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, simcore TO ${role}`);
    for (const table of APPEND_ONLY_TABLES) {
      await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM ${role}`);
    }
    for (const table of DELETABLE_TABLES) {
      await client.query(`GRANT DELETE ON ${table} TO ${role}`);
    }
    // Reference and migration metadata are read-only for the application.
    await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "ModuleDefinition" FROM ${role}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "_prisma_migrations" FROM ${role}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** The catalogue table must equal the code registry exactly (33 entries, each once). */
export async function assertModuleRegistry(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{
      catalogueId: string;
      deliveryStatus: string;
      name: string;
      r1TransactionTypes: string;
    }>(
      'SELECT "catalogueId", "deliveryStatus"::text AS "deliveryStatus", "name", "r1TransactionTypes"::text AS "r1TransactionTypes" FROM "ModuleDefinition" ORDER BY "sortOrder"',
    );
    const expected = MODULE_REGISTRY.map(
      (m) => `${m.catalogueId}|${m.deliveryStatus}|${m.name}|{${m.r1TransactionTypes.join(",")}}`,
    );
    const actual = rows.map((r) => `${r.catalogueId}|${r.deliveryStatus}|${r.name}|${r.r1TransactionTypes}`);
    if (expected.length !== 33 || JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("ModuleDefinition table does not match the 33-module code registry");
    }
  } finally {
    await client.end();
  }
}

export async function migrateAndGrant(options: {
  migrationUrl: string;
  runtimeUrl: string;
  cwd?: string;
}): Promise<void> {
  runMigrateDeploy(options.migrationUrl, options.cwd);
  await applyRuntimeGrants(options.migrationUrl, roleFromUrl(options.runtimeUrl));
  await assertModuleRegistry(options.migrationUrl);
}
