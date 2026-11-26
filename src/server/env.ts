/**
 * Environment validation (document 11). Fails fast with NAMES ONLY — never values.
 * R1 supports exactly one mode (`sandbox`) and one core adapter (`simulated`).
 */
import { z } from "zod";

const schema = z.object({
  APP_MODE: z.string().default("sandbox"),
  CORE_ADAPTER: z.string().default("simulated"),
  BANK_TIMEZONE: z.string().default("Africa/Tripoli"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_BASE_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().optional(),
  AUTH_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY: z.string().min(1),
  STORAGE_PATH: z.string().default("./storage"),
  SEED_DEMO_ENABLED: z.string().default("false"),
  DEMO_PASSWORD: z.string().optional(),
  WEBHOOK_TEST_RECEIVER_ALLOWLIST: z.string().default(""),
  NODE_ENV: z.string().default("development"),
});

export type AppEnv = Readonly<{
  appMode: "sandbox";
  coreAdapter: "simulated";
  bankTimezone: string;
  logLevel: string;
  appBaseUrl: string;
  appOrigin: string;
  databaseUrl: string;
  migrationDatabaseUrl: string | undefined;
  authSecret: string;
  dataEncryptionKey: Buffer;
  storagePath: string;
  seedDemoEnabled: boolean;
  demoPassword: string | undefined;
  webhookTestReceiverAllowlist: readonly string[];
  isProductionBuild: boolean;
}>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

let cached: AppEnv | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new EnvError(`Missing or invalid environment variables: ${names.join(", ")}`);
  }
  const env = parsed.data;
  if (env.APP_MODE !== "sandbox") {
    throw new EnvError(
      "APP_MODE must be `sandbox`: bank-pilot and production modes are not available in this release",
    );
  }
  if (env.CORE_ADAPTER !== "simulated") {
    throw new EnvError("CORE_ADAPTER must be `simulated`: no real core adapter exists in this release");
  }
  if (env.AUTH_SECRET.startsWith("CHANGE_ME") || env.DATA_ENCRYPTION_KEY.startsWith("CHANGE_ME")) {
    throw new EnvError("AUTH_SECRET and DATA_ENCRYPTION_KEY must be generated (run `pnpm setup:env`)");
  }
  const key = Buffer.from(env.DATA_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new EnvError("DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  }
  if (env.AUTH_SECRET === env.DATA_ENCRYPTION_KEY) {
    throw new EnvError("AUTH_SECRET and DATA_ENCRYPTION_KEY must be different secrets");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: env.BANK_TIMEZONE });
  } catch {
    throw new EnvError("BANK_TIMEZONE is not a valid IANA time zone");
  }
  const base = new URL(env.APP_BASE_URL);
  return Object.freeze({
    appMode: "sandbox",
    coreAdapter: "simulated",
    bankTimezone: env.BANK_TIMEZONE,
    logLevel: env.LOG_LEVEL,
    appBaseUrl: base.toString().replace(/\/$/, ""),
    appOrigin: base.origin,
    databaseUrl: env.DATABASE_URL,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL,
    authSecret: env.AUTH_SECRET,
    dataEncryptionKey: key,
    storagePath: env.STORAGE_PATH,
    seedDemoEnabled: env.SEED_DEMO_ENABLED === "true",
    demoPassword: env.DEMO_PASSWORD && !env.DEMO_PASSWORD.startsWith("CHANGE_ME") ? env.DEMO_PASSWORD : undefined,
    webhookTestReceiverAllowlist: env.WEBHOOK_TEST_RECEIVER_ALLOWLIST.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    isProductionBuild: env.NODE_ENV === "production",
  });
}

export function getEnv(): AppEnv {
  cached ??= loadEnv();
  return cached;
}

/** Test hook: discard the cached environment after changing process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
