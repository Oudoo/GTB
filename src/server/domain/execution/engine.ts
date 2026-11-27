/**
 * Execution engine (PAY-04, LIM-03, document 03 "Execution transaction boundaries").
 *
 * One `BusinessInstruction` is one movement of money (a single payment, a bulk row, a salary
 * line). Each try is an `ExecutionAttempt` with a STABLE core execution reference used for
 * every retry and inquiry. The attempt is a resumable state machine:
 *
 *   INTENT ──hold──▶ HOLD_PLACED ──rail accept──▶ RAIL_SUBMITTED ──settled, core books──▶ BOOKED
 *      │                  │ (internal transfer books directly)        │
 *      └──────────────────┴──── definitive rejection ──▶ FAILED       └── lost response ──▶ UNKNOWN
 *
 * Rules that make it exactly-once:
 *  - No adapter call happens inside a platform transaction, and every adapter call is
 *    idempotent by its reference, so any step can be repeated after a crash.
 *  - Outcome transactions compare-and-set the attempt state; a second identical outcome is a
 *    no-op, so duplicate or out-of-order rail events cannot double book or move status back.
 *  - An ambiguous core response becomes UNKNOWN and is resolved ONLY by inquiry on the original
 *    reference. Nothing here ever retries a posting under a new reference.
 *  - Limit reservations are consumed once on confirmed booking, released once on a definitive
 *    pre-booking failure, and KEPT while the outcome is unknown.
 */
import type { CoreContext, CoreInstruction } from "@/server/adapters/core/port";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import type { RailEvent } from "@/server/adapters/rails/port";
import { addTimeline } from "@/server/audit/audit";
import { localDateToDbDate, type LocalDate } from "@/server/calendar";
import { inTx, type Tx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { enqueueJob } from "@/server/jobs/queue";
import { logInfo } from "@/server/logging";
import { settleReservations } from "@/server/policy/reservations";
import type { BusinessInstruction, ExecutionAttempt } from "@/generated/prisma/client";

export type InstructionChange = Readonly<{
  state: BusinessInstruction["state"];
  previous: BusinessInstruction["state"];
  failureCode: string | null;
  /** Core or rail reference relevant to this change. */
  reference: string | null;
  at: Date;
}>;

export type InstructionObserver = (tx: Tx, instruction: BusinessInstruction, change: InstructionChange, deps: Deps) => Promise<void>;

const observers = new Map<BusinessInstruction["kind"], InstructionObserver>();

/** The owner of an instruction kind mirrors state to its aggregate (payment, batch row). */
export function registerInstructionObserver(kind: BusinessInstruction["kind"], observer: InstructionObserver): void {
  observers.set(kind, observer);
}

export const JOB_ATTEMPT_ADVANCE = "attempt.advance";
export const JOB_ATTEMPT_INQUIRE = "attempt.inquire";
export const JOB_ATTEMPT_RETURN_CHECK = "attempt.return-check";

/** How long after settlement the engine checks once for a late rail return. */
export const RETURN_CHECK_DELAY_MS = 90_000;

export function executionReferenceFor(instructionId: string, attemptNo: number): string {
  return `AQ${instructionId.replaceAll("-", "").toUpperCase()}A${attemptNo}`;
}

async function bankCodeOf(deps: Deps, bankId: string): Promise<string> {
  const bank = await deps.db.bank.findUniqueOrThrow({ where: { id: bankId }, select: { code: true } });
  return bank.code;
}

async function coreContextFor(deps: Deps, instruction: BusinessInstruction): Promise<CoreContext> {
  const corporate = await deps.db.corporate.findUniqueOrThrow({
    where: { id: instruction.corporateId },
    select: { coreCustomerRef: true },
  });
  return {
    bankCode: await bankCodeOf(deps, instruction.bankId),
    // Second tenant check at the core: the debit account must belong to this corporate.
    ownerRef: corporate.coreCustomerRef,
    correlationId: instruction.correlationId,
  };
}

async function changeInstruction(
  tx: Tx,
  deps: Deps,
  instruction: BusinessInstruction,
  next: BusinessInstruction["state"],
  extra: { failureCode?: string | null; reference?: string | null; settledAt?: Date; returnedAt?: Date } = {},
): Promise<BusinessInstruction> {
  if (instruction.state === next) return instruction;
  const at = deps.clock.now();
  const updated = await tx.businessInstruction.update({
    where: { id: instruction.id },
    data: {
      state: next,
      failureCode: extra.failureCode === undefined ? instruction.failureCode : extra.failureCode,
      ...(extra.settledAt ? { settledAt: extra.settledAt } : {}),
      ...(extra.returnedAt ? { returnedAt: extra.returnedAt } : {}),
      version: { increment: 1 },
    },
  });
  await addTimeline(tx, {
    bankId: instruction.bankId,
    corporateId: instruction.corporateId,
    aggregateType: "instruction",
    aggregateId: instruction.id,
    code: `INSTRUCTION_${next}`,
    fromState: instruction.state,
    toState: next,
    actorService: "worker",
    reference: extra.reference ?? null,
    ...(extra.failureCode ? { detail: { failureCode: extra.failureCode } } : {}),
    at,
  });
  const observer = observers.get(instruction.kind);
  if (observer) {
    await observer(
      tx,
      updated,
      { state: next, previous: instruction.state, failureCode: updated.failureCode, reference: extra.reference ?? null, at },
      deps,
    );
  }
  return updated;
}

/**
 * Create the next attempt for a PENDING instruction and mark it PROCESSING. Must run in the
 * release transaction, after limits were reserved. The unique `activeKey` guarantees a single
 * live attempt per instruction even if two release jobs race.
 */
export async function startAttempt(tx: Tx, deps: Deps, instructionId: string, batchRowId: string | null = null): Promise<ExecutionAttempt> {
  const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: instructionId } });
  if (instruction.state !== "PENDING") throw new Error(`Instruction ${instructionId} is not pending`);
  const attemptNo = instruction.currentAttemptNo + 1;
  const reference = executionReferenceFor(instruction.id, attemptNo);
  const attempt = await tx.executionAttempt.create({
    data: {
      bankId: instruction.bankId,
      corporateId: instruction.corporateId,
      instructionId: instruction.id,
      attemptNo,
      executionReference: reference,
      holdReference: `${reference}H`,
      batchRowId,
      activeKey: instruction.id,
    },
  });
  const withAttempt = await tx.businessInstruction.update({ where: { id: instruction.id }, data: { currentAttemptNo: attemptNo } });
  await changeInstruction(tx, deps, withAttempt, "PROCESSING", { reference, failureCode: null });
  await enqueueJob(tx, {
    type: JOB_ATTEMPT_ADVANCE,
    payload: { attemptId: attempt.id },
    dedupKey: `attempt-advance:${attempt.id}`,
    bankId: instruction.bankId,
    corporateId: instruction.corporateId,
    aggregateType: "attempt",
    aggregateId: attempt.id,
    correlationId: instruction.correlationId,
  });
  return attempt;
}

export type AdvanceResult =
  | { kind: "done" }
  /** Nothing wrong: check again later (waiting for the rail). */
  | { kind: "poll"; at: Date }
  /** A temporary condition before anything was posted: try the same step again later. */
  | { kind: "retry"; at: Date; code: string };

type Loaded = { attempt: ExecutionAttempt; instruction: BusinessInstruction };

async function load(deps: Deps, attemptId: string): Promise<Loaded | null> {
  const attempt = await deps.db.executionAttempt.findUnique({ where: { id: attemptId }, include: { instruction: true } });
  if (!attempt) return null;
  const { instruction, ...rest } = attempt;
  return { attempt: rest as ExecutionAttempt, instruction };
}

/** Compare-and-set the attempt state inside an outcome transaction. Returns false if it moved. */
async function casAttempt(
  tx: Tx,
  attempt: ExecutionAttempt,
  from: ExecutionAttempt["state"][],
  data: Parameters<Tx["executionAttempt"]["updateMany"]>[0]["data"],
): Promise<boolean> {
  const result = await tx.executionAttempt.updateMany({
    where: { id: attempt.id, state: { in: from } },
    data: { ...data, version: { increment: 1 } },
  });
  return result.count === 1;
}

async function failDefinitively(deps: Deps, loaded: Loaded, code: string, reference: string | null): Promise<void> {
  // Release the core hold first (idempotent); only then record the definitive outcome.
  const context = await coreContextFor(deps, loaded.instruction);
  await deps.core.releaseReservation(context, loaded.attempt.holdReference);
  await inTx(deps.db, async (tx) => {
    const moved = await casAttempt(tx, loaded.attempt, ["INTENT", "HOLD_PLACED", "RAIL_SUBMITTED"], {
      state: "FAILED",
      failureCode: code,
      activeKey: null,
    });
    if (!moved) return;
    const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: loaded.instruction.id } });
    // Definitive failure before any booking: quota is released exactly once.
    await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
    await changeInstruction(tx, deps, instruction, "FAILED", { failureCode: code, reference });
  });
}

async function markUnknown(deps: Deps, loaded: Loaded, phase: "RAIL" | "BOOKING"): Promise<void> {
  await inTx(deps.db, async (tx) => {
    const moved = await casAttempt(tx, loaded.attempt, ["HOLD_PLACED", "RAIL_SUBMITTED"], { state: "UNKNOWN", unknownPhase: phase });
    if (!moved) return;
    const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: loaded.instruction.id } });
    // Reservation and hold are deliberately KEPT until an authoritative answer arrives.
    await changeInstruction(tx, deps, instruction, "STATUS_UNKNOWN", { reference: loaded.attempt.executionReference });
    await enqueueJob(tx, {
      type: JOB_ATTEMPT_INQUIRE,
      payload: { attemptId: loaded.attempt.id },
      dedupKey: `attempt-inquire:${loaded.attempt.id}`,
      availableAt: new Date(deps.clock.now().getTime() + deps.settings.autoInquiryDelaySeconds * 1000),
      maxAttempts: deps.settings.autoInquiryMaxAttempts,
      bankId: instruction.bankId,
      corporateId: instruction.corporateId,
      aggregateType: "attempt",
      aggregateId: loaded.attempt.id,
      correlationId: instruction.correlationId,
    });
  });
}

/** Record a confirmed booking. Idempotent: a second confirmation changes nothing. */
async function markBooked(
  deps: Deps,
  loaded: Loaded,
  booking: { coreReference: string; bookedAt: Date; businessDate: LocalDate },
  via: "EXECUTE" | "INQUIRY",
): Promise<void> {
  await inTx(deps.db, async (tx) => {
    const moved = await casAttempt(tx, loaded.attempt, ["HOLD_PLACED", "RAIL_SUBMITTED", "UNKNOWN"], {
      state: "BOOKED",
      coreReference: booking.coreReference,
      bookedAt: booking.bookedAt,
      bookedBusinessDate: localDateToDbDate(booking.businessDate),
      unknownPhase: null,
      failureCode: null,
    });
    if (!moved) return;
    const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: loaded.instruction.id } });
    // Reserved → consumed exactly once, in the same commit as the confirmed status.
    await settleReservations(tx, instruction.id, instruction.reservationCycle, "CONSUMED");
    await changeInstruction(tx, deps, instruction, "SETTLED", {
      reference: loaded.attempt.executionReference,
      settledAt: booking.bookedAt,
      failureCode: null,
    });
    if (instruction.rail !== "INTERNAL") {
      await enqueueJob(tx, {
        type: JOB_ATTEMPT_RETURN_CHECK,
        payload: { attemptId: loaded.attempt.id },
        dedupKey: `attempt-return:${loaded.attempt.id}`,
        availableAt: new Date(deps.clock.now().getTime() + RETURN_CHECK_DELAY_MS),
        maxAttempts: 3,
        bankId: instruction.bankId,
        corporateId: instruction.corporateId,
        aggregateType: "attempt",
        aggregateId: loaded.attempt.id,
        correlationId: instruction.correlationId,
      });
    }
  });
  logInfo("execution", "booking confirmed", { attemptId: loaded.attempt.id, reference: loaded.attempt.executionReference, via });
}

function coreInstructionFor(loaded: Loaded): CoreInstruction {
  const { attempt, instruction } = loaded;
  const base = {
    executionReference: attempt.executionReference,
    currency: instruction.currency,
    narrative: instruction.narrative,
    ...(instruction.groupRef ? { groupRef: instruction.groupRef } : {}),
  };
  if (instruction.rail === "INTERNAL") {
    return {
      ...base,
      type: "INTERNAL_TRANSFER",
      debitAccountRef: instruction.sourceCoreRef,
      creditAccountRef: instruction.destinationCoreRef as string,
      principalMinor: instruction.amountMinor,
      feeMinor: instruction.feeMinor,
      holdReference: attempt.holdReference,
    };
  }
  return {
    ...base,
    type: "EXTERNAL_TRANSFER",
    rail: instruction.rail === "ACH" ? "ACH" : "LYPAY",
    debitAccountRef: instruction.sourceCoreRef,
    principalMinor: instruction.amountMinor,
    feeMinor: instruction.feeMinor,
    holdReference: attempt.holdReference,
  };
}

async function book(deps: Deps, loaded: Loaded, context: CoreContext): Promise<AdvanceResult> {
  const result = await deps.core.execute(context, coreInstructionFor(loaded));
  if (result.kind === "confirmed") {
    await markBooked(deps, loaded, result, "EXECUTE");
    return { kind: "done" };
  }
  if (result.kind === "unknown") {
    await markUnknown(deps, loaded, "BOOKING");
    return { kind: "done" };
  }
  if (result.retryable) {
    // Core temporarily unavailable BEFORE posting: same reference again later is safe.
    return { kind: "retry", at: new Date(deps.clock.now().getTime() + 15_000), code: result.code };
  }
  if (loaded.attempt.state === "RAIL_SUBMITTED") {
    // The rail already took the instruction but the core refuses to book it. That is not a
    // clean failure: leave it for operations instead of guessing.
    await markUnknown(deps, loaded, "BOOKING");
    return { kind: "done" };
  }
  await failDefinitively(deps, loaded, result.code, loaded.attempt.executionReference);
  return { kind: "done" };
}

/** Apply one rail status event. Safe for duplicates and for events that arrive out of order. */
async function applyRailEvent(deps: Deps, attemptId: string, event: RailEvent, context: CoreContext): Promise<AdvanceResult | null> {
  const loaded = await load(deps, attemptId);
  if (!loaded) return { kind: "done" };
  const { attempt } = loaded;
  switch (event.type) {
    case "ACCEPTED":
      // Stale or repeated "accepted" can never move a later state backwards.
      return null;
    case "SETTLED":
      if (attempt.state === "RAIL_SUBMITTED") return book(deps, loaded, context);
      return null;
    case "REJECTED":
      if (attempt.state === "RAIL_SUBMITTED" || attempt.state === "HOLD_PLACED") {
        await failDefinitively(deps, loaded, event.code ?? "RAIL_REJECTED", attempt.railReference);
        return { kind: "done" };
      }
      return null;
    case "RETURNED":
      if (attempt.state === "BOOKED") await recordReturn(deps, loaded, context, event.code ?? "RETURNED");
      return null;
  }
}

/** A confirmed return: a linked compensating journal; the original posting is kept (PAY-04). */
async function recordReturn(deps: Deps, loaded: Loaded, context: CoreContext, code: string): Promise<void> {
  if (loaded.instruction.state === "RETURNED") return;
  const result = await deps.core.execute(context, {
    type: "RETURN",
    executionReference: `${loaded.attempt.executionReference}R`,
    originalExecutionReference: loaded.attempt.executionReference,
    currency: loaded.instruction.currency,
    narrative: `Return of ${loaded.instruction.narrative}`,
    ...(loaded.instruction.groupRef ? { groupRef: loaded.instruction.groupRef } : {}),
  });
  if (result.kind !== "confirmed") return; // retried by the return-check job
  await inTx(deps.db, async (tx) => {
    const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: loaded.instruction.id } });
    if (instruction.state !== "SETTLED") return;
    // Historic outgoing usage is NOT freed by a return (D11).
    await changeInstruction(tx, deps, instruction, "RETURNED", {
      failureCode: code,
      reference: `${loaded.attempt.executionReference}R`,
      returnedAt: result.bookedAt,
    });
  });
}

/**
 * Drive an attempt forward as far as it can go now. Safe to call repeatedly and concurrently;
 * this is what a restarted worker runs for a claim whose lease expired.
 */
export async function advanceAttempt(deps: Deps, attemptId: string): Promise<AdvanceResult> {
  let loaded = await load(deps, attemptId);
  if (!loaded) return { kind: "done" };
  const context = await coreContextFor(deps, loaded.instruction);
  const now = () => deps.clock.now();

  if (loaded.attempt.state === "INTENT") {
    let reservation;
    try {
      reservation = await deps.core.reserveDebit(context, {
        reference: loaded.attempt.holdReference,
        accountRef: loaded.instruction.sourceCoreRef,
        amountMinor: loaded.instruction.amountMinor + loaded.instruction.feeMinor,
        currency: loaded.instruction.currency,
      });
    } catch (error) {
      if (error instanceof CoreUnavailableError) return { kind: "retry", at: new Date(now().getTime() + 15_000), code: "CORE_UNAVAILABLE" };
      throw error;
    }
    if (reservation.kind === "rejected") {
      await failDefinitively(deps, loaded, reservation.code, null);
      return { kind: "done" };
    }
    await inTx(deps.db, async (tx) => {
      await casAttempt(tx, loaded!.attempt, ["INTENT"], { state: "HOLD_PLACED" });
    });
    loaded = (await load(deps, attemptId)) as Loaded;
  }

  if (loaded.attempt.state === "HOLD_PLACED") {
    if (loaded.instruction.rail === "INTERNAL") return book(deps, loaded, context);

    const submission = await deps.rail.submit(
      { bankCode: context.bankCode, correlationId: loaded.instruction.correlationId },
      {
        rail: loaded.instruction.rail === "ACH" ? "ACH" : "LYPAY",
        instructionReference: loaded.attempt.executionReference,
        amountMinor: loaded.instruction.amountMinor,
        currency: loaded.instruction.currency,
        destination: {
          scheme: loaded.instruction.destinationScheme as string,
          reference: loaded.instruction.destinationReference as string,
          name: loaded.instruction.destinationName ?? "",
        },
        settlementDelaySeconds: await settlementDelayFor(deps, loaded.instruction),
      },
    );
    if (submission.kind === "rejected") {
      if (submission.retryable) return { kind: "retry", at: new Date(now().getTime() + 20_000), code: submission.code };
      await failDefinitively(deps, loaded, submission.code, null);
      return { kind: "done" };
    }
    if (submission.kind === "unknown") {
      // The rail may hold the instruction. Ask it by OUR stable reference before anything else.
      const inquiry = await deps.rail.inquire({ bankCode: context.bankCode }, loaded.attempt.executionReference);
      if (inquiry.kind === "not_found") return { kind: "retry", at: new Date(now().getTime() + 20_000), code: "RAIL_RESPONSE_LOST" };
      await acceptRail(deps, loaded, inquiry.railReference);
    } else {
      await acceptRail(deps, loaded, submission.railReference);
    }
    loaded = (await load(deps, attemptId)) as Loaded;
  }

  if (loaded.attempt.state === "RAIL_SUBMITTED") {
    const inquiry = await deps.rail.inquire({ bankCode: context.bankCode }, loaded.attempt.executionReference);
    if (inquiry.kind === "not_found") return { kind: "retry", at: new Date(now().getTime() + 20_000), code: "RAIL_MESSAGE_NOT_FOUND" };
    // Replay the raw event stream: duplicates and stale events are harmless by construction.
    for (const event of inquiry.events) {
      const outcome = await applyRailEvent(deps, attemptId, event, context);
      if (outcome && outcome.kind !== "done") return outcome;
    }
    const after = (await load(deps, attemptId)) as Loaded;
    if (after.attempt.state === "RAIL_SUBMITTED") {
      // Accepted is not settled: keep the funds reserved and look again later.
      return { kind: "poll", at: new Date(now().getTime() + deps.settings.settlementPollSeconds * 1000) };
    }
  }
  return { kind: "done" };
}

async function settlementDelayFor(deps: Deps, instruction: BusinessInstruction): Promise<number> {
  const parameter = await deps.db.railParameter.findFirst({
    where: {
      bankId: instruction.bankId,
      rail: instruction.rail,
      currency: instruction.currency,
      status: { in: ["APPROVED", "EFFECTIVE"] },
      effectiveFrom: { lte: deps.clock.now() },
    },
    orderBy: [{ effectiveFrom: "desc" }, { versionNo: "desc" }],
    select: { settlementDelaySeconds: true },
  });
  return parameter?.settlementDelaySeconds ?? 0;
}

async function acceptRail(deps: Deps, loaded: Loaded, railReference: string): Promise<void> {
  await inTx(deps.db, async (tx) => {
    const moved = await casAttempt(tx, loaded.attempt, ["HOLD_PLACED"], { state: "RAIL_SUBMITTED", railReference });
    if (!moved) return;
    const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: loaded.instruction.id } });
    await changeInstruction(tx, deps, instruction, "SUBMITTED", { reference: railReference });
  });
}

export type InquiryOutcome = "BOOKED" | "NOT_FOUND" | "UNAVAILABLE" | "NOT_UNKNOWN";

/**
 * Authoritative inquiry for an unknown outcome, by the ORIGINAL execution reference.
 * Posted → the original booking is acknowledged (no second debit). Not found → the instruction
 * STAYS "result being checked"; only an approved repair proposal may act on it (DEC-012).
 */
export async function inquireAttempt(deps: Deps, attemptId: string, actor: { personId?: string; service?: string } = {}): Promise<InquiryOutcome> {
  const loaded = await load(deps, attemptId);
  if (!loaded) return "NOT_UNKNOWN";
  if (loaded.attempt.state !== "UNKNOWN") {
    // Not ambiguous: simply resume the normal state machine (safe by construction).
    await advanceAttempt(deps, attemptId);
    return "NOT_UNKNOWN";
  }
  const context = await coreContextFor(deps, loaded.instruction);
  let outcome: InquiryOutcome;
  let booking: { coreReference: string; bookedAt: Date; businessDate: LocalDate } | null = null;
  try {
    const result = await deps.core.inquire(context, loaded.attempt.executionReference);
    if (result.kind === "posted") {
      outcome = "BOOKED";
      booking = result;
    } else {
      outcome = "NOT_FOUND";
    }
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
    outcome = "UNAVAILABLE";
  }

  await inTx(deps.db, async (tx) => {
    await tx.executionAttempt.update({
      where: { id: attemptId },
      data: { inquiryCount: { increment: 1 }, lastInquiryAt: deps.clock.now(), lastInquiryResult: outcome },
    });
    // Every intervention is recorded, not only the successful one (OPS-01).
    await addTimeline(tx, {
      bankId: loaded.instruction.bankId,
      corporateId: loaded.instruction.corporateId,
      aggregateType: "instruction",
      aggregateId: loaded.instruction.id,
      code: `INQUIRY_${outcome}`,
      actorPersonId: actor.personId ?? null,
      actorService: actor.personId ? null : (actor.service ?? "worker"),
      reference: loaded.attempt.executionReference,
    });
  });
  if (booking) await markBooked(deps, loaded, booking, "INQUIRY");
  return outcome;
}

/** One-off check for a late return after settlement (and whenever operations asks). */
export async function checkForReturn(deps: Deps, attemptId: string): Promise<void> {
  const loaded = await load(deps, attemptId);
  if (!loaded || loaded.attempt.state !== "BOOKED" || loaded.instruction.rail === "INTERNAL") return;
  const context = await coreContextFor(deps, loaded.instruction);
  const inquiry = await deps.rail.inquire({ bankCode: context.bankCode }, loaded.attempt.executionReference);
  if (inquiry.kind === "found" && inquiry.status === "RETURNED") {
    await recordReturn(deps, loaded, context, inquiry.events.find((event) => event.type === "RETURNED")?.code ?? "RETURNED");
  }
}

// ---- approved operations repairs (OPS-01, DEC-012) -----------------------------------------

/**
 * Approved repair: resubmit with the SAME reference. Inquires first; if the core has the
 * posting it is acknowledged, otherwise the original instruction is sent again under its
 * original reference (the core's idempotency makes a late original harmless).
 */
export async function resubmitSameReference(deps: Deps, attemptId: string, actorPersonId: string): Promise<InquiryOutcome | "RESUBMITTED"> {
  const first = await inquireAttempt(deps, attemptId, { personId: actorPersonId });
  if (first !== "NOT_FOUND") return first;
  const loaded = (await load(deps, attemptId)) as Loaded;
  await inTx(deps.db, async (tx) => {
    const previous: ExecutionAttempt["state"] = loaded.attempt.railReference ? "RAIL_SUBMITTED" : "HOLD_PLACED";
    const moved = await casAttempt(tx, loaded.attempt, ["UNKNOWN"], { state: previous, unknownPhase: null });
    if (!moved) return;
    const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: loaded.instruction.id } });
    await changeInstruction(tx, deps, instruction, loaded.attempt.railReference ? "SUBMITTED" : "PROCESSING", {
      reference: loaded.attempt.executionReference,
    });
  });
  const context = await coreContextFor(deps, loaded.instruction);
  const refreshed = (await load(deps, attemptId)) as Loaded;
  await book(deps, refreshed, context);
  return "RESUBMITTED";
}

/**
 * Approved repair: declare an unknown attempt "failed, not posted". Only allowed while the
 * core still answers "not found" for the original reference; releases hold and quota.
 */
export async function declareFailedUnposted(deps: Deps, attemptId: string, actorPersonId: string): Promise<InquiryOutcome | "FAILED"> {
  const outcome = await inquireAttempt(deps, attemptId, { personId: actorPersonId });
  if (outcome !== "NOT_FOUND") return outcome;
  const loaded = (await load(deps, attemptId)) as Loaded;
  const context = await coreContextFor(deps, loaded.instruction);
  await deps.core.releaseReservation(context, loaded.attempt.holdReference);
  await inTx(deps.db, async (tx) => {
    const moved = await casAttempt(tx, loaded.attempt, ["UNKNOWN"], {
      state: "FAILED",
      failureCode: "DECLARED_UNPOSTED",
      unknownPhase: null,
      activeKey: null,
    });
    if (!moved) return;
    const instruction = await tx.businessInstruction.findUniqueOrThrow({ where: { id: loaded.instruction.id } });
    await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
    await changeInstruction(tx, deps, instruction, "FAILED", {
      failureCode: "DECLARED_UNPOSTED",
      reference: loaded.attempt.executionReference,
    });
  });
  return "FAILED";
}
