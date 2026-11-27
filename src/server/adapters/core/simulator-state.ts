/**
 * Sandbox simulator state: availability switches, the shifted clock and explicit fault records.
 * These are fixture controls for the SIMULATED core and rails only. They are reachable solely
 * through the sandbox simulator service (bank operations permission) and test fixtures.
 */
import { OffsetClock, systemClock, type Clock } from "@/server/clock";
import type { Db, DbOrTx } from "@/server/db/client";

export const SIM_KEYS = {
  clockOffsetMs: "clock.offsetMs",
  coreOffline: "core.offline",
  railOffline: (rail: string) => `rail.${rail}.offline`,
} as const;

async function readSetting(db: DbOrTx, key: string): Promise<unknown> {
  const row = await db.simSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function writeSetting(db: DbOrTx, key: string, value: string | number | boolean): Promise<void> {
  await db.simSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export async function isCoreOffline(db: DbOrTx): Promise<boolean> {
  return (await readSetting(db, SIM_KEYS.coreOffline)) === true;
}

export async function isRailOffline(db: DbOrTx, rail: string): Promise<boolean> {
  return (await readSetting(db, SIM_KEYS.railOffline(rail))) === true;
}

export async function readClockOffsetMs(db: DbOrTx): Promise<number> {
  const value = await readSetting(db, SIM_KEYS.clockOffsetMs);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

let cachedClock: { at: number; clock: Clock } | undefined;

/**
 * The process clock: real time plus the sandbox offset (0 unless an operator shifted it).
 * The offset is re-read at most once per second so app and worker follow the same clock.
 */
export async function loadSandboxClock(db: Db): Promise<Clock> {
  const nowMs = Date.now();
  if (cachedClock && nowMs - cachedClock.at < 1_000) return cachedClock.clock;
  const offset = await readClockOffsetMs(db);
  const clock = offset === 0 ? systemClock : new OffsetClock(offset);
  cachedClock = { at: nowMs, clock };
  return clock;
}

export function resetSandboxClockCache(): void {
  cachedClock = undefined;
}

export type FaultName =
  | "TIMEOUT_BEFORE_PROCESSING"
  | "TIMEOUT_AFTER_BOOKING"
  | "REJECT"
  | "RAIL_TIMEOUT_AFTER_ACCEPT"
  | "RAIL_REJECT";

export type FaultTarget = "EXECUTION_REFERENCE" | "RAIL_INSTRUCTION";

export async function addFault(
  db: DbOrTx,
  fault: { targetKind: FaultTarget; targetValue: string; fault: FaultName; remainingUses?: number | null; note?: string; createdBy?: string },
): Promise<void> {
  await db.simFault.create({
    data: {
      targetKind: fault.targetKind,
      targetValue: fault.targetValue,
      fault: fault.fault,
      remainingUses: fault.remainingUses === undefined ? 1 : fault.remainingUses,
      note: fault.note ?? null,
      createdBy: fault.createdBy ?? null,
    },
  });
}

/**
 * Consume one matching fault, if any. One-shot faults are removed atomically so two concurrent
 * calls cannot both observe the same fault.
 */
export async function takeFault(
  db: Db,
  targetKind: FaultTarget,
  targetValue: string,
  accepted: readonly FaultName[],
): Promise<FaultName | null> {
  const candidates = await db.simFault.findMany({
    where: { targetKind, targetValue, fault: { in: [...accepted] } },
    orderBy: { createdAt: "asc" },
  });
  for (const candidate of candidates) {
    if (candidate.remainingUses === null) return candidate.fault as FaultName;
    if (candidate.remainingUses <= 1) {
      const removed = await db.simFault.deleteMany({ where: { id: candidate.id } });
      if (removed.count === 1) return candidate.fault as FaultName;
    } else {
      const updated = await db.simFault.updateMany({
        where: { id: candidate.id, remainingUses: candidate.remainingUses },
        data: { remainingUses: candidate.remainingUses - 1 },
      });
      if (updated.count === 1) return candidate.fault as FaultName;
    }
  }
  return null;
}
