/**
 * Starts the real stack for end-to-end tests:
 *   1. rebuilds a dedicated sandbox database (migrations + synthetic seed) with the sandbox
 *      clock starting at the documented fixture instant (Monday 09:00 Africa/Tripoli);
 *   2. starts the PRODUCTION Next.js server (`next start`) and the bundled worker as separate
 *      OS processes against that database;
 *   3. stops only the processes it started when the run ends.
 *
 * It refuses to run without a production build, so a stale or missing build cannot be mistaken
 * for a passing run.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_ORIGIN, E2E_PORT } from "../../../playwright.config.ts";
import { E2E_CLOCK_START, E2E_PASSWORD } from "./constants.ts";

const root = process.cwd();

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url} (${last})`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
  if (!existsSync(join(root, ".next/BUILD_ID")) || !existsSync(join(root, "dist/worker/index.mjs"))) {
    throw new Error("End-to-end tests need the production build. Run `pnpm build` first.");
  }
  const ownerUrl = process.env["MIGRATION_DATABASE_URL"];
  const runtimeUrl = process.env["DATABASE_URL"];
  if (!ownerUrl || !runtimeUrl) throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL must be set (run `pnpm setup:env` and `pnpm db:local`).");

  const database = "alqarib_e2e_test";
  const logDir = join(root, "test-results/e2e-logs");
  mkdirSync(logDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    APP_MODE: "sandbox",
    CORE_ADAPTER: "simulated",
    BANK_TIMEZONE: "Africa/Tripoli",
    LOG_LEVEL: "info",
    LOG_ERROR_FRAMES: "1",
    APP_BASE_URL: E2E_ORIGIN,
    PORT: String(E2E_PORT),
    DATABASE_URL: withDatabase(runtimeUrl, database),
    MIGRATION_DATABASE_URL: withDatabase(ownerUrl, database),
    SEED_DEMO_ENABLED: "true",
    DEMO_PASSWORD: E2E_PASSWORD,
    STORAGE_PATH: join(root, "storage/e2e"),
    NEXT_TELEMETRY_DISABLED: "1",
    // Short simulator timings so recovery journeys finish in seconds, not minutes.
    AUTO_INQUIRY_DELAY_SECONDS: "3",
    SETTLEMENT_POLL_SECONDS: "1",
    WORKER_POLL_MS: "200",
    WORKER_MAINTENANCE_MS: "2000",
  };

  const reset = spawnSync(
    "pnpm",
    ["exec", "tsx", "--conditions=react-server", "scripts/db-reset-demo.ts", "--yes", `--clock=${E2E_CLOCK_START}`],
    { cwd: root, env, encoding: "utf8" },
  );
  writeFileSync(join(logDir, "reset.log"), `${reset.stdout ?? ""}\n${reset.stderr ?? ""}`);
  if (reset.status !== 0) throw new Error(`Could not prepare the end-to-end database. See test-results/e2e-logs/reset.log`);

  const started: ChildProcess[] = [];
  const start = (name: string, command: string, args: string[]) => {
    const out = openSync(join(logDir, `${name}.log`), "w");
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", out, out], detached: true });
    started.push(child);
    return child;
  };
  const app = start("app", join(root, "node_modules/.bin/next"), ["start", "-p", String(E2E_PORT)]);
  const worker = start("worker", process.execPath, ["dist/worker/index.mjs"]);
  let stopping = false;
  const failEarly = (name: string) => (code: number | null) => {
    if (!stopping && code !== null && code !== 0) console.error(`[e2e] ${name} exited early with code ${code}. See test-results/e2e-logs/${name}.log`);
  };
  app.once("exit", failEarly("app"));
  worker.once("exit", failEarly("worker"));

  const stop = async () => {
    stopping = true;
    for (const child of started) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      try {
        // Negative pid: the whole process group this setup created, and nothing else.
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  };

  try {
    await waitFor(`${E2E_ORIGIN}/api/v1/health/ready`, 60_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}
