/**
 * Deterministic SIMULATED core banking ledger (MON-02, COR-001). Not a real bank system.
 *
 * - Lives in its own PostgreSQL schema (`simcore`) and commits in its OWN transactions, never
 *   inside a platform transaction — so "core posted, platform never heard" is a real failure
 *   window that tests can open (I-18).
 * - A journal is unique per execution reference; replaying a reference returns the original.
 * - Entries of a journal sum to zero per currency (also enforced by a deferred DB trigger).
 * - Available = booked − ACTIVE holds; customer accounts cannot go negative.
 * - Failure behaviour comes only from explicit fault records (`SimFault`) — never from random
 *   numbers or magic amounts.
 */
import { businessDateOf, dbDateToLocalDate, localDateToDbDate, type LocalDate } from "@/server/calendar";
import type { Clock } from "@/server/clock";
import { Prisma, inTx, isUniqueViolation, type Db, type Tx } from "@/server/db/client";
import { digestOf } from "@/server/hash";
import {
  CoreUnavailableError,
  type AccountReference,
  type Balance,
  type CanonicalAccount,
  type CoreBankingPort,
  type CoreContext,
  type CoreInstruction,
  type DebitReservation,
  type ExecutionResult,
  type InquiryResult,
  type NameMatch,
  type Posting,
  type PostingPage,
  type PostingQuery,
  type ReconExtractLine,
  type ReservationResult,
} from "./port";
import { isCoreOffline, takeFault } from "./simulator-state";

type EntrySpec = { accountRef: string; signedMinor: bigint; component: "PRINCIPAL" | "FEE" };

type AccountRow = {
  ref: string;
  bankCode: string;
  ownerRef: string | null;
  currency: string;
  kind: string;
  status: string;
  bookedMinor: bigint;
  allowNegative: boolean;
};

/** The simulated core commits independently of any platform request transaction. */
const ADAPTER_TX = { skipIdempotency: true } as const;

export const SETTLEMENT_ACCOUNT = { LYPAY: "SIM-GL-LYPAY-SETTLEMENT", ACH: "SIM-GL-ACH-SETTLEMENT" } as const;
export const FEE_INCOME_ACCOUNT = "SIM-GL-FEE-INCOME";
export const CHEQUE_CLEARING_ACCOUNT = "SIM-GL-CHEQUE-CLEARING";
export const OPENING_EQUITY_ACCOUNT = "SIM-GL-OPENING-EQUITY";

/** General-ledger accounts are per bank: "<bankCode>:<name>". */
export function glRef(bankCode: string, name: string): string {
  return `${bankCode}:${name}`;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Deterministic name comparison used by the simulated name enquiry. */
export function compareNames(entered: string, registered: string): "MATCH" | "CLOSE_MATCH" | "MISMATCH" {
  const a = normalizeName(entered);
  const b = normalizeName(registered);
  if (!a || !b) return "MISMATCH";
  if (a === b) return "MATCH";
  const tokensA = new Set(a.split(" "));
  const tokensB = new Set(b.split(" "));
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  const ratio = shared / Math.max(tokensA.size, tokensB.size);
  return ratio >= 0.5 ? "CLOSE_MATCH" : "MISMATCH";
}

export class SimulatedCore implements CoreBankingPort {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {}

  private async assertOnline(): Promise<void> {
    if (await isCoreOffline(this.db)) throw new CoreUnavailableError();
  }

  private async lockAccounts(tx: Tx, refs: string[]): Promise<Map<string, AccountRow>> {
    const unique = [...new Set(refs)].sort();
    // Stable lock order (sorted reference) prevents deadlocks between concurrent postings.
    const rows = await tx.$queryRaw<AccountRow[]>`
      SELECT "ref", "bankCode", "ownerRef", "currency", "kind"::text AS kind, "status"::text AS status,
             "bookedMinor", "allowNegative"
        FROM "simcore"."SimCoreAccount"
       WHERE "ref" IN (${Prisma.join(unique)})
       ORDER BY "ref"
         FOR UPDATE`;
    return new Map(rows.map((row) => [row.ref, row]));
  }

  private async activeHolds(tx: Tx, accountRef: string): Promise<bigint> {
    const result = await tx.simCoreHold.aggregate({
      where: { accountRef, state: "ACTIVE" },
      _sum: { amountMinor: true },
    });
    return result._sum.amountMinor ?? 0n;
  }

  private ownsAccount(context: CoreContext, account: AccountRow | { bankCode: string; ownerRef: string | null }): boolean {
    if (account.bankCode !== context.bankCode) return false;
    return context.ownerRef === undefined || account.ownerRef === context.ownerRef;
  }

  async getAccounts(context: CoreContext, ownerRef: string): Promise<CanonicalAccount[]> {
    await this.assertOnline();
    const rows = await this.db.simCoreAccount.findMany({
      where: { bankCode: context.bankCode, ownerRef, kind: "CUSTOMER" },
      orderBy: { ref: "asc" },
    });
    return rows.map((row) => ({
      ref: row.ref,
      ownerRef: row.ownerRef,
      holderName: row.holderName,
      currency: row.currency,
      status: row.status,
    }));
  }

  async getBalance(context: CoreContext, accountRef: string): Promise<Balance> {
    await this.assertOnline();
    const account = await this.db.simCoreAccount.findUnique({ where: { ref: accountRef } });
    if (!account || !this.ownsAccount(context, account)) throw new Error("ACCOUNT_NOT_FOUND");
    const holds = await this.db.simCoreHold.aggregate({
      where: { accountRef, state: "ACTIVE" },
      _sum: { amountMinor: true },
    });
    const holdsMinor = holds._sum.amountMinor ?? 0n;
    return {
      accountRef,
      currency: account.currency,
      bookedMinor: account.bookedMinor,
      holdsMinor,
      availableMinor: account.bookedMinor - holdsMinor,
      asOf: this.clock.now(),
    };
  }

  async validateBeneficiary(context: CoreContext, input: AccountReference): Promise<NameMatch> {
    await this.assertOnline();
    // 1. Accounts held at this (simulated) bank.
    const internal = await this.db.simCoreAccount.findUnique({ where: { ref: input.reference } });
    if (internal && internal.bankCode === context.bankCode && internal.kind === "CUSTOMER" && input.scheme === "DEMO_DOMESTIC") {
      if (internal.status !== "ACTIVE") return { status: "NOT_FOUND" };
      const status = compareNames(input.name, internal.holderName);
      return status === "MISMATCH"
        ? { status, bankName: "Al Qarib Sandbox" }
        : { status, returnedName: internal.holderName, bankName: "Al Qarib Sandbox" };
    }
    // 2. Synthetic directory of accounts at other (simulated) banks.
    const external = await this.db.simDirectoryAccount.findUnique({
      where: { scheme_reference: { scheme: input.scheme, reference: input.reference } },
    });
    if (!external || external.status === "CLOSED") return { status: "NOT_FOUND" };
    if (external.scenario === "NAME_MISMATCH") return { status: "MISMATCH", bankName: external.bankName };
    const status = compareNames(input.name, external.holderName);
    if (external.scenario === "CLOSE_MATCH" && status === "MATCH") {
      // This fixture account always answers "close match" so the acknowledgment path is testable.
      return { status: "CLOSE_MATCH", returnedName: external.holderName, bankName: external.bankName };
    }
    return status === "MISMATCH"
      ? { status, bankName: external.bankName }
      : { status, returnedName: external.holderName, bankName: external.bankName };
  }

  async reserveDebit(context: CoreContext, reservation: DebitReservation): Promise<ReservationResult> {
    await this.assertOnline();
    if (reservation.amountMinor <= 0n) throw new Error("Reservation amount must be positive");
    try {
      return await inTx(this.db, async (tx) => {
        const accounts = await this.lockAccounts(tx, [reservation.accountRef]);
        const account = accounts.get(reservation.accountRef);
        if (!account || !this.ownsAccount(context, account)) return { kind: "rejected", code: "ACCOUNT_NOT_FOUND" } as const;
        const existing = await tx.simCoreHold.findUnique({ where: { reference: reservation.reference } });
        if (existing) {
          // Idempotent replay: same reference and terms → same answer, no second hold.
          if (existing.accountRef !== reservation.accountRef || existing.amountMinor !== reservation.amountMinor) {
            return { kind: "rejected", code: "REFERENCE_MISMATCH" } as const;
          }
          return { kind: "reserved" } as const;
        }
        if (account.status !== "ACTIVE") return { kind: "rejected", code: "ACCOUNT_BLOCKED" } as const;
        if (account.currency !== reservation.currency) return { kind: "rejected", code: "CURRENCY_MISMATCH" } as const;
        const available = account.bookedMinor - (await this.activeHolds(tx, account.ref));
        if (available < reservation.amountMinor) return { kind: "rejected", code: "INSUFFICIENT_FUNDS" } as const;
        await tx.simCoreHold.create({
          data: { reference: reservation.reference, accountRef: account.ref, amountMinor: reservation.amountMinor },
        });
        return { kind: "reserved" } as const;
      }, ADAPTER_TX);
    } catch (error) {
      if (isUniqueViolation(error)) return this.reserveDebit(context, reservation);
      throw error;
    }
  }

  async releaseReservation(_context: CoreContext, reference: string): Promise<void> {
    await this.assertOnline();
    // Idempotent: releasing a captured or already released hold changes nothing.
    await this.db.simCoreHold.updateMany({ where: { reference, state: "ACTIVE" }, data: { state: "RELEASED" } });
  }

  private entriesFor(context: CoreContext, instruction: CoreInstruction, original?: EntrySpec[]): EntrySpec[] {
    const bank = context.bankCode;
    switch (instruction.type) {
      case "EXTERNAL_TRANSFER": {
        const entries: EntrySpec[] = [
          { accountRef: instruction.debitAccountRef, signedMinor: -instruction.principalMinor, component: "PRINCIPAL" },
          { accountRef: glRef(bank, SETTLEMENT_ACCOUNT[instruction.rail]), signedMinor: instruction.principalMinor, component: "PRINCIPAL" },
        ];
        if (instruction.feeMinor > 0n) {
          entries.push(
            { accountRef: instruction.debitAccountRef, signedMinor: -instruction.feeMinor, component: "FEE" },
            { accountRef: glRef(bank, FEE_INCOME_ACCOUNT), signedMinor: instruction.feeMinor, component: "FEE" },
          );
        }
        return entries;
      }
      case "INTERNAL_TRANSFER": {
        const entries: EntrySpec[] = [
          { accountRef: instruction.debitAccountRef, signedMinor: -instruction.principalMinor, component: "PRINCIPAL" },
          { accountRef: instruction.creditAccountRef, signedMinor: instruction.principalMinor, component: "PRINCIPAL" },
        ];
        if (instruction.feeMinor > 0n) {
          entries.push(
            { accountRef: instruction.debitAccountRef, signedMinor: -instruction.feeMinor, component: "FEE" },
            { accountRef: glRef(bank, FEE_INCOME_ACCOUNT), signedMinor: instruction.feeMinor, component: "FEE" },
          );
        }
        return entries;
      }
      case "CASH_DEPOSIT":
        return [
          { accountRef: instruction.branchCashAccountRef, signedMinor: -instruction.amountMinor, component: "PRINCIPAL" },
          { accountRef: instruction.creditAccountRef, signedMinor: instruction.amountMinor, component: "PRINCIPAL" },
        ];
      case "CHEQUE_DEPOSIT":
        return [
          { accountRef: glRef(bank, CHEQUE_CLEARING_ACCOUNT), signedMinor: -instruction.amountMinor, component: "PRINCIPAL" },
          { accountRef: instruction.creditAccountRef, signedMinor: instruction.amountMinor, component: "PRINCIPAL" },
        ];
      case "RETURN":
        // Compensation reverses the PRINCIPAL legs of the original; the fee stays (DEC-015).
        return (original ?? [])
          .filter((entry) => entry.component === "PRINCIPAL")
          .map((entry) => ({ ...entry, signedMinor: -entry.signedMinor }));
    }
  }

  async execute(context: CoreContext, instruction: CoreInstruction): Promise<ExecutionResult> {
    if (await isCoreOffline(this.db)) return { kind: "rejected", code: "CORE_UNAVAILABLE", retryable: true };

    const fault = await takeFault(this.db, "EXECUTION_REFERENCE", instruction.executionReference, [
      "TIMEOUT_BEFORE_PROCESSING",
      "TIMEOUT_AFTER_BOOKING",
      "REJECT",
    ]);
    if (fault === "TIMEOUT_BEFORE_PROCESSING") {
      // The request never reached the ledger; the caller only sees a timeout.
      return { kind: "unknown", executionReference: instruction.executionReference };
    }
    if (fault === "REJECT") return { kind: "rejected", code: "CORE_REJECTED", retryable: false };

    const payloadHash = digestOf(instruction);
    let result: ExecutionResult;
    try {
      result = await inTx(this.db, (tx) => this.post(tx, context, instruction, payloadHash), ADAPTER_TX);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent call with the same reference won the race: answer with ITS journal.
      result = await inTx(this.db, (tx) => this.post(tx, context, instruction, payloadHash), ADAPTER_TX);
    }

    if (fault === "TIMEOUT_AFTER_BOOKING" && result.kind === "confirmed") {
      // The ledger is booked and committed, but the response is "lost".
      return { kind: "unknown", executionReference: instruction.executionReference };
    }
    return result;
  }

  private async post(tx: Tx, context: CoreContext, instruction: CoreInstruction, payloadHash: string): Promise<ExecutionResult> {
    const existing = await tx.simCoreJournal.findUnique({ where: { executionReference: instruction.executionReference } });
    if (existing) {
      if (existing.payloadHash !== payloadHash || existing.bankCode !== context.bankCode) {
        return { kind: "rejected", code: "DUPLICATE_REFERENCE_MISMATCH", retryable: false };
      }
      return {
        kind: "confirmed",
        coreReference: existing.id,
        bookedAt: existing.postedAt,
        businessDate: dbDateToLocalDate(existing.businessDate),
      };
    }

    let original: EntrySpec[] | undefined;
    if (instruction.type === "RETURN") {
      const source = await tx.simCoreJournal.findUnique({
        where: { executionReference: instruction.originalExecutionReference },
        include: { entries: true },
      });
      if (!source || source.bankCode !== context.bankCode) {
        return { kind: "rejected", code: "ORIGINAL_NOT_FOUND", retryable: false };
      }
      original = source.entries.map((entry) => ({
        accountRef: entry.accountRef,
        signedMinor: entry.signedMinor,
        component: entry.component === "FEE" ? "FEE" : "PRINCIPAL",
      }));
    }

    const entries = this.entriesFor(context, instruction, original);
    if (entries.length < 2 || entries.reduce((sum, entry) => sum + entry.signedMinor, 0n) !== 0n) {
      return { kind: "rejected", code: "UNBALANCED_INSTRUCTION", retryable: false };
    }
    if (entries.some((entry) => entry.signedMinor === 0n)) {
      return { kind: "rejected", code: "INVALID_AMOUNT", retryable: false };
    }

    const accounts = await this.lockAccounts(tx, entries.map((entry) => entry.accountRef));
    for (const entry of entries) {
      const account = accounts.get(entry.accountRef);
      if (!account || account.bankCode !== context.bankCode) {
        return { kind: "rejected", code: "ACCOUNT_NOT_FOUND", retryable: false };
      }
      if (account.currency !== instruction.currency) return { kind: "rejected", code: "CURRENCY_MISMATCH", retryable: false };
      if (account.kind === "CUSTOMER") {
        if (account.status !== "ACTIVE") return { kind: "rejected", code: "ACCOUNT_BLOCKED", retryable: false };
        if (context.ownerRef !== undefined && account.ownerRef !== context.ownerRef) {
          return { kind: "rejected", code: "ACCOUNT_NOT_FOUND", retryable: false };
        }
      }
    }

    // Net effect per account.
    const net = new Map<string, bigint>();
    for (const entry of entries) net.set(entry.accountRef, (net.get(entry.accountRef) ?? 0n) + entry.signedMinor);

    const holdReference =
      instruction.type === "EXTERNAL_TRANSFER" || instruction.type === "INTERNAL_TRANSFER" ? instruction.holdReference : undefined;
    let capturedHold: { accountRef: string; amountMinor: bigint } | undefined;
    if (holdReference) {
      const hold = await tx.simCoreHold.findUnique({ where: { reference: holdReference } });
      if (!hold || hold.state !== "ACTIVE") return { kind: "rejected", code: "HOLD_NOT_ACTIVE", retryable: false };
      capturedHold = { accountRef: hold.accountRef, amountMinor: hold.amountMinor };
    }

    for (const [ref, delta] of net) {
      const account = accounts.get(ref) as AccountRow;
      if (delta >= 0n || account.allowNegative) continue;
      let available = account.bookedMinor - (await this.activeHolds(tx, ref));
      // Funds reserved for THIS instruction are available to it.
      if (capturedHold && capturedHold.accountRef === ref) available += capturedHold.amountMinor;
      if (available + delta < 0n) return { kind: "rejected", code: "INSUFFICIENT_FUNDS", retryable: false };
    }

    const now = this.clock.now();
    const businessDate = businessDateOf(now, this.timeZone);
    const journal = await tx.simCoreJournal.create({
      data: {
        executionReference: instruction.executionReference,
        bankCode: context.bankCode,
        kind: instruction.type,
        businessDate: localDateToDbDate(businessDate),
        postedAt: now,
        narrative: instruction.narrative,
        groupRef: instruction.groupRef ?? null,
        payloadHash,
        reversesExecutionReference: instruction.type === "RETURN" ? instruction.originalExecutionReference : null,
      },
    });
    await tx.simCoreEntry.createMany({
      data: entries.map((entry, index) => ({
        journalId: journal.id,
        accountRef: entry.accountRef,
        lineNo: index + 1,
        signedMinor: entry.signedMinor,
        currency: instruction.currency,
        component: entry.component,
        postedAt: now,
      })),
    });
    for (const [ref, delta] of net) {
      await tx.simCoreAccount.update({ where: { ref }, data: { bookedMinor: { increment: delta } } });
    }
    if (holdReference) {
      await tx.simCoreHold.update({ where: { reference: holdReference }, data: { state: "CAPTURED" } });
    }
    return { kind: "confirmed", coreReference: journal.id, bookedAt: now, businessDate };
  }

  async inquire(context: CoreContext, executionReference: string): Promise<InquiryResult> {
    await this.assertOnline();
    const journal = await this.db.simCoreJournal.findUnique({ where: { executionReference } });
    if (!journal || journal.bankCode !== context.bankCode) return { kind: "not_found" };
    return {
      kind: "posted",
      coreReference: journal.id,
      bookedAt: journal.postedAt,
      businessDate: dbDateToLocalDate(journal.businessDate),
    };
  }

  async getPostings(context: CoreContext, query: PostingQuery): Promise<PostingPage> {
    await this.assertOnline();
    const account = await this.db.simCoreAccount.findUnique({ where: { ref: query.accountRef } });
    if (!account || !this.ownsAccount(context, account)) throw new Error("ACCOUNT_NOT_FOUND");
    const limit = Math.min(Math.max(query.limit, 1), 500);

    let cursor: { postedAt: Date; id: string } | undefined;
    if (query.cursor) {
      const decoded = Buffer.from(query.cursor, "base64url").toString("utf8");
      const separator = decoded.indexOf("|");
      const iso = separator > 0 ? decoded.slice(0, separator) : "";
      const id = separator > 0 ? decoded.slice(separator + 1) : "";
      if (iso && id && !Number.isNaN(Date.parse(iso))) cursor = { postedAt: new Date(iso), id };
    }

    const search = query.search ? `%${query.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    // One line per ordinary entry; entries of a grouped journal (payroll run) are consolidated
    // into a single line per group and business date, so child postings never leave the core.
    const rows = await this.db.$queryRaw<
      Array<{
        key: string;
        grouped: boolean;
        executionReference: string;
        kind: string;
        narrative: string;
        groupRef: string | null;
        component: string;
        components: number;
        items: number;
        signedMinor: bigint;
        feeMinor: bigint | null;
        currency: string;
        postedAt: Date;
        businessDate: Date;
      }>
    >`
      WITH lines AS (
        SELECT COALESCE(j."groupRef" || '|' || j."businessDate"::text, e."id"::text) AS key,
               (j."groupRef" IS NOT NULL) AS grouped,
               min(j."executionReference") AS "executionReference",
               min(j."kind") AS kind,
               min(j."narrative") AS narrative,
               j."groupRef",
               min(e."component") AS component,
               count(DISTINCT e."component")::int AS components,
               (count(*) FILTER (WHERE e."component" = 'PRINCIPAL'))::int AS items,
               sum(e."signedMinor")::bigint AS "signedMinor",
               (sum(e."signedMinor") FILTER (WHERE e."component" = 'FEE'))::bigint AS "feeMinor",
               min(e."currency") AS currency,
               max(e."postedAt") AS "postedAt",
               j."businessDate"
          FROM "simcore"."SimCoreEntry" e
          JOIN "simcore"."SimCoreJournal" j ON j."id" = e."journalId"
         WHERE e."accountRef" = ${query.accountRef}
           ${query.fromDate ? Prisma.sql`AND j."businessDate" >= ${localDateToDbDate(query.fromDate)}::date` : Prisma.empty}
           ${query.toDate ? Prisma.sql`AND j."businessDate" <= ${localDateToDbDate(query.toDate)}::date` : Prisma.empty}
           ${search ? Prisma.sql`AND (j."narrative" ILIKE ${search} OR j."executionReference" ILIKE ${search})` : Prisma.empty}
         GROUP BY 1, 2, j."groupRef", j."businessDate"
      )
      SELECT * FROM lines
       ${cursor ? Prisma.sql`WHERE ("postedAt", key) < (${cursor.postedAt}, ${cursor.id})` : Prisma.empty}
       ORDER BY "postedAt" DESC, key DESC
       LIMIT ${limit + 1}`;

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(`${last.postedAt.toISOString()}|${last.key}`, "utf8").toString("base64url")
        : null;
    const postings: Posting[] = page.map((row) => ({
      lineId: row.key,
      executionReference: row.grouped ? null : row.executionReference,
      kind: row.kind,
      narrative: row.narrative,
      groupRef: row.groupRef,
      itemCount: row.grouped ? row.items : 1,
      component: row.components > 1 ? "MIXED" : row.component === "FEE" ? "FEE" : "PRINCIPAL",
      signedMinor: row.signedMinor,
      feeMinor: row.grouped ? (row.feeMinor ?? 0n) : 0n,
      currency: row.currency,
      postedAt: row.postedAt,
      businessDate: dbDateToLocalDate(row.businessDate),
    }));
    return { postings, nextCursor };
  }

  async getReconciliationExtract(context: CoreContext, businessDate: LocalDate): Promise<ReconExtractLine[]> {
    await this.assertOnline();
    const rows = await this.db.$queryRaw<
      Array<{ executionReference: string; kind: string; currency: string; postedAt: Date; principal: bigint | null; fee: bigint | null }>
    >`
      SELECT j."executionReference", j."kind", min(e."currency") AS currency, j."postedAt",
             sum(abs(e."signedMinor")) FILTER (WHERE a."kind" = 'CUSTOMER' AND e."component" = 'PRINCIPAL') AS principal,
             sum(abs(e."signedMinor")) FILTER (WHERE a."kind" = 'CUSTOMER' AND e."component" = 'FEE') AS fee
        FROM "simcore"."SimCoreJournal" j
        JOIN "simcore"."SimCoreEntry" e ON e."journalId" = j."id"
        JOIN "simcore"."SimCoreAccount" a ON a."ref" = e."accountRef"
       WHERE j."bankCode" = ${context.bankCode} AND j."businessDate" = ${localDateToDbDate(businessDate)}::date
       GROUP BY j."id"
       ORDER BY j."postedAt", j."id"`;
    const lines: ReconExtractLine[] = rows.map((row) => ({
      executionReference: row.executionReference,
      kind: row.kind,
      principalMinor: row.principal ?? 0n,
      feeMinor: row.fee ?? 0n,
      currency: row.currency,
      postedAt: row.postedAt,
    }));

    // Sandbox fixture overlays simulate a faulty EXTRACT without touching the ledger.
    const overlays = await this.db.simReconOverlay.findMany({
      where: { bankCode: context.bankCode, businessDate: localDateToDbDate(businessDate) },
    });
    let out = lines;
    for (const overlay of overlays) {
      if (overlay.kind === "HIDE") {
        out = out.filter((line) => line.executionReference !== overlay.executionReference);
      } else if (overlay.kind === "DUPLICATE") {
        const source = out.find((line) => line.executionReference === overlay.executionReference);
        if (source) out = [...out, { ...source }];
      } else if (overlay.kind === "AMOUNT_OVERRIDE" && overlay.amountMinor !== null) {
        const amount = overlay.amountMinor;
        out = out.map((line) =>
          line.executionReference === overlay.executionReference ? { ...line, principalMinor: amount } : line,
        );
      }
    }
    return out;
  }
}
