import { defineConfig } from "vitest/config";
import { sharedResolve } from "./vitest.shared";

// Adapter contract tests (CoreBankingPort / PaymentRailPort against the simulated
// implementations on real PostgreSQL) and API/OpenAPI parity tests.
export default defineConfig({
  resolve: sharedResolve,
  test: {
    name: "contract",
    environment: "node",
    include: ["tests/contract/**/*.test.ts"],
    globalSetup: ["tests/integration/support/global-setup.ts"],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 2,
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: { junit: "artifacts/junit-contract.xml" },
  },
});
