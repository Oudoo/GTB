import { defineConfig } from "@playwright/test";
import type { AppOptions } from "./tests/e2e/support/fixtures.ts";

/**
 * End-to-end journeys (document 07, E-01..E-12 and the browser-emulated parts of P-01..P-12).
 *
 * They run against the PRODUCTION build (`pnpm build` first) with a separately started worker
 * process and a dedicated PostgreSQL database that `tests/e2e/support/global-setup.ts` rebuilds
 * for every run. Nothing here is a physical-device result: phone projects are Chromium
 * emulation and are recorded as such.
 */
export const E2E_PORT = Number(process.env["E2E_PORT"] ?? 3100);
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

export default defineConfig<AppOptions>({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  // Journeys share one database and one worker: run them in a fixed order, one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: true,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  globalSetup: "./tests/e2e/support/global-setup.ts",
  outputDir: "test-results/e2e",
  use: {
    baseURL: E2E_ORIGIN,
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    // The service worker is exercised explicitly by the PWA specs.
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop-en", use: { viewport: { width: 1366, height: 900 }, appLocale: "en" } },
    {
      name: "phone-ar",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        appLocale: "ar",
      },
    },
  ],
});
