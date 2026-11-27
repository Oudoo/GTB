import { defineConfig } from "vitest/config";
import { sharedResolve } from "./vitest.shared.ts";

// Integration tests run against REAL PostgreSQL. The global setup provisions a migrated,
// seeded template database and fails the whole run if PostgreSQL is unavailable — these tests
// are never silently skipped (document 07).
export default defineConfig({
  resolve: sharedResolve,
  test: {
    name: "integration",
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/support/global-setup.ts"],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 4,
    fileParallelism: true,
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: { junit: "artifacts/junit-integration.xml" },
  },
});
