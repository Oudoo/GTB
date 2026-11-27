/**
 * Canonical payment-rail port (document 03). Rail acceptance is NOT settlement and is never
 * conflated with core booking. R1 ships only deterministic simulations of an instant rail
 * ("LYPAY") and a batch-clearing rail ("ACH"); they are not the real LYPay or ACH systems.
 */
export type RailCode = "LYPAY" | "ACH";

export type RailContext = Readonly<{ bankCode: string; correlationId?: string | null }>;

export type RailSubmission = Readonly<{
  rail: RailCode;
  /** Stable platform reference; resubmitting the same reference returns the original result. */
  instructionReference: string;
  amountMinor: bigint;
  currency: string;
  destination: Readonly<{ scheme: string; reference: string; name: string }>;
  /** Clearing delay configured in the bank's rail parameters (seconds after acceptance). */
  settlementDelaySeconds: number;
}>;

export type RailSubmitResult =
  | { kind: "accepted"; railReference: string }
  /** `retryable` true only for a temporary condition met BEFORE the rail took the instruction. */
  | { kind: "rejected"; code: string; retryable: boolean }
  /** The response was lost: the rail may or may not hold the instruction. Inquire, do not guess. */
  | { kind: "unknown" };

export type RailEventType = "ACCEPTED" | "SETTLED" | "REJECTED" | "RETURNED";

/** A status event as the rail emits it. Delivery is at-least-once and may be out of order. */
export type RailEvent = Readonly<{
  eventId: string;
  type: RailEventType;
  sequence: number;
  code?: string;
}>;

export type RailInquiry =
  | { kind: "not_found" }
  | {
      kind: "found";
      railReference: string;
      /** Authoritative current status. */
      status: RailEventType;
      code?: string;
      /** Raw event stream since acceptance (may contain duplicates / stale events). */
      events: RailEvent[];
    };

export class RailUnavailableError extends Error {
  readonly code = "RAIL_UNAVAILABLE";
  constructor(message = "Payment rail unavailable") {
    super(message);
    this.name = "RailUnavailableError";
  }
}

export interface PaymentRailPort {
  submit(context: RailContext, submission: RailSubmission): Promise<RailSubmitResult>;
  inquire(context: RailContext, instructionReference: string): Promise<RailInquiry>;
}
