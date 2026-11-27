import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env automatically. Load it here (if present) so the CLI
// works on a developer machine; CI and deployments pass variables explicitly.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

// Migrations run with the schema-owner connection; the application and worker use the
// least-privilege DATABASE_URL (document 11). `prisma generate` needs no database at all,
// so a missing URL must not break a fresh `pnpm install`.
const migrationUrl =
  process.env["MIGRATION_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgresql://unset:unset@127.0.0.1:5432/unset";

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: migrationUrl,
    ...(process.env["SHADOW_DATABASE_URL"]
      ? { shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"] }
      : {}),
  },
});
