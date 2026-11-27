/**
 * Service container. Domain services receive their collaborators explicitly so the same code
 * runs in the Next.js app, the worker and tests (with a manual clock and a test database).
 */
import type { CoreBankingPort } from "@/server/adapters/core/port";
import { SimulatedCore } from "@/server/adapters/core/simulated-core";
import { loadSandboxClock } from "@/server/adapters/core/simulator-state";
import type { PaymentRailPort } from "@/server/adapters/rails/port";
import { SimulatedRail } from "@/server/adapters/rails/simulated-rail";
import type { Clock } from "@/server/clock";
import { getDb, type Db } from "@/server/db/client";
import { getEnv } from "@/server/env";

export type RuntimeSettings = Readonly<{
  /** Delay before the worker's first automatic inquiry of an unknown outcome. */
  autoInquiryDelaySeconds: number;
  /** Automatic inquiries before the item is left for operations (never a blind retry). */
  autoInquiryMaxAttempts: number;
  /** How long a pending proposal can wait for votes before it expires. */
  approvalValidityDays: number;
  /** Poll interval for rail settlement checks. */
  settlementPollSeconds: number;
  /** Bounded concurrency for per-row adapter calls (document 03: default 5). */
  rowConcurrency: number;
}>;

export const DEFAULT_SETTINGS: RuntimeSettings = Object.freeze({
  autoInquiryDelaySeconds: 60,
  autoInquiryMaxAttempts: 5,
  approvalValidityDays: 7,
  settlementPollSeconds: 5,
  rowConcurrency: 5,
});

export type Deps = Readonly<{
  db: Db;
  clock: Clock;
  core: CoreBankingPort;
  rail: PaymentRailPort;
  /** Bank business time zone (R1: one zone per deployment, Africa/Tripoli in the sandbox). */
  timeZone: string;
  storagePath: string;
  appOrigin: string;
  settings: RuntimeSettings;
}>;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function settingsFromEnv(): RuntimeSettings {
  return {
    autoInquiryDelaySeconds: intFromEnv("AUTO_INQUIRY_DELAY_SECONDS", DEFAULT_SETTINGS.autoInquiryDelaySeconds),
    autoInquiryMaxAttempts: intFromEnv("AUTO_INQUIRY_MAX_ATTEMPTS", DEFAULT_SETTINGS.autoInquiryMaxAttempts),
    approvalValidityDays: intFromEnv("APPROVAL_VALIDITY_DAYS", DEFAULT_SETTINGS.approvalValidityDays),
    settlementPollSeconds: intFromEnv("SETTLEMENT_POLL_SECONDS", DEFAULT_SETTINGS.settlementPollSeconds),
    rowConcurrency: Math.max(1, intFromEnv("ROW_CONCURRENCY", DEFAULT_SETTINGS.rowConcurrency)),
  };
}

/** Build a container from explicit parts (tests, scripts). */
export function makeDeps(parts: {
  db: Db;
  clock: Clock;
  timeZone: string;
  storagePath: string;
  appOrigin: string;
  settings?: Partial<RuntimeSettings>;
  core?: CoreBankingPort;
  rail?: PaymentRailPort;
}): Deps {
  return Object.freeze({
    db: parts.db,
    clock: parts.clock,
    core: parts.core ?? new SimulatedCore(parts.db, parts.clock, parts.timeZone),
    rail: parts.rail ?? new SimulatedRail(parts.db, parts.clock),
    timeZone: parts.timeZone,
    storagePath: parts.storagePath,
    appOrigin: parts.appOrigin,
    settings: { ...DEFAULT_SETTINGS, ...parts.settings },
  });
}

/**
 * Container for the running app/worker. The clock is re-read (at most once per second) so a
 * sandbox clock shift made by an operator is seen by every process.
 */
export async function getDeps(): Promise<Deps> {
  const env = getEnv();
  const db = getDb(env.databaseUrl);
  const clock = await loadSandboxClock(db);
  return makeDeps({
    db,
    clock,
    timeZone: env.bankTimezone,
    storagePath: env.storagePath,
    appOrigin: env.appOrigin,
    settings: settingsFromEnv(),
  });
}
