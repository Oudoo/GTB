import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "dist/**",
    "node_modules/**",
    "src/generated/**",
    "public/sw.js",
    "playwright-report/**",
    "test-results/**",
    "artifacts/**",
    "storage/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // No escape hatches around the type system or money precision.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: "Money is integer minor units (bigint). Never parse amounts as floating point.",
        },
        {
          selector: "CallExpression[callee.name='Number'][arguments.0.type='Identifier'][arguments.0.name=/[Mm]inor$/]",
          message: "Do not convert minor-unit bigint values to Number.",
        },
      ],
    },
  },
  {
    // Client-side code may never reach server modules, the database client or secrets.
    files: ["src/components/**/*.{ts,tsx}", "src/features/**/client/**/*.{ts,tsx}", "src/pwa/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/server/*", "@/server/**", "@/generated/**"], message: "Server-only module in client code." },
          ],
        },
      ],
    },
  },
]);
