/**
 * Branch deposits by customer code (COL-02, COL-03).
 *
 * - A teller names the corporate AND the customer code explicitly; the code alone never
 *   identifies who is credited. Bank and branch come from the teller's verified session.
 * - An amount strictly above the agreement's manager threshold waits for a DIFFERENT branch
 *   manager of the same branch. Nothing is credited before that decision.
 * - Capture never credits. The worker books through the core port under one stable reference;
 *   an unanswered booking is resolved by inquiry, never by sending a second instruction.
 * - A cheque is credited only after the (simulated) clearing event; a returned cheque never
 *   credits. Duplicate clearing events have no second effect.
 */
import { depositIntakeSchema } from "@/contracts/collections";
import { maskAccountReference } from "@/contracts/common";
import { DomainError, conflict, denied, notFound } from "@/contracts/errors";
import { formatMinorGrouped, minorToJson, type Currency, type MoneyJson } from "@/contracts/money";
import { MESSAGES } from "@/i18n/messages";
import { addDays, businessDateOf, dbDateToLocalDate, localDateToDbDate, startOfBusinessDay } from "@/lib/calendar";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { addTimeline, timelineActor, writeAudit } from "@/server/audit/audit";
import { readableAccountIds, requireBank, requireCorporate, requirePermission, requirePerson, type AuthContext, type BankContext } from "@/server/auth/context";
import { inTx, type Prisma, type Tx } from "@/server/db/client";
import { nextSequence } from "@/server/db/sequence";
import type { Deps } from "@/server/deps";
import { requireEffectivePolicy, requireEntitlement, type EffectivePolicy } from "@/server/domain/agreements/policy";
import { createApprovalRequest, getApproval, type ApprovalView } from "@/server/domain/approvals/service";
import { PdfBuilder } from "@/server/files/pdf";
import { downloadResponse } from "@/server/files/storage";
import { digestOf } from "@/server/hash";
import { enqueueJob } from "@/server/jobs/queue";
import { notify, corporateRecipients } from "@/server/notifications/notify";
import { emitEvent } from "@/server/outbox";
import type { Deposit } from "@/generated/prisma/client";

export const JOB_DEPOSIT_POST = "deposit.post";
export const JOB_DEPOSIT_INQUIRE = "deposit.inquire";
export const DEPOSIT_MODULE = "3.2";
const TYPE = { CASH: "BRANCH_CASH_DEPOSIT", CHEQUE: "BRANCH_CHEQUE_DEPOSIT" } as const;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 366;

export type DepositView = {
  id: string;
  intakeReference: string;
  state: Deposit["state"];
  method: Deposit["method"];
  amount: MoneyJson;
  allocated: MoneyJson;
  remaining: MoneyJson;
  customer: { id: string; code: string; displayName: string };
  corporate: { id: string; name: string; nameAr: string };
  creditAccount: { id: string; name: string; nameAr: string; maskedNumber: string };
  branch: { id: string; code: string; name: string; nameAr: string };
  depositorReference: string;
  chequeReference: string | null;
  requiresManager: boolean;
  /** Review flag for a large cash intake. A flag for the bank, not a regulatory filing. */
  cashReviewFlag: boolean;
  executionReference: string | null;
  postedAt: string | null;
  businessDate: string | null;
  returnReason: string | null;
  failureCode: string | null;
  receipt: { kind: "PENDING_ACKNOWLEDGMENT" | "POSTED"; reference: string } | null;
  version: number;
  createdAt: string;
};

export type DepositDetail = DepositView & {
  approval: ApprovalView | null;
  timeline: Array<{ at: string; code: string; fromState: string | null; toState: string | null; actor: string | null; reference: string | null; detail: unknown }>;
};

/** Signed deposit terms of the agreement. Absent terms fail closed: no threshold is invented. */
function depositTerms(policy: EffectivePolicy): NonNullable<EffectivePolicy["terms"]["depositPolicy"]> {
  const terms = policy.terms.depositPolicy;
  if (!terms) throw new DomainError("MODULE_DISABLED", { violations: [{ rule: "depositPolicy", code: DEPOSIT_MODULE }] });
  return terms;
}

async function lockDeposit(tx: Tx, depositId: string): Promise<Deposit | null> {
  await tx.$queryRaw`SELECT "id" FROM "Deposit" WHERE "id" = ${depositId}::uuid FOR UPDATE`;
  return tx.deposit.findUnique({ where: { id: depositId } });
}

/** Teller or manager of the SAME bank and the SAME branch as the deposit. */
function requireBranchStaff(ctx: AuthContext, deposit: Pick<Deposit, "bankId" | "branchId">): BankContext {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.deposits.read");
  if (bankCtx.bankId !== deposit.bankId || bankCtx.branchId === null || bankCtx.branchId !== deposit.branchId) throw notFound();
  return bankCtx;
}

async function toViews(deps: Deps, deposits: Deposit[], audience: "BANK" | "CORPORATE"): Promise<DepositView[]> {
  if (deposits.length === 0) return [];
  const unique = <T,>(values: T[]) => [...new Set(values)];
  const [customers, corporates, accounts, branches, receipts] = await Promise.all([
    deps.db.customer.findMany({ where: { id: { in: unique(deposits.map((deposit) => deposit.customerId)) } }, select: { id: true, code: true, displayName: true } }),
    deps.db.corporate.findMany({ where: { id: { in: unique(deposits.map((deposit) => deposit.corporateId)) } }, select: { id: true, legalName: true, legalNameAr: true } }),
    deps.db.account.findMany({ where: { id: { in: unique(deposits.map((deposit) => deposit.creditAccountId)) } }, select: { id: true, name: true, nameAr: true, maskedNumber: true } }),
    deps.db.branch.findMany({ where: { id: { in: unique(deposits.map((deposit) => deposit.branchId)) } }, select: { id: true, code: true, name: true, nameAr: true } }),
    deps.db.receipt.findMany({ where: { depositId: { in: deposits.map((deposit) => deposit.id) } }, orderBy: { issuedAt: "asc" } }),
  ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
  const customerById = by(customers);
  const corporateById = by(corporates);
  const accountById = by(accounts);
  const branchById = by(branches);
  return deposits.map((deposit) => {
    const customer = customerById.get(deposit.customerId);
    const corporate = corporateById.get(deposit.corporateId);
    const account = accountById.get(deposit.creditAccountId);
    const branch = branchById.get(deposit.branchId);
    const own = receipts.filter((receipt) => receipt.depositId === deposit.id);
    const receipt = own.find((entry) => entry.kind === "POSTED") ?? own.find((entry) => entry.kind === "PENDING_ACKNOWLEDGMENT") ?? null;
    return {
      id: deposit.id,
      intakeReference: deposit.intakeReference,
      state: deposit.state,
      method: deposit.method,
      amount: minorToJson(deposit.amountMinor, deposit.currency),
      allocated: minorToJson(deposit.allocatedMinor, deposit.currency),
      remaining: minorToJson(deposit.state === "POSTED" ? deposit.amountMinor - deposit.allocatedMinor : 0n, deposit.currency),
      customer: { id: deposit.customerId, code: customer?.code ?? "", displayName: customer?.displayName ?? "" },
      corporate: { id: deposit.corporateId, name: corporate?.legalName ?? "", nameAr: corporate?.legalNameAr ?? "" },
      creditAccount: { id: deposit.creditAccountId, name: account?.name ?? "", nameAr: account?.nameAr ?? "", maskedNumber: account?.maskedNumber ?? "" },
      branch: { id: deposit.branchId, code: branch?.code ?? "", name: branch?.name ?? "", nameAr: branch?.nameAr ?? "" },
      depositorReference: deposit.depositorReference,
      chequeReference: deposit.chequeReference,
      requiresManager: deposit.requiresManager,
      cashReviewFlag: audience === "BANK" ? deposit.cashReviewFlag : false,
      // The posting reference appears once something was actually booked.
      executionReference: deposit.state === "POSTED" ? deposit.executionReference : null,
      postedAt: deposit.postedAt?.toISOString() ?? null,
      businessDate: deposit.businessDate ? dbDateToLocalDate(deposit.businessDate) : null,
      returnReason: deposit.returnReason,
      failureCode: deposit.failureCode,
      receipt: receipt ? { kind: receipt.kind, reference: receipt.reference } : null,
      version: deposit.version,
      createdAt: deposit.createdAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Teller: lookup and capture
// ---------------------------------------------------------------------------------------------

function requireTeller(ctx: AuthContext): BankContext & { branchId: string } {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.teller.capture");
  requirePerson(bankCtx);
  if (bankCtx.branchId === null) throw denied();
  return bankCtx as BankContext & { branchId: string };
}

/** Corporates of the teller's bank that currently accept branch deposits. Names only. */
export async function listTellerCorporates(deps: Deps, ctx: AuthContext): Promise<Array<{ id: string; name: string; nameAr: string }>> {
  const teller = requireTeller(ctx);
  const corporates = await deps.db.corporate.findMany({ where: { bankId: teller.bankId, agreement: { status: "ACTIVE" } }, select: { id: true, legalName: true, legalNameAr: true }, orderBy: { legalName: "asc" }, take: 200 });
  return corporates.map((corporate) => ({ id: corporate.id, name: corporate.legalName, nameAr: corporate.legalNameAr }));
}

export type CustomerLookup = {
  corporate: { id: string; name: string; nameAr: string };
  customer: { code: string; displayName: string; company: string };
  creditAccounts: Array<{ id: string; name: string; nameAr: string; maskedNumber: string }>;
  perDepositCap: MoneyJson;
  managerThreshold: MoneyJson;
};

/**
 * Resolve corporate + customer code for confirmation at the counter. An unknown corporate, a
 * corporate of another bank and an unknown code all answer the same way.
 */
export async function lookupCustomer(deps: Deps, ctx: AuthContext, query: { corporateId: string; customerCode: string }): Promise<CustomerLookup> {
  const teller = requireTeller(ctx);
  const corporate = await deps.db.corporate.findFirst({ where: { id: query.corporateId, bankId: teller.bankId } });
  if (!corporate) throw notFound();
  const policy = await requireEffectivePolicy(deps.db, corporate.id, deps.clock.now());
  const entitlement = requireEntitlement(policy, { moduleId: DEPOSIT_MODULE });
  const customer = await deps.db.customer.findFirst({ where: { corporateId: corporate.id, code: query.customerCode, archivedAt: null } });
  if (!customer) throw notFound();
  const accounts = await deps.db.account.findMany({ where: { corporateId: corporate.id, id: { in: [...entitlement.creditAccountIds] }, status: "ACTIVE" }, orderBy: { name: "asc" } });
  return {
    corporate: { id: corporate.id, name: corporate.legalName, nameAr: corporate.legalNameAr },
    customer: { code: customer.code, displayName: customer.displayName, company: customer.company },
    creditAccounts: accounts.map((account) => ({ id: account.id, name: account.name, nameAr: account.nameAr, maskedNumber: account.maskedNumber })),
    perDepositCap: minorToJson(BigInt(depositTerms(policy).perDepositCapMinor), "LYD"),
    managerThreshold: minorToJson(BigInt(depositTerms(policy).managerThresholdMinor), "LYD"),
  };
}

export async function captureDeposit(deps: Deps, ctx: AuthContext, rawInput: unknown, depositId: string): Promise<void> {
  const teller = requireTeller(ctx);
  const person = requirePerson(teller);
  const input = depositIntakeSchema.parse(rawInput);
  // The requested branch must be the teller's own; the body cannot widen it.
  if (input.branchId !== teller.branchId) throw denied();
  const corporate = await deps.db.corporate.findFirst({ where: { id: input.corporateId, bankId: teller.bankId } });
  if (!corporate) throw notFound();
  if (input.amount.currency !== "LYD") throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "amount", rule: "currency", message: "Branch deposits are in LYD." }] });
  const now = deps.clock.now();
  const amount = BigInt(input.amount.minor);
  const transactionType = TYPE[input.method];

  const policy = await requireEffectivePolicy(deps.db, corporate.id, now);
  requireEntitlement(policy, { moduleId: DEPOSIT_MODULE, transactionType, creditAccountId: input.creditAccountId });
  const terms = depositTerms(policy);
  const typeCap = policy.rules.find((rule) => rule.scope === "TYPE" && rule.metric === "AMOUNT" && rule.period === "ITEM" && rule.transactionType === transactionType)?.valueMinor ?? null;
  const cap = typeCap !== null && typeCap < BigInt(terms.perDepositCapMinor) ? typeCap : BigInt(terms.perDepositCapMinor);
  if (amount > cap) throw new DomainError("MODULE_LIMIT_EXCEEDED", { violations: [{ field: "amount", rule: "deposit.perItem", limitMinor: cap.toString() }] });

  const customer = await deps.db.customer.findFirst({ where: { corporateId: corporate.id, code: input.customerCode, archivedAt: null } });
  if (!customer) throw notFound();
  const account = await deps.db.account.findFirst({ where: { id: input.creditAccountId, corporateId: corporate.id } });
  if (!account || account.status !== "ACTIVE" || account.currency !== "LYD") throw new DomainError("ACCOUNT_NOT_ALLOWED");
  const branch = await deps.db.branch.findFirst({ where: { id: teller.branchId, bankId: teller.bankId, active: true } });
  if (!branch) throw denied();

  // Strictly above the threshold: exactly the threshold does not need a manager (I-36).
  const requiresManager = amount > BigInt(terms.managerThresholdMinor);
  const cashReviewFlag = input.method === "CASH" && amount >= BigInt(terms.cashReviewThresholdMinor);
  const today = businessDateOf(now, deps.timeZone);
  const contentHash = digestOf({
    corporateId: corporate.id,
    customerId: customer.id,
    creditAccountId: account.id,
    branchId: branch.id,
    method: input.method,
    amountMinor: amount.toString(),
    depositorReference: input.depositorReference.toUpperCase(),
    chequeReference: input.chequeReference?.toUpperCase() ?? null,
    businessDate: today,
  });
  const state: Deposit["state"] = requiresManager ? "PENDING_MANAGER" : input.method === "CASH" ? "PENDING_POSTING" : "ACCEPTED_PENDING_CLEARING";

  await inTx(deps.db, async (tx) => {
    // Identical intakes on the same business day are serialized and the second is refused,
    // whatever idempotency key it carries.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${contentHash}, 0))`;
    const twin = await tx.deposit.findFirst({ where: { contentHash, state: { notIn: ["REJECTED", "CANCELLED", "RETURNED"] } }, select: { intakeReference: true } });
    if (twin) {
      throw new DomainError("DUPLICATE_RESOURCE", { detail: "The same deposit was already captured today.", violations: [{ field: "depositorReference", rule: "duplicateIntake", message: "The same deposit was already captured today.", reference: twin.intakeReference }] });
    }
    const sequence = await nextSequence(tx, `DEP:${branch.id}:${today.slice(0, 4)}`);
    const intakeReference = `DEP-${branch.code}-${today.slice(0, 4)}-${sequence.toString().padStart(6, "0")}`;
    const executionReference = `AQ${crypto.randomUUID().replaceAll("-", "").toUpperCase()}D1`;
    await tx.deposit.create({
      data: {
        id: depositId,
        bankId: teller.bankId,
        corporateId: corporate.id,
        customerId: customer.id,
        branchId: branch.id,
        creditAccountId: account.id,
        method: input.method,
        amountMinor: amount,
        currency: "LYD",
        depositorReference: input.depositorReference.toUpperCase(),
        chequeReference: input.chequeReference?.toUpperCase() ?? null,
        intakeReference,
        state,
        requiresManager,
        cashReviewFlag,
        contentHash,
        tellerPersonId: person.personId,
        executionReference,
        // Business time of the intake (the injected clock), so date windows follow the bank day.
        createdAt: now,
      },
    });
    if (customer.referencedAt === null) await tx.customer.update({ where: { id: customer.id }, data: { referencedAt: now } });
    // An acknowledgment of intake — explicitly not a statement that funds were credited.
    await tx.receipt.create({ data: { bankId: teller.bankId, corporateId: corporate.id, depositId, kind: "PENDING_ACKNOWLEDGMENT", reference: `ACK-${intakeReference}`, issuedAt: now } });
    if (requiresManager) {
      const request = await createApprovalRequest(tx, {
        bankId: teller.bankId,
        corporateId: corporate.id,
        klass: "BRANCH_DEPOSIT",
        targetType: "deposit",
        targetId: depositId,
        targetRevision: 1,
        payloadHash: contentHash,
        summary: {
          kind: "DEPOSIT",
          reference: intakeReference,
          title: corporate.legalName,
          linkPath: `/bank/deposits/${depositId}`,
          method: input.method,
          amount: { currency: "LYD", minor: amount.toString() },
          corporateName: corporate.legalName,
          corporateNameAr: corporate.legalNameAr,
          customerCode: customer.code,
          customerName: customer.displayName,
          creditAccount: { name: account.name, nameAr: account.nameAr, maskedNumber: account.maskedNumber },
          branchCode: branch.code,
          depositorReference: input.depositorReference.toUpperCase(),
          chequeReference: input.chequeReference?.toUpperCase() ?? null,
          cashReviewFlag,
        },
        makerPersonId: person.personId,
        requiredApprovals: 1,
        branchId: branch.id,
        amountMinor: amount,
        currency: "LYD",
        expiresAt: new Date(now.getTime() + deps.settings.approvalValidityDays * 86_400_000),
      });
      await tx.deposit.update({ where: { id: depositId }, data: { approvalRequestId: request.id } });
    } else if (input.method === "CASH") {
      await enqueueJob(tx, { type: JOB_DEPOSIT_POST, payload: { depositId }, dedupKey: `deposit-post:${depositId}`, bankId: teller.bankId, corporateId: corporate.id, aggregateType: "deposit", aggregateId: depositId, correlationId: teller.correlationId });
    }
    await addTimeline(tx, { at: now, bankId: teller.bankId, corporateId: corporate.id, aggregateType: "deposit", aggregateId: depositId, code: "DEPOSIT_CAPTURED", toState: state, ...timelineActor(teller), reference: intakeReference });
    await writeAudit(tx, teller, {
      action: "deposit.captured",
      targetType: "deposit",
      targetId: depositId,
      corporateId: corporate.id,
      changes: { reference: intakeReference, method: input.method, amountMinor: amount.toString(), customerCode: customer.code, branchCode: branch.code, requiresManager, cashReviewFlag, state },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Manager decision (unified approvals, class BRANCH_DEPOSIT)
// ---------------------------------------------------------------------------------------------

export const depositApprovalTarget = {
  checkVoter: async (tx: Tx, request: { id: string; targetId: string }, ctx: AuthContext, deps: Deps) => {
    const deposit = await lockDeposit(tx, request.targetId);
    if (!deposit || deposit.state !== "PENDING_MANAGER" || deposit.approvalRequestId !== request.id) throw conflict("This deposit is no longer awaiting a decision.");
    // Only a manager assigned to the deposit's own branch decides it.
    const bankCtx = requireBank(ctx);
    if (bankCtx.bankId !== deposit.bankId || bankCtx.branchId === null || bankCtx.branchId !== deposit.branchId) throw denied();
    // The agreement must still cover this deposit at decision time.
    const policy = await requireEffectivePolicy(tx, deposit.corporateId, deps.clock.now());
    requireEntitlement(policy, { moduleId: DEPOSIT_MODULE, transactionType: TYPE[deposit.method], creditAccountId: deposit.creditAccountId });
  },
  onApproved: async (tx: Tx, request: { targetId: string }, ctx: AuthContext, deps: Deps) => {
    const deposit = (await lockDeposit(tx, request.targetId)) as Deposit;
    const next: Deposit["state"] = deposit.method === "CASH" ? "PENDING_POSTING" : "ACCEPTED_PENDING_CLEARING";
    await tx.deposit.update({ where: { id: deposit.id }, data: { state: next, managerPersonId: ctx.principal.kind === "person" ? ctx.principal.personId : null, version: { increment: 1 } } });
    if (deposit.method === "CASH") {
      await enqueueJob(tx, { type: JOB_DEPOSIT_POST, payload: { depositId: deposit.id }, dedupKey: `deposit-post:${deposit.id}`, bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: deposit.id, correlationId: ctx.correlationId });
    }
    await addTimeline(tx, { at: deps.clock.now(), bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: deposit.id, code: "DEPOSIT_MANAGER_APPROVED", fromState: "PENDING_MANAGER", toState: next, ...timelineActor(ctx), reference: deposit.intakeReference });
  },
  onRejected: async (tx: Tx, request: { targetId: string }, ctx: AuthContext, deps: Deps, reason: string) => {
    const deposit = (await lockDeposit(tx, request.targetId)) as Deposit;
    await tx.deposit.update({ where: { id: deposit.id }, data: { state: "REJECTED", managerPersonId: ctx.principal.kind === "person" ? ctx.principal.personId : null, version: { increment: 1 } } });
    await addTimeline(tx, { at: deps.clock.now(), bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: deposit.id, code: "DEPOSIT_MANAGER_REJECTED", fromState: "PENDING_MANAGER", toState: "REJECTED", ...timelineActor(ctx), reference: deposit.intakeReference, detail: { reason } });
  },
  onExpired: async (tx: Tx, request: { id: string; targetId: string }, deps: Deps) => {
    const deposit = await lockDeposit(tx, request.targetId);
    if (!deposit || deposit.state !== "PENDING_MANAGER" || deposit.approvalRequestId !== request.id) return;
    await tx.deposit.update({ where: { id: deposit.id }, data: { state: "CANCELLED", version: { increment: 1 } } });
    await addTimeline(tx, { at: deps.clock.now(), bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: deposit.id, code: "DEPOSIT_EXPIRED", fromState: "PENDING_MANAGER", toState: "CANCELLED", actorService: "maintenance", reference: deposit.intakeReference });
  },
};

// ---------------------------------------------------------------------------------------------
// Posting (worker) and cheque clearing
// ---------------------------------------------------------------------------------------------

/** Record a confirmed booking exactly once: state, posted receipt, event and notification. */
async function markPosted(tx: Tx, deps: Deps, deposit: Deposit, booking: { coreReference: string; bookedAt: Date; businessDate: string }): Promise<void> {
  await tx.deposit.update({ where: { id: deposit.id }, data: { state: "POSTED", coreReference: booking.coreReference, postedAt: booking.bookedAt, businessDate: localDateToDbDate(booking.businessDate), failureCode: null, version: { increment: 1 } } });
  const acknowledgment = await tx.receipt.findUnique({ where: { depositId_kind: { depositId: deposit.id, kind: "PENDING_ACKNOWLEDGMENT" } } });
  await tx.receipt.createMany({ data: [{ bankId: deposit.bankId, corporateId: deposit.corporateId, depositId: deposit.id, kind: "POSTED", reference: `RCP-${deposit.intakeReference}`, supersedesReceiptId: acknowledgment?.id ?? null, issuedAt: booking.bookedAt }], skipDuplicates: true });
  await addTimeline(tx, { at: booking.bookedAt, bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: deposit.id, code: "DEPOSIT_POSTED", fromState: deposit.state, toState: "POSTED", actorService: "worker", reference: deposit.executionReference });
  await tx.auditEvent.create({
    data: { bankId: deposit.bankId, corporateId: deposit.corporateId, actorKind: "SERVICE", actorService: "worker", action: "deposit.posted", targetType: "deposit", targetId: deposit.id, changes: { before: deposit.state, after: "POSTED", reference: deposit.intakeReference, executionReference: deposit.executionReference, amountMinor: deposit.amountMinor.toString() }, result: "SUCCESS" },
  });
  await emitEvent(tx, { bankId: deposit.bankId, corporateId: deposit.corporateId, type: "deposit.posted", data: { resourceId: deposit.id, reference: deposit.intakeReference, state: "POSTED", method: deposit.method, amountMinor: deposit.amountMinor.toString(), currency: deposit.currency }, dedupKey: `deposit:${deposit.id}:POSTED`, occurredAt: booking.bookedAt });
  await notify(tx, { bankId: deposit.bankId, corporateId: deposit.corporateId, recipientPersonIds: await corporateRecipients(tx, deposit.corporateId, ["FINANCE"]), eventKey: `deposit:${deposit.id}:POSTED`, kind: "deposit.posted", params: { reference: deposit.intakeReference }, linkPath: `/deposits/${deposit.id}` });
}

export type PostOutcome = { kind: "done" } | { kind: "retry"; at: Date } | { kind: "inquire"; at: Date };

/**
 * Worker step. The adapter call is made outside any platform transaction and always with the
 * deposit's one stable reference, so a crash, a retry or a second worker can never credit twice.
 */
export async function postDeposit(deps: Deps, depositId: string): Promise<PostOutcome> {
  const deposit = await deps.db.deposit.findUnique({ where: { id: depositId } });
  if (!deposit || deposit.state !== "PENDING_POSTING") return { kind: "done" };
  const [account, branch, bank, customer] = await Promise.all([
    deps.db.account.findUniqueOrThrow({ where: { id: deposit.creditAccountId } }),
    deps.db.branch.findUniqueOrThrow({ where: { id: deposit.branchId } }),
    deps.db.bank.findUniqueOrThrow({ where: { id: deposit.bankId }, select: { code: true } }),
    deps.db.customer.findUniqueOrThrow({ where: { id: deposit.customerId }, select: { code: true } }),
  ]);
  const base = { executionReference: deposit.executionReference, currency: deposit.currency, narrative: `Deposit ${deposit.intakeReference} ${customer.code}`, creditAccountRef: account.coreAccountRef, amountMinor: deposit.amountMinor };
  let result;
  try {
    result = await deps.core.execute(
      { bankCode: bank.code, correlationId: `deposit_${deposit.id}` },
      deposit.method === "CASH" ? { ...base, type: "CASH_DEPOSIT", branchCashAccountRef: branch.cashAccountRef } : { ...base, type: "CHEQUE_DEPOSIT" },
    );
  } catch (error) {
    if (error instanceof CoreUnavailableError) return { kind: "retry", at: new Date(deps.clock.now().getTime() + 30_000) };
    throw error;
  }
  if (result.kind === "rejected" && result.retryable) return { kind: "retry", at: new Date(deps.clock.now().getTime() + 30_000) };
  const inquireAt = new Date(deps.clock.now().getTime() + deps.settings.autoInquiryDelaySeconds * 1000);
  const outcome = result;
  await inTx(
    deps.db,
    async (tx) => {
      const current = await lockDeposit(tx, depositId);
      if (!current || current.state !== "PENDING_POSTING") return;
      if (outcome.kind === "confirmed") {
        await markPosted(tx, deps, current, outcome);
      } else if (outcome.kind === "unknown") {
        // No answer: the result is unknown, not failed. It is resolved by inquiry only.
        await tx.deposit.update({ where: { id: depositId }, data: { state: "STATUS_UNKNOWN", version: { increment: 1 } } });
        await addTimeline(tx, { at: deps.clock.now(), bankId: current.bankId, corporateId: current.corporateId, aggregateType: "deposit", aggregateId: depositId, code: "DEPOSIT_STATUS_UNKNOWN", fromState: "PENDING_POSTING", toState: "STATUS_UNKNOWN", actorService: "worker", reference: current.executionReference });
        await enqueueJob(tx, { type: JOB_DEPOSIT_INQUIRE, payload: { depositId }, dedupKey: `deposit-inquire:${depositId}`, availableAt: inquireAt, bankId: current.bankId, corporateId: current.corporateId, aggregateType: "deposit", aggregateId: depositId });
      } else {
        await tx.deposit.update({ where: { id: depositId }, data: { state: "REJECTED", failureCode: outcome.code, version: { increment: 1 } } });
        await addTimeline(tx, { at: deps.clock.now(), bankId: current.bankId, corporateId: current.corporateId, aggregateType: "deposit", aggregateId: depositId, code: "DEPOSIT_POSTING_REJECTED", fromState: "PENDING_POSTING", toState: "REJECTED", actorService: "worker", reference: current.executionReference, detail: { failureCode: outcome.code } });
        await tx.auditEvent.create({ data: { bankId: current.bankId, corporateId: current.corporateId, actorKind: "SERVICE", actorService: "worker", action: "deposit.posting.rejected", targetType: "deposit", targetId: depositId, changes: { reference: current.intakeReference, failureCode: outcome.code }, result: "FAILED" } });
      }
    },
    { skipIdempotency: true },
  );
  return outcome.kind === "unknown" ? { kind: "inquire", at: inquireAt } : { kind: "done" };
}

/** Ask the core about the original reference. Posted → POSTED; not found → the same reference is sent again. */
export async function inquireDeposit(deps: Deps, depositId: string): Promise<PostOutcome> {
  const deposit = await deps.db.deposit.findUnique({ where: { id: depositId } });
  if (!deposit || deposit.state !== "STATUS_UNKNOWN") return { kind: "done" };
  const bank = await deps.db.bank.findUniqueOrThrow({ where: { id: deposit.bankId }, select: { code: true } });
  let result;
  try {
    result = await deps.core.inquire({ bankCode: bank.code, correlationId: `deposit_${deposit.id}` }, deposit.executionReference);
  } catch (error) {
    if (error instanceof CoreUnavailableError) return { kind: "retry", at: new Date(deps.clock.now().getTime() + 30_000) };
    throw error;
  }
  const answer = result;
  await inTx(
    deps.db,
    async (tx) => {
      const current = await lockDeposit(tx, depositId);
      if (!current || current.state !== "STATUS_UNKNOWN") return;
      await tx.deposit.update({ where: { id: depositId }, data: { inquiryCount: { increment: 1 } } });
      if (answer.kind === "posted") {
        await markPosted(tx, deps, current, answer);
      } else {
        // The core has no posting under this reference: sending the SAME reference again is safe.
        await tx.deposit.update({ where: { id: depositId }, data: { state: "PENDING_POSTING", version: { increment: 1 } } });
        await addTimeline(tx, { at: deps.clock.now(), bankId: current.bankId, corporateId: current.corporateId, aggregateType: "deposit", aggregateId: depositId, code: "DEPOSIT_INQUIRY_NOT_FOUND", fromState: "STATUS_UNKNOWN", toState: "PENDING_POSTING", actorService: "worker", reference: current.executionReference });
        await enqueueJob(tx, { type: JOB_DEPOSIT_POST, payload: { depositId }, dedupKey: `deposit-post:${depositId}`, bankId: current.bankId, corporateId: current.corporateId, aggregateType: "deposit", aggregateId: depositId });
      }
    },
    { skipIdempotency: true },
  );
  return { kind: "done" };
}

/**
 * A clearing-house event for a cheque (simulated; sent by the sandbox operator). Applied only
 * to a deposit that is still waiting for clearing, so a duplicate or late event does nothing.
 */
export async function applyChequeEvent(deps: Deps, ctx: AuthContext, depositId: string, event: { outcome: "CLEARED" | "RETURNED"; reason: string }): Promise<{ applied: boolean }> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.simulator.control");
  return inTx(deps.db, async (tx) => {
    const deposit = await lockDeposit(tx, depositId);
    if (!deposit || deposit.bankId !== bankCtx.bankId || deposit.method !== "CHEQUE") throw notFound();
    const applied = deposit.state === "ACCEPTED_PENDING_CLEARING";
    const now = deps.clock.now();
    if (applied && event.outcome === "CLEARED") {
      await tx.deposit.update({ where: { id: depositId }, data: { state: "PENDING_POSTING", version: { increment: 1 } } });
      await enqueueJob(tx, { type: JOB_DEPOSIT_POST, payload: { depositId }, dedupKey: `deposit-post:${depositId}`, bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: depositId, correlationId: bankCtx.correlationId });
      await addTimeline(tx, { at: now, bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: depositId, code: "DEPOSIT_CHEQUE_CLEARED", fromState: deposit.state, toState: "PENDING_POSTING", actorService: "simulator", reference: deposit.intakeReference });
    } else if (applied) {
      // Returned before clearing: there was never a credit and there never will be one.
      await tx.deposit.update({ where: { id: depositId }, data: { state: "RETURNED", returnReason: event.reason, version: { increment: 1 } } });
      await addTimeline(tx, { at: now, bankId: deposit.bankId, corporateId: deposit.corporateId, aggregateType: "deposit", aggregateId: depositId, code: "DEPOSIT_CHEQUE_RETURNED", fromState: deposit.state, toState: "RETURNED", actorService: "simulator", reference: deposit.intakeReference, detail: { reason: event.reason } });
      await notify(tx, { bankId: deposit.bankId, corporateId: deposit.corporateId, recipientPersonIds: await corporateRecipients(tx, deposit.corporateId, ["FINANCE"]), eventKey: `deposit:${depositId}:RETURNED`, kind: "deposit.returned", params: { reference: deposit.intakeReference }, linkPath: `/deposits/${depositId}` });
    }
    await writeAudit(tx, bankCtx, { action: "simulator.cheque.event", targetType: "deposit", targetId: depositId, reason: event.reason, changes: { reference: deposit.intakeReference, outcome: event.outcome, applied }, result: "SUCCESS" });
    return { applied };
  });
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

type ListQuery = { customerId?: string | undefined; state?: string | undefined; fromDate?: string | undefined; toDate?: string | undefined; cursor?: string | undefined; limit?: number | undefined };

/** Deposits of the caller's corporate for accounts they may read. Default window: 90 days. */
export async function listDeposits(deps: Deps, ctx: AuthContext, query: ListQuery = {}): Promise<{ items: DepositView[]; nextCursor: string | null; window: { fromDate: string; toDate: string } }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "deposits.read");
  const today = businessDateOf(deps.clock.now(), deps.timeZone);
  const toDate = query.toDate ?? today;
  const fromDate = query.fromDate ?? addDays(toDate, -DEFAULT_WINDOW_DAYS);
  const days = (new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86_400_000;
  if (days < 0 || days > MAX_WINDOW_DAYS) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "fromDate", rule: "range", message: "Choose a range of at most 366 days." }] });
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const where: Prisma.DepositWhereInput = {
    corporateId: corporateCtx.corporateId,
    creditAccountId: { in: readableAccountIds(corporateCtx) },
    createdAt: { gte: startOfBusinessDay(fromDate, deps.timeZone), lt: startOfBusinessDay(addDays(toDate, 1), deps.timeZone) },
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.state ? { state: query.state as Deposit["state"] } : {}),
  };
  const rows = await deps.db.deposit.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
  const page = rows.slice(0, limit);
  return { items: await toViews(deps, page, "CORPORATE"), nextCursor: rows.length > limit ? (page[page.length - 1] as Deposit).id : null, window: { fromDate, toDate } };
}

/** Deposits of the caller's own branch (teller and manager). */
export async function listBranchDeposits(deps: Deps, ctx: AuthContext, query: { state?: string | undefined; cursor?: string | undefined; limit?: number | undefined } = {}): Promise<{ items: DepositView[]; nextCursor: string | null }> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.deposits.read");
  if (bankCtx.branchId === null) throw denied();
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const rows = await deps.db.deposit.findMany({
    where: { bankId: bankCtx.bankId, branchId: bankCtx.branchId, ...(query.state ? { state: query.state as Deposit["state"] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return { items: await toViews(deps, page, "BANK"), nextCursor: rows.length > limit ? (page[page.length - 1] as Deposit).id : null };
}

/** One deposit for a corporate reader of its account, or for staff of its branch. */
async function loadAuthorized(deps: Deps, ctx: AuthContext, depositId: string): Promise<{ deposit: Deposit; audience: "BANK" | "CORPORATE" }> {
  const deposit = await deps.db.deposit.findUnique({ where: { id: depositId } });
  if (!deposit) throw notFound();
  if (ctx.workspace === "BANK") {
    requireBranchStaff(ctx, deposit);
    return { deposit, audience: "BANK" };
  }
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "deposits.read");
  if (deposit.corporateId !== corporateCtx.corporateId || !readableAccountIds(corporateCtx).includes(deposit.creditAccountId)) throw notFound();
  return { deposit, audience: "CORPORATE" };
}

export async function getDeposit(deps: Deps, ctx: AuthContext, depositId: string): Promise<DepositDetail> {
  const { deposit, audience } = await loadAuthorized(deps, ctx, depositId);
  const [view] = await toViews(deps, [deposit], audience);
  const approval = audience === "BANK" && deposit.approvalRequestId ? await getApproval(deps, ctx, deposit.approvalRequestId).catch(() => null) : null;
  const timeline = await deps.db.timelineEvent.findMany({ where: { aggregateType: "deposit", aggregateId: deposit.id }, orderBy: { id: "asc" } });
  // A corporate reader sees that the bank acted, not which member of staff did.
  const actors = audience === "BANK" ? await deps.db.person.findMany({ where: { id: { in: timeline.map((event) => event.actorPersonId).filter((id): id is string => id !== null) } }, select: { id: true, name: true } }) : [];
  const actorName = new Map(actors.map((actor) => [actor.id, actor.name]));
  return {
    ...(view as DepositView),
    approval,
    timeline: timeline.map((event) => ({
      at: event.at.toISOString(),
      code: event.code,
      fromState: event.fromState,
      toState: event.toState,
      actor: event.actorPersonId ? (audience === "BANK" ? (actorName.get(event.actorPersonId) ?? null) : null) : event.actorService,
      reference: event.reference,
      detail: event.detail,
    })),
  };
}

/**
 * Receipt PDF, rendered on demand from server data for a reader who is authorized NOW. It
 * distinguishes an acknowledgment of intake from a posted receipt and always carries the
 * simulated stamp: it is not an official bank certificate.
 */
export async function depositReceiptPdf(deps: Deps, ctx: AuthContext, depositId: string, locale: "en" | "ar"): Promise<Response> {
  const { deposit, audience } = await loadAuthorized(deps, ctx, depositId);
  const [view] = (await toViews(deps, [deposit], audience)) as [DepositView];
  if (!view.receipt) throw notFound();
  const labels = MESSAGES[locale].collections.receipt;
  const posted = view.receipt.kind === "POSTED";
  const name = (value: { name: string; nameAr: string }) => (locale === "ar" ? value.nameAr : value.name);
  const pdf = new PdfBuilder({
    locale,
    title: posted ? labels.postedTitle : labels.pendingTitle,
    subtitle: posted ? labels.postedSubtitle : labels.pendingSubtitle,
    simulatedStamp: MESSAGES[locale].common.sandbox.simulatedStamp,
    meta: [`${labels.reference}: ${view.receipt.reference}`],
    footer: labels.footer,
  });
  pdf.keyValues([
    { label: labels.intakeReference, value: view.intakeReference },
    { label: labels.status, value: MESSAGES[locale].status.deposit[view.state] },
    { label: labels.method, value: labels[view.method === "CASH" ? "methodCash" : "methodCheque"] },
    { label: labels.amount, value: `${view.amount.currency} ${formatMinorGrouped(BigInt(view.amount.minor), view.amount.currency as Currency)}`, strong: true },
    { label: labels.corporate, value: name(view.corporate) },
    { label: labels.customer, value: `${view.customer.code} — ${view.customer.displayName}` },
    { label: labels.creditAccount, value: `${name(view.creditAccount)} ${maskAccountReference(view.creditAccount.maskedNumber)}` },
    { label: labels.branch, value: `${view.branch.code} — ${name(view.branch)}` },
    { label: labels.businessDate, value: view.businessDate ?? businessDateOf(deposit.createdAt, deps.timeZone) },
    ...(view.chequeReference ? [{ label: labels.chequeReference, value: view.chequeReference }] : []),
    ...(posted && view.executionReference ? [{ label: labels.postingReference, value: view.executionReference }] : []),
  ]);
  pdf.gap();
  pdf.text(posted ? labels.postedNote : labels.pendingNote);
  const bytes = await pdf.finish();
  await writeAudit(deps.db, ctx, { action: "deposit.receipt.downloaded", targetType: "deposit", targetId: depositId, corporateId: deposit.corporateId, changes: { reference: view.receipt.reference, kind: view.receipt.kind, locale } });
  return downloadResponse(bytes, "pdf", view.receipt.reference);
}

/** Cheques waiting for a clearing event, for the sandbox operator. */
export async function listPendingCheques(deps: Deps, ctx: AuthContext): Promise<DepositView[]> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.simulator.control");
  const rows = await deps.db.deposit.findMany({ where: { bankId: bankCtx.bankId, method: "CHEQUE", state: "ACCEPTED_PENDING_CLEARING" }, orderBy: { createdAt: "asc" }, take: 50 });
  return toViews(deps, rows, "BANK");
}
