/**
 * Deterministic SIMULATED payment rails ("LYPAY" instant, "ACH" batch clearing).
 * They are not connected to, and do not imitate the protocols of, the real LYPay/ACH systems.
 *
 * Behaviour is driven only by explicit fixture metadata on the destination directory account
 * (`SimDirectoryAccount.scenario`) and operator/test fault records — never by chance or by
 * magic amounts:
 *
 *   SUCCESS                    accepted, settles after the configured clearing delay
 *   ACCOUNT_BLOCKED/RAIL_REJECT definitive rejection before anything is booked
 *   ACH_DELAYED                settles one hour later than normal (needs the sandbox clock)
 *   TIMEOUT_BEFORE_PROCESSING  the core posting request times out before reaching the ledger
 *   TIMEOUT_AFTER_BOOKING      the core books, then the response is lost
 *   LATE_RETURN                settles, then is returned 60 s later
 *   DUPLICATE_EVENT            the SETTLED event is emitted twice
 *   OUT_OF_ORDER_EVENT         a stale ACCEPTED event arrives after SETTLED
 */
import type { Clock } from "@/server/clock";
import { isUniqueViolation, type Db } from "@/server/db/client";
import { addFault, isRailOffline, takeFault } from "@/server/adapters/core/simulator-state";
import type {
  PaymentRailPort,
  RailContext,
  RailEvent,
  RailEventType,
  RailInquiry,
  RailSubmission,
  RailSubmitResult,
} from "./port";

type StoredEvent = { eventId: string; type: RailEventType; sequence: number; code?: string };

const LATE_RETURN_DELAY_MS = 60_000;
const ACH_DELAYED_EXTRA_MS = 3_600_000;

export class SimulatedRail implements PaymentRailPort {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private railReference(submission: RailSubmission): string {
    return `SIM-${submission.rail}-${submission.instructionReference}`;
  }

  async submit(context: RailContext, submission: RailSubmission): Promise<RailSubmitResult> {
    if (await isRailOffline(this.db, submission.rail)) {
      // Offline BEFORE submission: nothing was taken, so a later retry is safe.
      return { kind: "rejected", code: "RAIL_OFFLINE", retryable: true };
    }

    const existing = await this.db.simRailMessage.findUnique({
      where: { instructionReference: submission.instructionReference },
    });
    if (existing) {
      if (existing.status === "REJECTED") {
        return { kind: "rejected", code: existing.rejectCode ?? "RAIL_REJECTED", retryable: false };
      }
      return { kind: "accepted", railReference: existing.railReference };
    }

    const destination = await this.db.simDirectoryAccount.findUnique({
      where: { scheme_reference: { scheme: submission.destination.scheme, reference: submission.destination.reference } },
    });
    // Beneficiaries inside this bank are routed as ordinary successful credits.
    const scenario = destination?.scenario ?? "SUCCESS";
    const internalAccount = destination
      ? null
      : await this.db.simCoreAccount.findUnique({ where: { ref: submission.destination.reference } });

    const forcedReject = await takeFault(this.db, "RAIL_INSTRUCTION", submission.instructionReference, ["RAIL_REJECT"]);
    let rejectCode: string | null = null;
    if (!destination && !internalAccount) rejectCode = "BENEFICIARY_ACCOUNT_NOT_FOUND";
    else if (destination && (destination.status !== "ACTIVE" || scenario === "ACCOUNT_BLOCKED")) rejectCode = "BENEFICIARY_ACCOUNT_BLOCKED";
    else if (scenario === "RAIL_REJECT" || forcedReject) rejectCode = "RAIL_REJECTED";

    const now = this.clock.now();
    const railReference = this.railReference(submission);
    const events: StoredEvent[] = [];
    const push = (type: RailEventType, code?: string) => {
      events.push({ eventId: `${railReference}:${events.length + 1}`, type, sequence: events.length + 1, ...(code ? { code } : {}) });
    };

    let settleAt = new Date(now.getTime() + submission.settlementDelaySeconds * 1000);
    let returnAt: Date | null = null;
    if (rejectCode) {
      push("REJECTED", rejectCode);
    } else {
      push("ACCEPTED");
      if (scenario === "ACH_DELAYED") settleAt = new Date(settleAt.getTime() + ACH_DELAYED_EXTRA_MS);
      if (scenario === "LATE_RETURN") returnAt = new Date(settleAt.getTime() + LATE_RETURN_DELAY_MS);
    }

    try {
      await this.db.simRailMessage.create({
        data: {
          railReference,
          rail: submission.rail,
          instructionReference: submission.instructionReference,
          bankCode: context.bankCode,
          amountMinor: submission.amountMinor,
          currency: submission.currency,
          destinationScheme: submission.destination.scheme,
          destinationReference: submission.destination.reference,
          status: rejectCode ? "REJECTED" : "ACCEPTED",
          rejectCode,
          acceptedAt: now,
          settleAt,
          returnAt,
          events,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return this.submit(context, submission);
      throw error;
    }

    if (rejectCode) return { kind: "rejected", code: rejectCode, retryable: false };

    // Scenario side effects on the later CORE posting for this instruction (one-shot).
    if (scenario === "TIMEOUT_AFTER_BOOKING" || scenario === "TIMEOUT_BEFORE_PROCESSING") {
      await addFault(this.db, {
        targetKind: "EXECUTION_REFERENCE",
        targetValue: submission.instructionReference,
        fault: scenario,
        note: `scenario of ${submission.destination.reference}`,
      });
    }

    const lostResponse = await takeFault(this.db, "RAIL_INSTRUCTION", submission.instructionReference, [
      "RAIL_TIMEOUT_AFTER_ACCEPT",
    ]);
    if (lostResponse) return { kind: "unknown" };
    return { kind: "accepted", railReference };
  }

  async inquire(context: RailContext, instructionReference: string): Promise<RailInquiry> {
    const message = await this.db.simRailMessage.findUnique({ where: { instructionReference } });
    if (!message || message.bankCode !== context.bankCode) return { kind: "not_found" };

    const now = this.clock.now();
    const events = [...((message.events as StoredEvent[] | null) ?? [])];
    let status = message.status as RailEventType;
    const scenario =
      (
        await this.db.simDirectoryAccount.findUnique({
          where: { scheme_reference: { scheme: message.destinationScheme, reference: message.destinationReference } },
        })
      )?.scenario ?? "SUCCESS";
    const push = (type: RailEventType, code?: string) => {
      events.push({
        eventId: `${message.railReference}:${events.length + 1}`,
        type,
        sequence: events.length + 1,
        ...(code ? { code } : {}),
      });
    };

    let changed = false;
    if (status === "ACCEPTED" && now.getTime() >= message.settleAt.getTime()) {
      status = "SETTLED";
      push("SETTLED");
      if (scenario === "DUPLICATE_EVENT") push("SETTLED");
      if (scenario === "OUT_OF_ORDER_EVENT") push("ACCEPTED");
      changed = true;
    }
    if (status === "SETTLED" && message.returnAt && now.getTime() >= message.returnAt.getTime()) {
      status = "RETURNED";
      push("RETURNED", "BENEFICIARY_RETURNED");
      changed = true;
    }
    if (changed) {
      // Compare-and-set on the previous status so concurrent inquiries emit each event once.
      const updated = await this.db.simRailMessage.updateMany({
        where: { railReference: message.railReference, status: message.status },
        data: { status, events },
      });
      if (updated.count !== 1) return this.inquire(context, instructionReference);
    }

    return {
      kind: "found",
      railReference: message.railReference,
      status,
      ...(message.rejectCode ? { code: message.rejectCode } : {}),
      events: events as RailEvent[],
    };
  }
}
