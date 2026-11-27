/**
 * Accounts, balances and statements (COR-002, RPT-01, PYR-02).
 *
 * The core adapter owns balances; this service only projects them. When the core does not
 * answer, a balance is reported as UNAVAILABLE with no figure — never as zero. Statement lines
 * come from core postings; a payroll run appears as one consolidated line per business date
 * and its per-employee postings are never returned by the core port (PYR-02).
 */
import { DomainError, notFound } from "@/contracts/errors";
import { minorToJson, type MoneyJson } from "@/contracts/money";
import { CoreUnavailableError, type Posting } from "@/server/adapters/core/port";
import { requireCorporate, requirePermission, rightsFor, type AccountRights, type AuthContext, type CorporateContext } from "@/server/auth/context";
import { addDays, businessDateOf, daysBetween, isLocalDate, type LocalDate } from "@/server/calendar";
import type { Deps } from "@/server/deps";
import type { Account } from "@/generated/prisma/client";

export const STATEMENT_DEFAULT_DAYS = 30;
export const MAX_SYNC_RANGE_DAYS = 366;

export type BalanceView = { booked: MoneyJson; available: MoneyJson; holds: MoneyJson; asOf: string };

export type AccountView = {
  id: string;
  name: string;
  nameAr: string;
  maskedNumber: string;
  currency: string;
  kind: Account["kind"];
  status: Account["status"];
  rights: AccountRights;
  /** NULL together with `balanceUnavailable: true` when the core did not answer. */
  balance: BalanceView | null;
  balanceUnavailable: boolean;
};

function coreContext(ctx: CorporateContext) {
  return { bankCode: ctx.bankCode, ownerRef: ctx.corporateCoreRef, correlationId: ctx.correlationId };
}

async function readBalance(deps: Deps, ctx: CorporateContext, account: Account): Promise<BalanceView | null> {
  try {
    const balance = await deps.core.getBalance(coreContext(ctx), account.coreAccountRef);
    return {
      booked: minorToJson(balance.bookedMinor, balance.currency),
      available: minorToJson(balance.availableMinor, balance.currency),
      holds: minorToJson(balance.holdsMinor, balance.currency),
      asOf: balance.asOf.toISOString(),
    };
  } catch (error) {
    if (error instanceof CoreUnavailableError) return null;
    throw error;
  }
}

/** Accounts the caller has a read grant on. No grant → not listed and not disclosed. */
export async function listAccounts(deps: Deps, ctx: AuthContext, options: { withBalances?: boolean } = {}): Promise<AccountView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "accounts.read");
  const readable = [...corporateCtx.grants.entries()].filter(([, rights]) => rights.read).map(([id]) => id);
  const accounts = await deps.db.account.findMany({
    where: { corporateId: corporateCtx.corporateId, id: { in: readable } },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  const out: AccountView[] = [];
  for (const account of accounts) {
    const balance = options.withBalances === false ? null : await readBalance(deps, corporateCtx, account);
    out.push({
      id: account.id,
      name: account.name,
      nameAr: account.nameAr,
      maskedNumber: account.maskedNumber,
      currency: account.currency,
      kind: account.kind,
      status: account.status,
      rights: rightsFor(corporateCtx, account.id),
      balance,
      balanceUnavailable: options.withBalances !== false && balance === null,
    });
  }
  return out;
}

async function loadReadable(deps: Deps, ctx: CorporateContext, accountId: string): Promise<Account> {
  const account = await deps.db.account.findFirst({ where: { id: accountId, corporateId: ctx.corporateId } });
  if (!account || !rightsFor(ctx, account.id).read) throw notFound();
  return account;
}

export async function getAccount(deps: Deps, ctx: AuthContext, accountId: string): Promise<AccountView> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "accounts.read");
  const account = await loadReadable(deps, corporateCtx, accountId);
  const balance = await readBalance(deps, corporateCtx, account);
  return {
    id: account.id,
    name: account.name,
    nameAr: account.nameAr,
    maskedNumber: account.maskedNumber,
    currency: account.currency,
    kind: account.kind,
    status: account.status,
    rights: rightsFor(corporateCtx, account.id),
    balance,
    balanceUnavailable: balance === null,
  };
}

/** API balance inquiry: an outage is an explicit 503, not a fabricated figure. */
export async function getBalance(deps: Deps, ctx: AuthContext, accountId: string): Promise<BalanceView & { accountId: string; stale: false }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "accounts.read");
  const account = await loadReadable(deps, corporateCtx, accountId);
  const balance = await readBalance(deps, corporateCtx, account);
  if (!balance) throw new DomainError("ADAPTER_UNAVAILABLE");
  return { accountId: account.id, ...balance, stale: false };
}

export type StatementLineKind = "PAYMENT" | "FEE" | "PAYROLL_RUN" | "TRANSFER" | "DEPOSIT" | "RETURN" | "OPENING_BALANCE" | "OTHER";

export type StatementLine = {
  lineId: string;
  postedAt: string;
  businessDate: LocalDate;
  kind: StatementLineKind;
  /** Safe description. For a payroll run: the run reference and item count only. */
  description: string;
  /** Core execution reference; absent for a consolidated payroll line. */
  reference: string | null;
  amount: MoneyJson & { direction: "DEBIT" | "CREDIT" };
  signedMinor: string;
  itemCount: number;
  /** Fee part included in a consolidated payroll line. */
  includedFee: MoneyJson | null;
  /** Payroll run this line consolidates, for the aggregate link. */
  groupRef: string | null;
};

function lineKind(posting: Posting): StatementLineKind {
  if (posting.groupRef) return "PAYROLL_RUN";
  if (posting.kind === "RETURN") return "RETURN";
  if (posting.kind === "OPENING_BALANCE") return "OPENING_BALANCE";
  if (posting.kind === "CASH_DEPOSIT" || posting.kind === "CHEQUE_DEPOSIT") return "DEPOSIT";
  if (posting.component === "FEE") return "FEE";
  if (posting.kind === "INTERNAL_TRANSFER") return "TRANSFER";
  if (posting.kind === "EXTERNAL_TRANSFER") return "PAYMENT";
  return "OTHER";
}

export function projectPosting(posting: Posting): StatementLine {
  const negative = posting.signedMinor < 0n;
  const magnitude = negative ? -posting.signedMinor : posting.signedMinor;
  return {
    lineId: posting.lineId,
    postedAt: posting.postedAt.toISOString(),
    businessDate: posting.businessDate,
    kind: lineKind(posting),
    description: posting.narrative,
    reference: posting.executionReference,
    amount: { ...minorToJson(magnitude, posting.currency), direction: negative ? "DEBIT" : "CREDIT" },
    signedMinor: posting.signedMinor.toString(),
    itemCount: posting.itemCount,
    includedFee: posting.groupRef && posting.feeMinor !== 0n ? minorToJson(posting.feeMinor < 0n ? -posting.feeMinor : posting.feeMinor, posting.currency) : null,
    groupRef: posting.groupRef,
  };
}

export type StatementQuery = {
  fromDate?: string | undefined;
  toDate?: string | undefined;
  /** `intraday` = current business date; `completed` = earlier business dates. */
  view?: "intraday" | "completed" | "all" | undefined;
  reference?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type ResolvedRange = { fromDate: LocalDate; toDate: LocalDate };

/** Validate a date range: well-formed, ordered and no longer than 366 days (RPT-01). */
export function resolveRange(deps: Deps, query: { fromDate?: string | undefined; toDate?: string | undefined }, defaultDays: number): ResolvedRange {
  const today = businessDateOf(deps.clock.now(), deps.timeZone);
  const toDate = query.toDate ?? today;
  const fromDate = query.fromDate ?? addDays(toDate, -(defaultDays - 1));
  const violations = [];
  if (!isLocalDate(fromDate)) violations.push({ field: "fromDate", rule: "date", message: "Use YYYY-MM-DD." });
  if (!isLocalDate(toDate)) violations.push({ field: "toDate", rule: "date", message: "Use YYYY-MM-DD." });
  if (violations.length === 0) {
    const span = daysBetween(fromDate, toDate);
    if (span < 0) violations.push({ field: "toDate", rule: "order", message: "The end date is before the start date." });
    else if (span + 1 > MAX_SYNC_RANGE_DAYS) violations.push({ field: "toDate", rule: "maxRange", message: `A query can cover at most ${MAX_SYNC_RANGE_DAYS} days.` });
  }
  if (violations.length > 0) throw new DomainError("VALIDATION_FAILED", { violations });
  return { fromDate, toDate };
}

export async function getStatement(
  deps: Deps,
  ctx: AuthContext,
  accountId: string,
  query: StatementQuery,
): Promise<{ account: { id: string; name: string; nameAr: string; maskedNumber: string; currency: string }; range: ResolvedRange; businessTimeZone: string; lines: StatementLine[]; nextCursor: string | null; asOf: string }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "accounts.read");
  const account = await loadReadable(deps, corporateCtx, accountId);
  const today = businessDateOf(deps.clock.now(), deps.timeZone);
  let range = resolveRange(deps, query, STATEMENT_DEFAULT_DAYS);
  if (query.view === "intraday") range = { fromDate: today, toDate: today };
  else if (query.view === "completed" && range.toDate >= today) range = { fromDate: range.fromDate, toDate: addDays(today, -1) };
  if (range.toDate < range.fromDate) {
    return { account: accountSummary(account), range, businessTimeZone: deps.timeZone, lines: [], nextCursor: null, asOf: deps.clock.now().toISOString() };
  }
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  try {
    const page = await deps.core.getPostings(coreContext(corporateCtx), {
      accountRef: account.coreAccountRef,
      fromDate: range.fromDate,
      toDate: range.toDate,
      ...(query.reference ? { search: query.reference } : {}),
      cursor: query.cursor ?? null,
      limit,
    });
    return {
      account: accountSummary(account),
      range,
      businessTimeZone: deps.timeZone,
      lines: page.postings.map(projectPosting),
      nextCursor: page.nextCursor,
      asOf: deps.clock.now().toISOString(),
    };
  } catch (error) {
    if (error instanceof CoreUnavailableError) throw new DomainError("ADAPTER_UNAVAILABLE");
    throw error;
  }
}

function accountSummary(account: Account) {
  return { id: account.id, name: account.name, nameAr: account.nameAr, maskedNumber: account.maskedNumber, currency: account.currency };
}
