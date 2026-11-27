/**
 * `pnpm db:migrate` — apply reviewed migrations with the schema-owner connection, then grant
 * the least-privilege runtime role. Never uses `db push` and never resets data.
 */
import { migrateAndGrant } from "../src/server/db/provision";

async function main(): Promise<void> {
  const runtimeUrl = process.env["DATABASE_URL"];
  const migrationUrl = process.env["MIGRATION_DATABASE_URL"] ?? runtimeUrl;
  if (!runtimeUrl || !migrationUrl) {
    console.error("DATABASE_URL (and preferably MIGRATION_DATABASE_URL) must be set. Run `pnpm setup:env`.");
    process.exit(1);
  }
  await migrateAndGrant({ migrationUrl, runtimeUrl });
  console.log("Migrations applied, runtime grants set, module registry verified (33 modules).");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exit(1);
});
