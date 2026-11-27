/**
 * Canonical core-banking port (document 03 "Canonical interfaces", MON-02).
 *
 * The platform decides (agreement, limits, approvals); the core posts and owns balances.
 * The platform speaks only this canonical model. R1 ships exactly one implementation — the
 * deterministic SIMULATED core — and no real T24/FLEXCUBE endpoint is assumed or invented.
 *
 * Contract highlights every adapter must honour:
 *  - `reserveDebit`, `execute` and `releaseReservation` are idempotent by their reference.
 *  - `execute` never reports a guess: a lost response is `{ kind: "unknown" }`.
 *  - `inquire` answers for the ORIGINAL execution reference; it never posts.
 *  - An outage throws `CoreUnavailableError`; callers must not render that as a zero balance.
 */
import type { LocalDate } from "@/server/calendar";

export type CoreContext = Readonly<{
  /** Bank scope of the caller. The core rejects accounts of another bank. */
  bankCode: string;
  /**
   * When set, customer-account operations are additionally restricted to accounts owned by
   * this core customer (a second, independent tenant check below the platform's own).
   */
  ownerRef?: string;
  correlationId?: string | null;
}>;

export type CanonicalAccount = Readonly<{
  ref: string;
  ownerRef: string | null;
  holderName: string;
  currency: string;
  status: "ACTIVE" | "BLOCKED" | "CLOSED";
}>;

export type Balance = Readonly<{
  accountRef: string;
  currency: string;
  bookedMinor: bigint;
  holdsMinor: bigint;
  /** booked − active debit holds; no overdraft in R1. */
  availableMinor: bigint;
  asOf: Date;
}>;

export type AccountReference = Readonly<{ scheme: string; reference: string; name: string }>;

export type NameMatch = Readonly<{
  status: "MATCH" | "CLOSE_MATCH" | "MISMATCH" | "NOT_FOUND";
  /** Name registered for the account, when the directory may disclose it. */
  returnedName?: string;
  bankName?: string;
}>;

export type DebitReservation = Readonly<{
  reference: string;
  accountRef: string;
  amountMinor: bigint;
  currency: string;
}>;

export type ReservationResult =
  | { kind: "reserved" }
  | { kind: "rejected"; code: "INSUFFICIENT_FUNDS" | "ACCOUNT_BLOCKED" | "ACCOUNT_NOT_FOUND" | "CURRENCY_MISMATCH" | "REFERENCE_MISMATCH" };

type InstructionBase = Readonly<{
  /** Stable for every retry of the same attempt; the core's idempotency key. */
  executionReference: string;
  currency: string;
  narrative: string;
  /** Grouping reference used by statement projections (e.g. a payroll run). */
  groupRef?: string;
}>;

export type CoreInstruction =
  | (InstructionBase & {
      type: "EXTERNAL_TRANSFER";
      rail: "LYPAY" | "ACH";
      debitAccountRef: string;
      principalMinor: bigint;
      feeMinor: bigint;
      /** Captured atomically with the booking when present. */
      holdReference?: string;
    })
  | (InstructionBase & {
      type: "INTERNAL_TRANSFER";
      debitAccountRef: string;
      creditAccountRef: string;
      principalMinor: bigint;
      feeMinor: bigint;
      holdReference?: string;
    })
  | (InstructionBase & {
      type: "CASH_DEPOSIT";
      creditAccountRef: string;
      amountMinor: bigint;
      branchCashAccountRef: string;
    })
  | (InstructionBase & {
      type: "CHEQUE_DEPOSIT";
      creditAccountRef: string;
      amountMinor: bigint;
    })
  | (InstructionBase & {
      /** Compensation for a settled external transfer. The original journal is retained. */
      type: "RETURN";
      originalExecutionReference: string;
    });

export type ExecutionResult =
  | { kind: "confirmed"; coreReference: string; bookedAt: Date; businessDate: LocalDate }
  | { kind: "rejected"; code: string; retryable: boolean }
  | { kind: "unknown"; executionReference: string };

export type InquiryResult =
  | { kind: "posted"; coreReference: string; bookedAt: Date; businessDate: LocalDate }
  | { kind: "not_found" };

export type Posting = Readonly<{
  /** Stable line key (entry id, or group reference + business date for a consolidated line). */
  lineId: string;
  /** NULL for a consolidated line (many journals). */
  executionReference: string | null;
  kind: string;
  narrative: string;
  /**
   * Set when the core consolidated several postings that share a group reference (a payroll
   * run) into ONE statement line per business date. Child postings of a group are never
   * returned individually (PYR-02).
   */
  groupRef: string | null;
  /** Number of principal postings represented by this line (1 for an ordinary line). */
  itemCount: number;
  component: "PRINCIPAL" | "FEE" | "MIXED";
  /** Positive = credit to the account, negative = debit. Includes the fee part of a group. */
  signedMinor: bigint;
  /** Fee part included in `signedMinor` for a consolidated line (signed), otherwise 0. */
  feeMinor: bigint;
  currency: string;
  postedAt: Date;
  businessDate: LocalDate;
}>;

export type PostingQuery = Readonly<{
  accountRef: string;
  /** Inclusive business dates. */
  fromDate?: LocalDate;
  toDate?: LocalDate;
  /** Case-insensitive match on the posting narrative or execution reference. */
  search?: string;
  /** Opaque cursor from a previous page (newest first). */
  cursor?: string | null;
  limit: number;
}>;

export type PostingPage = Readonly<{ postings: Posting[]; nextCursor: string | null }>;

/** One line of the core's end-of-day extract for a business date (OPS-01 reconciliation). */
export type ReconExtractLine = Readonly<{
  executionReference: string;
  kind: string;
  /** Net movement on customer accounts for the PRINCIPAL component (absolute value). */
  principalMinor: bigint;
  feeMinor: bigint;
  currency: string;
  postedAt: Date;
}>;

export class CoreUnavailableError extends Error {
  readonly code = "CORE_UNAVAILABLE";
  constructor(message = "Core banking system unavailable") {
    super(message);
    this.name = "CoreUnavailableError";
  }
}

export interface CoreBankingPort {
  getAccounts(context: CoreContext, ownerRef: string): Promise<CanonicalAccount[]>;
  getBalance(context: CoreContext, accountRef: string): Promise<Balance>;
  validateBeneficiary(context: CoreContext, input: AccountReference): Promise<NameMatch>;
  reserveDebit(context: CoreContext, reservation: DebitReservation): Promise<ReservationResult>;
  execute(context: CoreContext, instruction: CoreInstruction): Promise<ExecutionResult>;
  inquire(context: CoreContext, executionReference: string): Promise<InquiryResult>;
  releaseReservation(context: CoreContext, reference: string): Promise<void>;
  getPostings(context: CoreContext, query: PostingQuery): Promise<PostingPage>;
  getReconciliationExtract(context: CoreContext, businessDate: LocalDate): Promise<ReconExtractLine[]>;
}
