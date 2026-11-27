/**
 * The newest migration this build expects. Readiness reports "not ready" when the database is
 * behind or ahead. `tests/unit/migrations.test.ts` asserts this equals the newest folder in
 * `prisma/migrations`, so it cannot be forgotten when a migration is added.
 */
export const EXPECTED_MIGRATION = "20261126000200_module_registry";
