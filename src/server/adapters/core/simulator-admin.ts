/**
 * Fixture provisioning for the SIMULATED core: accounts, the synthetic directory and opening
 * balances. Used by the demo seed and by tests. Opening balances are ordinary balanced journals
 * against a simulated equity account — there is no way to "set" a balance (MON-02).
 */
import { businessDateOf, localDateToDbDate } from "@/server/calendar";
import type { Clock } from "@/server/clock";
import { inTx, type Db } from "@/server/db/client";
import { digestOf } from "@/server/hash";
import {
  CHEQUE_CLEARING_ACCOUNT,
  FEE_INCOME_ACCOUNT,
  OPENING_EQUITY_ACCOUNT,
  SETTLEMENT_ACCOUNT,
  glRef,
} from "./simulated-core";

const ADAPTER_TX = { skipIdempotency: true } as const;

export type SimAccountSpec = {
  ref: string;
  bankCode: string;
  ownerRef: string | null;
  holderName: string;
  currency: string;
  kind: "CUSTOMER" | "SETTLEMENT_CONTROL" | "FEE_INCOME" | "CASH_VAULT" | "CHEQUE_CLEARING" | "OPENING_EQUITY";
};

export async function ensureSimAccount(db: Db, spec: SimAccountSpec): Promise<void> {
  await db.simCoreAccount.createMany({
    data: [{ ...spec, allowNegative: spec.kind !== "CUSTOMER" }],
    skipDuplicates: true,
  });
}

/** General-ledger accounts every simulated bank needs. */
export async function ensureBankLedger(db: Db, bankCode: string, branchCodes: readonly string[], currency = "LYD"): Promise<void> {
  const gl = (name: string, kind: SimAccountSpec["kind"], holderName: string): SimAccountSpec => ({
    ref: glRef(bankCode, name),
    bankCode,
    ownerRef: null,
    holderName,
    currency,
    kind,
  });
  await ensureSimAccount(db, gl(SETTLEMENT_ACCOUNT.LYPAY, "SETTLEMENT_CONTROL", "Simulated instant-rail settlement control"));
  await ensureSimAccount(db, gl(SETTLEMENT_ACCOUNT.ACH, "SETTLEMENT_CONTROL", "Simulated ACH settlement control"));
  await ensureSimAccount(db, gl(FEE_INCOME_ACCOUNT, "FEE_INCOME", "Simulated fee income"));
  await ensureSimAccount(db, gl(CHEQUE_CLEARING_ACCOUNT, "CHEQUE_CLEARING", "Simulated cheque clearing"));
  await ensureSimAccount(db, gl(OPENING_EQUITY_ACCOUNT, "OPENING_EQUITY", "Simulated opening equity"));
  for (const branch of branchCodes) {
    await ensureSimAccount(db, gl(branchCashRef(branch), "CASH_VAULT", `Simulated cash vault ${branch}`));
  }
}

export function branchCashRef(branchCode: string): string {
  return `SIM-GL-CASH-${branchCode}`;
}

/**
 * Book the opening balance of a synthetic account exactly once (reference `OPENING:<ref>`).
 * Re-running the seed never adds a second opening journal.
 */
export async function ensureOpeningBalance(
  db: Db,
  clock: Clock,
  timeZone: string,
  input: { bankCode: string; accountRef: string; amountMinor: bigint; currency: string },
): Promise<boolean> {
  if (input.amountMinor <= 0n) return false;
  const executionReference = `OPENING:${input.accountRef}`;
  const existing = await db.simCoreJournal.findUnique({ where: { executionReference } });
  if (existing) return false;
  const now = clock.now();
  await inTx(
    db,
    async (tx) => {
      const journal = await tx.simCoreJournal.create({
        data: {
          executionReference,
          bankCode: input.bankCode,
          kind: "OPENING_BALANCE",
          businessDate: localDateToDbDate(businessDateOf(now, timeZone)),
          postedAt: now,
          narrative: "Synthetic opening balance (sandbox fixture)",
          payloadHash: digestOf(input),
        },
      });
      const equity = glRef(input.bankCode, OPENING_EQUITY_ACCOUNT);
      await tx.simCoreEntry.createMany({
        data: [
          { journalId: journal.id, accountRef: equity, lineNo: 1, signedMinor: -input.amountMinor, currency: input.currency, postedAt: now },
          { journalId: journal.id, accountRef: input.accountRef, lineNo: 2, signedMinor: input.amountMinor, currency: input.currency, postedAt: now },
        ],
      });
      await tx.simCoreAccount.update({ where: { ref: equity }, data: { bookedMinor: { decrement: input.amountMinor } } });
      await tx.simCoreAccount.update({ where: { ref: input.accountRef }, data: { bookedMinor: { increment: input.amountMinor } } });
    },
    ADAPTER_TX,
  );
  return true;
}

export type DirectorySpec = {
  reference: string;
  holderName: string;
  bankName: string;
  scenario?:
    | "SUCCESS"
    | "NAME_MISMATCH"
    | "CLOSE_MATCH"
    | "ACCOUNT_BLOCKED"
    | "RAIL_REJECT"
    | "TIMEOUT_BEFORE_PROCESSING"
    | "TIMEOUT_AFTER_BOOKING"
    | "ACH_DELAYED"
    | "LATE_RETURN"
    | "DUPLICATE_EVENT"
    | "OUT_OF_ORDER_EVENT";
};

export async function ensureDirectoryAccounts(db: Db, specs: readonly DirectorySpec[]): Promise<void> {
  if (specs.length === 0) return;
  await db.simDirectoryAccount.createMany({
    data: specs.map((spec) => ({
      scheme: "DEMO_DOMESTIC",
      reference: spec.reference,
      holderName: spec.holderName,
      bankName: spec.bankName,
      scenario: spec.scenario ?? "SUCCESS",
    })),
    skipDuplicates: true,
  });
}
