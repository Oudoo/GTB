/**
 * The build's expected migration level must be the newest reviewed migration folder, so a new
 * migration cannot be added without readiness and the worker noticing (document 11).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_MIGRATION } from "@/server/db/migrations";

const dir = join(process.cwd(), "prisma/migrations");
const folders = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("migrations", () => {
  it("EXPECTED_MIGRATION is the newest migration folder", () => {
    expect(folders.length).toBeGreaterThan(0);
    expect(EXPECTED_MIGRATION).toBe(folders[folders.length - 1]);
  });

  it("every migration is a reviewed SQL file with a sortable timestamp name", () => {
    for (const folder of folders) {
      expect(folder).toMatch(/^\d{14}_[a-z0-9_]+$/);
      const sql = readFileSync(join(dir, folder, "migration.sql"), "utf8");
      expect(sql.trim().length).toBeGreaterThan(0);
      // Destructive statements never appear in a forward migration of this project. (A
      // trigger that fires "BEFORE … OR TRUNCATE" to PREVENT truncation is not a statement.)
      expect(sql).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i);
      expect(sql).not.toMatch(/(^|;)\s*TRUNCATE\b/im);
    }
  });
});
