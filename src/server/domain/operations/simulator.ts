/**
 * Sandbox simulator controls (COR-004, PAY-03). These switch the SIMULATED core and rails and
 * move the SANDBOX clock so cut-off, scheduling, outage and recovery behaviour can be shown
 * without waiting for real time. They are fixture controls, reachable only with the bank
 * simulator permission, always audited, and they never write to a ledger or a balance.
 * The clock and the availability switches are sandbox-wide; faults and reconciliation
 * overlays are limited to the caller's own bank.
 */
import { z } from "zod";
import { safeText } from "@/contracts/common";
import { notFound } from "@/contracts/errors";
import { minorStringSchema } from "@/contracts/agreement";
import { SIM_KEYS, addFault, isCoreOffline, isRailOffline, readClockOffsetMs, resetSandboxClockCache, writeSetting } from "@/server/adapters/core/simulator-state";
import { writeAudit } from "@/server/audit/audit";
import { requireBank, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { dbDateToLocalDate, localDateToDbDate } from "@/server/calendar";
import { inTx } from "@/server/db/client";
import type { Deps } from "@/server/deps";

const MAX_ADVANCE_MINUTES = 60 * 24 * 60;

export const clockSchema = z.strictObject({ advanceMinutes: z.int().min(1).max(MAX_ADVANCE_MINUTES), reason: safeText(3, 200) });
export const availabilitySchema = z.strictObject({ target: z.enum(["CORE", "LYPAY", "ACH"]), offline: z.boolean(), reason: safeText(3, 200) });
export const faultSchema = z.strictObject({
  executionReference: z.string().trim().regex(/^AQ[0-9A-F]{32}A\d{1,2}$/, "use an execution reference"),
  fault: z.enum(["TIMEOUT_BEFORE_PROCESSING", "TIMEOUT_AFTER_BOOKING", "REJECT"]),
  uses: z.int().min(1).max(5).default(1),
  reason: safeText(3, 200),
});
export const overlaySchema = z
  .strictObject({
    businessDate: z.iso.date(),
    executionReference: z.string().trim().min(4).max(64),
    kind: z.enum(["HIDE", "DUPLICATE", "AMOUNT_OVERRIDE"]),
    amountMinor: minorStringSchema.optional(),
    reason: safeText(3, 200),
  })
  .refine((value) => (value.kind === "AMOUNT_OVERRIDE") === (value.amountMinor !== undefined), { message: "an amount is needed for AMOUNT_OVERRIDE only", path: ["amountMinor"] });

function simulatorContext(ctx: AuthContext) {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.simulator.control");
  return { bankCtx, person: requirePerson(bankCtx) };
}

export type SimulatorState = {
  clock: { now: string; offsetMinutes: number; timeZone: string };
  availability: Array<{ target: "CORE" | "LYPAY" | "ACH"; offline: boolean }>;
  faults: Array<{ id: string; executionReference: string; fault: string; remainingUses: number | null; note: string | null; createdAt: string }>;
  overlays: Array<{ id: string; businessDate: string; executionReference: string; kind: string; amountMinor: string | null; createdAt: string }>;
};

export async function getSimulatorState(deps: Deps, ctx: AuthContext): Promise<SimulatorState> {
  const { bankCtx } = simulatorContext(ctx);
  const offset = await readClockOffsetMs(deps.db);
  const faults = await deps.db.simFault.findMany({ where: { targetKind: "EXECUTION_REFERENCE" }, orderBy: { createdAt: "desc" }, take: 200 });
  // Only faults on this bank's own executions are shown.
  const own = await deps.db.executionAttempt.findMany({
    where: { bankId: bankCtx.bankId, executionReference: { in: faults.map((fault) => fault.targetValue) } },
    select: { executionReference: true },
  });
  const ownRefs = new Set(own.map((attempt) => attempt.executionReference));
  const overlays = await deps.db.simReconOverlay.findMany({ where: { bankCode: bankCtx.bankCode }, orderBy: { createdAt: "desc" }, take: 200 });
  return {
    clock: { now: new Date(Date.now() + offset).toISOString(), offsetMinutes: Math.round(offset / 60_000), timeZone: deps.timeZone },
    availability: [
      { target: "CORE", offline: await isCoreOffline(deps.db) },
      { target: "LYPAY", offline: await isRailOffline(deps.db, "LYPAY") },
      { target: "ACH", offline: await isRailOffline(deps.db, "ACH") },
    ],
    faults: faults
      .filter((fault) => ownRefs.has(fault.targetValue))
      .map((fault) => ({ id: fault.id, executionReference: fault.targetValue, fault: fault.fault, remainingUses: fault.remainingUses, note: fault.note, createdAt: fault.createdAt.toISOString() })),
    overlays: overlays.map((overlay) => ({
      id: overlay.id,
      businessDate: dbDateToLocalDate(overlay.businessDate),
      executionReference: overlay.executionReference,
      kind: overlay.kind,
      amountMinor: overlay.amountMinor?.toString() ?? null,
      createdAt: overlay.createdAt.toISOString(),
    })),
  };
}

/** Move the sandbox clock FORWARD. Time never goes back, so no business window is reopened. */
export async function advanceClock(deps: Deps, ctx: AuthContext, rawInput: unknown): Promise<void> {
  const { bankCtx } = simulatorContext(ctx);
  const input = clockSchema.parse(rawInput);
  const before = await readClockOffsetMs(deps.db);
  const after = before + input.advanceMinutes * 60_000;
  // The setting and its audit record commit together.
  await inTx(deps.db, async (tx) => {
    await writeSetting(tx, SIM_KEYS.clockOffsetMs, after);
    await writeAudit(tx, bankCtx, {
      action: "simulator.clock.advanced",
      targetType: "simulator",
      reason: input.reason,
      changes: { advanceMinutes: input.advanceMinutes, before: new Date(Date.now() + before).toISOString(), after: new Date(Date.now() + after).toISOString() },
    });
  });
  resetSandboxClockCache();
}

export async function setAvailability(deps: Deps, ctx: AuthContext, rawInput: unknown): Promise<void> {
  const { bankCtx } = simulatorContext(ctx);
  const input = availabilitySchema.parse(rawInput);
  await inTx(deps.db, async (tx) => {
    await writeSetting(tx, input.target === "CORE" ? SIM_KEYS.coreOffline : SIM_KEYS.railOffline(input.target), input.offline);
    await writeAudit(tx, bankCtx, { action: "simulator.availability.changed", targetType: "simulator", reason: input.reason, changes: { target: input.target, offline: input.offline } });
  });
}

/** Arm a one-off adapter fault for an execution of the caller's own bank. */
export async function armFault(deps: Deps, ctx: AuthContext, rawInput: unknown): Promise<void> {
  const { bankCtx, person } = simulatorContext(ctx);
  const input = faultSchema.parse(rawInput);
  const attempt = await deps.db.executionAttempt.findFirst({ where: { executionReference: input.executionReference, bankId: bankCtx.bankId }, select: { id: true, corporateId: true } });
  if (!attempt) throw notFound();
  await inTx(deps.db, async (tx) => {
    await addFault(tx, { targetKind: "EXECUTION_REFERENCE", targetValue: input.executionReference, fault: input.fault, remainingUses: input.uses, note: input.reason, createdBy: person.personId });
    await writeAudit(tx, bankCtx, {
      action: "simulator.fault.armed",
      targetType: "executionAttempt",
      targetId: attempt.id,
      corporateId: attempt.corporateId,
      reason: input.reason,
      changes: { reference: input.executionReference, fault: input.fault, uses: input.uses },
    });
  });
}

export async function removeFault(deps: Deps, ctx: AuthContext, faultId: string): Promise<void> {
  const { bankCtx } = simulatorContext(ctx);
  const fault = await deps.db.simFault.findUnique({ where: { id: faultId } });
  const owned = fault ? await deps.db.executionAttempt.findFirst({ where: { executionReference: fault.targetValue, bankId: bankCtx.bankId }, select: { id: true } }) : null;
  if (!fault || !owned) throw notFound();
  await inTx(deps.db, async (tx) => {
    await tx.simFault.deleteMany({ where: { id: faultId } });
    await writeAudit(tx, bankCtx, { action: "simulator.fault.removed", targetType: "executionAttempt", targetId: owned.id, changes: { reference: fault.targetValue, fault: fault.fault } });
  });
}

/**
 * Make the core's reconciliation EXTRACT differ from its ledger for one reference, to
 * demonstrate break detection. The ledger itself is untouched.
 */
export async function addReconOverlay(deps: Deps, ctx: AuthContext, rawInput: unknown): Promise<void> {
  const { bankCtx } = simulatorContext(ctx);
  const input = overlaySchema.parse(rawInput);
  await inTx(deps.db, async (tx) => {
    await tx.simReconOverlay.create({
      data: {
        bankCode: bankCtx.bankCode,
        businessDate: localDateToDbDate(input.businessDate),
        executionReference: input.executionReference,
        kind: input.kind,
        amountMinor: input.amountMinor ? BigInt(input.amountMinor) : null,
      },
    });
    await writeAudit(tx, bankCtx, {
      action: "simulator.recon.overlay.added",
      targetType: "simulator",
      reason: input.reason,
      changes: { businessDate: input.businessDate, reference: input.executionReference, kind: input.kind },
    });
  });
}

export async function removeReconOverlay(deps: Deps, ctx: AuthContext, overlayId: string): Promise<void> {
  const { bankCtx } = simulatorContext(ctx);
  await inTx(deps.db, async (tx) => {
    const removed = await tx.simReconOverlay.deleteMany({ where: { id: overlayId, bankCode: bankCtx.bankCode } });
    if (removed.count !== 1) throw notFound();
    await writeAudit(tx, bankCtx, { action: "simulator.recon.overlay.removed", targetType: "simulator", changes: { overlayId } });
  });
}
