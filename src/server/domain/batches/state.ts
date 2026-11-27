/**
 * Pure batch rules (BAT-02, BAT-03, U-STA-05): the batch state is DERIVED from the outcomes of
 * its accepted rows, and the accepted set is identified by a digest that approvals bind to.
 */
import { digestOf } from "@/server/hash";

export type RowOutcomeCounts = Readonly<{
  accepted: number;
  settled: number;
  failed: number;
  returned: number;
  unknown: number;
  /** PENDING, PROCESSING or SUBMITTED. */
  inFlight: number;
}>;

export type DerivedBatchState = "PROCESSING" | "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED";

/**
 * - Anything still in flight or unknown → PROCESSING. A batch is never "complete" while a
 *   single row is unknown or pending.
 * - COMPLETED only when EVERY accepted row is confirmed settled.
 * - FAILED only when every accepted row definitively failed before posting.
 * - Otherwise PARTIALLY_COMPLETED (including rows settled and later returned).
 */
export function deriveBatchState(counts: RowOutcomeCounts): DerivedBatchState {
  if (counts.accepted === 0) return "FAILED";
  if (counts.inFlight > 0 || counts.unknown > 0) return "PROCESSING";
  if (counts.settled === counts.accepted) return "COMPLETED";
  if (counts.failed === counts.accepted) return "FAILED";
  return "PARTIALLY_COMPLETED";
}

export type AcceptedRowFacts = Readonly<{ lineNumber: number; businessKey: string; amountMinor: bigint; destination: string }>;

/**
 * Digest of the accepted set. Order-independent, so the same rows always give the same value
 * and any added, removed or changed row gives a different one.
 */
export function acceptedSetHash(rows: readonly AcceptedRowFacts[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((row) => [row.lineNumber, row.businessKey, row.amountMinor.toString(), row.destination]);
  return digestOf({ rows: canonical });
}

/** Net pay of one payroll line: basic + allowances − deductions + signed correction (PYR-01). */
export function payrollNet(parts: { basicMinor: bigint; allowancesMinor: bigint; deductionsMinor: bigint; correctionMinor: bigint }): bigint {
  return parts.basicMinor + parts.allowancesMinor - parts.deductionsMinor + parts.correctionMinor;
}

/**
 * Whether a net amount differs from the last confirmed one by at least `thresholdBps`
 * (2000 = 20%). Compared exactly in integers; a first payment has no baseline and no flag.
 */
export function salaryChanged(previousNetMinor: bigint | null, netMinor: bigint, thresholdBps: number): boolean {
  if (previousNetMinor === null || previousNetMinor <= 0n) return false;
  const difference = netMinor > previousNetMinor ? netMinor - previousNetMinor : previousNetMinor - netMinor;
  return difference * 10_000n >= previousNetMinor * BigInt(thresholdBps);
}
