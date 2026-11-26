import { defineConfig } from "vitest/config";
import { sharedResolve } from "./vitest.shared";

// Pure unit and property tests: no database, no network.
export default defineConfig({
  resolve: sharedResolve,
  test: {
    name: "unit",
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    passWithNoTests: false,
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: { junit: "artifacts/junit-unit.xml" },
  },
});
