/**
 * Single payments (PAY-02..04, APR-01..03, LIM-03/04): draft → immutable submit → independent
 * approval → release with full revalidation → execution through the shared engine.
 *
 * Nothing here trusts the client for tenant, actor, currency, fee, rail or checker count.
 * A preview is advisory; approval and release each re-evaluate CURRENT policy.
 */
import { maskAccountReference } from "@/contracts/common";
import { DomainError, conflict, denied, notFound, type ErrorCode } from "@/contracts/errors";
import { POSTING_CURRENCIES, assertCurrency, minorToJson, parseMinorString } from "@/contracts/money";
import { PAYMENT_TYPE_RAIL, paymentInputSchema, type PaymentInput, type SinglePaymentType } from "@/contracts/payments";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { addTimeline, timelineActor, writeAudit } from "@/server/audit/audit";
import {
  hasPermission,
  requireAccountRight,
  requireCorporate,
  requirePermission,
  rightsFor,
  type AuthContext,
  type CorporateContext,
} from "@/server/auth/context";
import { permissionsForRoles } from "@/server/auth/permissions";
import { businessDateOf, dbDateToLocalDate, localDateToDbDate } from "@/server/calendar";
import { Prisma, inTx, type Db, type DbOrTx, type Tx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { closeApprovalRequest, createApprovalRequest, getApproval, registerApprovalTarget, type ApprovalView } from "@/server/domain/approvals/service";
import { registerInstructionObserver, startAttempt } from "@/server/domain/execution/engine";
import { digestOf } from "@/server/hash";
import { enqueueJob } from "@/server/jobs/queue";
import { payloadString, registerJobHandler } from "@/server/jobs/runner";
import { emitEvent } from "@/server/outbox";
import { constraintToJson, type Constraint } from "@/server/policy/evaluate";
import { reserveLimits, settleReservations } from "@/server/policy/reservations";
import type { Account, Beneficiary, Payment } from "@/generated/prisma/client";
import { evaluatePayment, type PaymentEvaluation, type PaymentFacts } from "./policy";

export const JOB_PAYMENT_RELEASE = "payment.release";

type DestinationSnapshot = {
  kind: "BENEFICIARY" | "OWN_ACCOUNT";
  name: string;
  scheme: string;
  reference: string;
  bankName: string | null;
  matchStatus: string | null;
  matchedName: string | null;
  closeMatchAcknowledged: boolean;
};

function userKeyOf(ctx: AuthContext): string | null {
  return ctx.principal.kind === "person" && ctx.membershipId ? `membership:${ctx.membershipId}` : null;
}

function makerMembershipKey(payment: Pick<Payment, "makerMembershipId" | "createdByCredentialId">): string | null {
  return payment.createdByCredentialId ? null : `membership:${payment.makerMembershipId}`;
}

async function nextSequence(tx: Tx, scopeKey: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    INSERT INTO "ReferenceSequence" ("scopeKey", "nextValue") VALUES (${scopeKey}, 2)
    ON CONFLICT ("scopeKey") DO UPDATE SET "nextValue" = "ReferenceSequence"."nextValue" + 1
    RETURNING "nextValue" - 1 AS value`;
  return (rows[0] as { value: bigint }).value;
}

function violationOf(constraint: Constraint) {
  return {
    field: "amount.minor",
    rule: `${constraint.scope}.${constraint.period.toLowerCase()}`,
    ...(constraint.remaining !== null ? { remainingMinor: (constraint.remaining < 0n ? 0n : constraint.remaining).toString() } : {}),
    ...(constraint.limit !== null ? { limitMinor: constraint.limit.toString() } : {}),
  };
}

function throwConstraint(constraint: Constraint): never {
  throw new DomainError(constraint.code, { violations: [violationOf(constraint)] });
}

type Resolved = {
  source: Account;
  destination: DestinationSnapshot;
  destinationAccount: Account | null;
  beneficiary: Beneficiary | null;
};

/** Validate accounts, beneficiary and name-check state for a payment's static content. */
async function resolveParties(db: DbOrTx, ctx: CorporateContext, input: PaymentInput): Promise<Resolved> {
  const currency = assertCurrency(input.amount.currency);
  if (!POSTING_CURRENCIES.includes(currency)) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "amount.currency", rule: "posting", message: "Only LYD can be posted in this release." }] });
  }
  // Scope AND id together: another corporate's account id is simply "not found" (SEC-01).
  const source = await db.account.findFirst({ where: { id: input.sourceAccountId, corporateId: ctx.corporateId } });
  if (!source) throw notFound();
  requireAccountRight(ctx, source.id, "debit");
  if (source.status !== "ACTIVE") throw new DomainError("ACCOUNT_NOT_ALLOWED", { violations: [{ field: "sourceAccountId", rule: "status", code: source.status }] });
  // The currency is the account's; a different currency in the request is rejected, never converted.
  if (source.currency !== currency) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "amount.currency", rule: "account", message: "The amount must be in the source account currency." }] });
  }

  if (input.transactionType === "OWN_ACCOUNT_TRANSFER") {
    const target = await db.account.findFirst({ where: { id: input.destinationAccountId as string, corporateId: ctx.corporateId } });
    // Destination must be the SAME corporate's account; anything else does not exist here (I-23).
    if (!target) throw notFound();
    if (target.id === source.id) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "destinationAccountId", rule: "different" }] });
    if (target.status !== "ACTIVE") throw new DomainError("ACCOUNT_NOT_ALLOWED", { violations: [{ field: "destinationAccountId", rule: "status", code: target.status }] });
    if (target.currency !== source.currency) {
      throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "destinationAccountId", rule: "currency", message: "Both accounts must have the same currency." }] });
    }
    return {
      source,
      beneficiary: null,
      destinationAccount: target,
      destination: {
        kind: "OWN_ACCOUNT",
        name: target.name,
        scheme: "DEMO_DOMESTIC",
        reference: target.coreAccountRef,
        bankName: null,
        matchStatus: null,
        matchedName: null,
        closeMatchAcknowledged: false,
      },
    };
  }

  const beneficiary = await db.beneficiary.findFirst({ where: { id: input.beneficiaryId as string, corporateId: ctx.corporateId } });
  if (!beneficiary || beneficiary.archivedAt) throw notFound();
  if (beneficiary.accountReference === source.coreAccountRef) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "beneficiaryId", rule: "loop", message: "The beneficiary is the source account itself." }] });
  }
  const acknowledged = beneficiary.closeMatchAcknowledged || input.acknowledgeCloseMatch === true;
  if (beneficiary.matchStatus === "MISMATCH" || beneficiary.matchStatus === "NOT_FOUND" || beneficiary.matchStatus === "UNCHECKED") {
    // A mismatch blocks submission until the beneficiary is corrected (PAY-01).
    throw new DomainError("NAME_MISMATCH", { violations: [{ field: "beneficiaryId", rule: "nameCheck", code: beneficiary.matchStatus }] });
  }
  if (beneficiary.matchStatus === "CLOSE_MATCH" && !acknowledged) {
    throw new DomainError("NAME_MISMATCH", {
      detail: "The name is a close match. Review the returned name and acknowledge it explicitly.",
      violations: [{ field: "acknowledgeCloseMatch", rule: "required", code: "CLOSE_MATCH" }],
    });
  }
  return {
    source,
    beneficiary,
    destinationAccount: null,
    destination: {
      kind: "BENEFICIARY",
      name: beneficiary.displayName,
      scheme: beneficiary.scheme,
      reference: beneficiary.accountReference,
      bankName: beneficiary.bankName,
      matchStatus: beneficiary.matchStatus,
      matchedName: beneficiary.matchedName,
      closeMatchAcknowledged: beneficiary.matchStatus === "CLOSE_MATCH" && acknowledged,
    },
  };
}

function factsFromInput(ctx: CorporateContext, input: PaymentInput, requestedExecuteAt: Date | null): PaymentFacts {
  return {
    bankId: ctx.bankId,
    corporateId: ctx.corporateId,
    transactionType: input.transactionType,
    sourceAccountId: input.sourceAccountId,
    destinationAccountId: input.destinationAccountId ?? null,
    amountMinor: parseMinorString(input.amount.minor),
    currency: input.amount.currency,
    requestedExecuteAt,
    userKey: userKeyOf(ctx),
    userLimits: ctx.userLimits,
  };
}

async function factsFromPayment(db: DbOrTx, payment: Payment, requestedExecuteAt: Date | null): Promise<PaymentFacts> {
  // User limits are re-read at evaluation time: a tightened allowance applies to pending work.
  const membership = payment.createdByCredentialId
    ? null
    : await db.membership.findUnique({ where: { id: payment.makerMembershipId }, select: { userPerItemLimitMinor: true, userDailyLimitMinor: true } });
  return {
    bankId: payment.bankId,
    corporateId: payment.corporateId,
    transactionType: payment.transactionType as SinglePaymentType,
    sourceAccountId: payment.sourceAccountId,
    destinationAccountId: payment.destinationAccountId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    requestedExecuteAt,
    userKey: makerMembershipKey(payment),
    userLimits: { perItemMinor: membership?.userPerItemLimitMinor ?? null, dailyMinor: membership?.userDailyLimitMinor ?? null },
  };
}

function frozenPayload(payment: Payment, feeMinor: bigint, executeAt: Date | null, policyVersion: number) {
  return {
    paymentId: payment.id,
    revision: payment.revision,
    policyVersion,
    moduleId: payment.moduleId,
    transactionType: payment.transactionType,
    rail: payment.rail,
    sourceAccountId: payment.sourceAccountId,
    destination: payment.destinationSnapshot,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    feeMinor,
    purpose: payment.purpose,
    clientReference: payment.clientReference,
    executionMode: executeAt ? "SCHEDULED" : "IMMEDIATE",
    executeAt,
  };
}

function approvalSummary(payment: Payment, source: Pick<Account, "name" | "nameAr" | "maskedNumber">, feeMinor: bigint, executeAt: Date | null) {
  const destination = payment.destinationSnapshot as DestinationSnapshot;
  return {
    kind: "PAYMENT",
    reference: payment.reference,
    transactionType: payment.transactionType,
    rail: payment.rail,
    amount: minorToJson(payment.amountMinor, payment.currency),
    fee: minorToJson(feeMinor, payment.currency),
    totalDebit: minorToJson(payment.amountMinor + feeMinor, payment.currency),
    sourceAccount: { name: source.name, nameAr: source.nameAr, maskedNumber: source.maskedNumber },
    destination: {
      kind: destination.kind,
      name: destination.name,
      maskedReference: maskAccountReference(destination.reference),
      bankName: destination.bankName,
      matchStatus: destination.matchStatus,
      closeMatchAcknowledged: destination.closeMatchAcknowledged,
    },
    purpose: payment.purpose,
    executeAt: executeAt?.toISOString() ?? null,
  } satisfies Prisma.InputJsonObject;
}

// ---------------------------------------------------------------------------------------------
// Preview (advisory)
// ---------------------------------------------------------------------------------------------

export async function previewPayment(deps: Deps, ctx: AuthContext, rawInput: unknown) {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.create");
  const input = paymentInputSchema.parse(rawInput);
  const parties = await resolveParties(deps.db, corporateCtx, input);
  const requested = input.execution.mode === "SCHEDULED" ? new Date(input.execution.executeAt) : null;
  const evaluation = await evaluatePayment(deps, deps.db, factsFromInput(corporateCtx, input, requested));
  const amountMinor = parseMinorString(input.amount.minor);
  const fee = evaluation.feeMinor;

  let available: bigint | null = null;
  let coreAsOf: Date | null = null;
  try {
    const balance = await deps.core.getBalance({ bankCode: corporateCtx.bankCode, ownerRef: corporateCtx.corporateCoreRef }, parties.source.coreAccountRef);
    available = balance.availableMinor;
    coreAsOf = balance.asOf;
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
    // Unknown funds are reported as unknown — never as zero and never as sufficient.
  }

  const failures: Array<{ code: ErrorCode } & ReturnType<typeof violationOf>> = [];
  for (const constraint of evaluation.constraints) if (!constraint.passes) failures.push({ code: constraint.code, ...violationOf(constraint) });
  const extra: ErrorCode[] = [];
  if (evaluation.requiredCheckers === null) extra.push("APPROVAL_POLICY_UNAVAILABLE");
  if (fee === null) extra.push("TRANSACTION_TYPE_DISABLED");
  if (available !== null && fee !== null && available < amountMinor + fee) extra.push("INSUFFICIENT_FUNDS");
  if (evaluation.window?.rolled && !input.acceptRolledExecution) extra.push("EXECUTION_WINDOW_CLOSED");

  const window = evaluation.window;
  return {
    advisory: true as const,
    evaluatedAt: evaluation.evaluatedAt.toISOString(),
    agreement: { versionId: evaluation.policy.agreementVersionId, versionNo: evaluation.policy.versionNo },
    railParameterVersion: evaluation.railPolicy?.versionNo ?? null,
    coreAsOf: coreAsOf?.toISOString() ?? null,
    available: available === null ? null : minorToJson(available, input.amount.currency),
    principal: input.amount,
    fee: fee === null ? null : minorToJson(fee, input.amount.currency),
    totalDebit: fee === null ? null : minorToJson(amountMinor + fee, input.amount.currency),
    projectedAvailable: available === null || fee === null ? null : minorToJson(available - amountMinor - fee, input.amount.currency),
    constraints: evaluation.constraints.map(constraintToJson),
    requiredCheckers: evaluation.requiredCheckers,
    execution: window
      ? {
          executeAt: window.executeAt.toISOString(),
          businessDate: window.businessDate,
          rolled: window.rolled,
          reason: window.reason ?? null,
          timeZone: deps.timeZone,
        }
      : null,
    destination: {
      name: parties.destination.name,
      maskedReference: maskAccountReference(parties.destination.reference),
      matchStatus: parties.destination.matchStatus,
      matchedName: parties.destination.matchedName,
    },
    passes: failures.length === 0 && extra.length === 0 && !evaluation.horizonExceeded,
    failures: [...failures, ...extra.map((code) => ({ code }))],
    horizonExceeded: evaluation.horizonExceeded,
  };
}

// ---------------------------------------------------------------------------------------------
// Draft, edit, submit
// ---------------------------------------------------------------------------------------------

function draftData(input: PaymentInput, parties: Resolved) {
  return {
    moduleId: input.moduleId,
    transactionType: input.transactionType,
    rail: PAYMENT_TYPE_RAIL[input.transactionType],
    sourceAccountId: parties.source.id,
    destinationKind: parties.destination.kind,
    beneficiaryId: parties.beneficiary?.id ?? null,
    destinationAccountId: parties.destinationAccount?.id ?? null,
    destinationSnapshot: parties.destination as unknown as Prisma.InputJsonObject,
    amountMinor: parseMinorString(input.amount.minor),
    currency: input.amount.currency,
    purpose: input.purpose,
    clientReference: input.clientReference ?? null,
    executionMode: input.execution.mode,
    executeAt: input.execution.mode === "SCHEDULED" ? new Date(input.execution.executeAt) : null,
  } as const;
}

export async function createPayment(deps: Deps, ctx: AuthContext, rawInput: unknown, paymentId: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.create");
  const input = paymentInputSchema.parse(rawInput);
  const parties = await resolveParties(deps.db, corporateCtx, input);
  // Even a draft needs an effective signed agreement covering module, type and account.
  await evaluatePayment(deps, deps.db, factsFromInput(corporateCtx, input, null));
  const corporate = await deps.db.corporate.findUniqueOrThrow({ where: { id: corporateCtx.corporateId }, select: { shortCode: true } });
  const year = businessDateOf(deps.clock.now(), deps.timeZone).slice(0, 4);

  await inTx(deps.db, async (tx) => {
    const sequence = await nextSequence(tx, `PAY:${corporateCtx.corporateId}:${year}`);
    const reference = `PAY-${corporate.shortCode}-${year}-${sequence.toString().padStart(6, "0")}`;
    const principal = corporateCtx.principal;
    await tx.payment.create({
      data: {
        id: paymentId,
        bankId: corporateCtx.bankId,
        corporateId: corporateCtx.corporateId,
        reference,
        ...draftData(input, parties),
        state: "DRAFT",
        makerPersonId: principal.kind === "person" ? principal.personId : (await credentialOwner(tx, principal)),
        makerMembershipId: corporateCtx.membershipId ?? (await credentialMembership(tx, principal)),
        createdVia: principal.kind === "credential" ? "API" : "WEB",
        createdByCredentialId: principal.kind === "credential" ? principal.credentialId : null,
      },
    });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: corporateCtx.bankId,
      corporateId: corporateCtx.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      code: "PAYMENT_CREATED",
      toState: "DRAFT",
      ...timelineActor(corporateCtx),
      reference,
    });
    await writeAudit(tx, corporateCtx, {
      action: "payment.created",
      targetType: "payment",
      targetId: paymentId,
      proposalRevision: 1,
      changes: { reference, transactionType: input.transactionType, amountMinor: input.amount.minor, currency: input.amount.currency },
    });
  });
}

/**
 * An API credential is not a person. Proposals it creates are attributed to the human who
 * issued the credential — who therefore can never be the checker of those proposals.
 */
async function credentialOwner(tx: Tx, principal: AuthContext["principal"]): Promise<string> {
  if (principal.kind !== "credential") throw denied();
  const credential = await tx.apiCredential.findUniqueOrThrow({ where: { id: principal.credentialId }, select: { createdByPersonId: true } });
  return credential.createdByPersonId;
}

async function credentialMembership(tx: Tx, principal: AuthContext["principal"]): Promise<string> {
  if (principal.kind !== "credential") throw denied();
  const credential = await tx.apiCredential.findUniqueOrThrow({
    where: { id: principal.credentialId },
    select: { createdByPersonId: true, corporateId: true },
  });
  const membership = await tx.membership.findFirst({ where: { personId: credential.createdByPersonId, corporateId: credential.corporateId } });
  if (!membership) throw denied();
  return membership.id;
}

function isOwnDraftActor(ctx: AuthContext, payment: Payment): boolean {
  if (ctx.principal.kind === "person") return payment.makerPersonId === ctx.principal.personId && !payment.createdByCredentialId;
  if (ctx.principal.kind === "credential") return payment.createdByCredentialId === ctx.principal.credentialId;
  return false;
}

async function loadScoped(db: DbOrTx, ctx: CorporateContext, paymentId: string): Promise<Payment> {
  const payment = await db.payment.findFirst({ where: { id: paymentId, corporateId: ctx.corporateId } });
  if (!payment || !rightsFor(ctx, payment.sourceAccountId).read) throw notFound();
  return payment;
}

async function lockPayment(tx: Tx, paymentId: string): Promise<Payment | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
}

export async function updatePaymentDraft(deps: Deps, ctx: AuthContext, paymentId: string, rawInput: unknown, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.create");
  const input = paymentInputSchema.parse(rawInput);
  const existing = await loadScoped(deps.db, corporateCtx, paymentId);
  if (!isOwnDraftActor(corporateCtx, existing)) throw denied("Only the creator can edit a draft.");
  const parties = await resolveParties(deps.db, corporateCtx, input);
  await evaluatePayment(deps, deps.db, factsFromInput(corporateCtx, input, null));
  await inTx(deps.db, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) throw notFound();
    if (payment.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    // Submitted content is immutable: only a draft can be edited (PAY-02).
    if (payment.state !== "DRAFT") throw conflict("Only a draft can be edited. Create a new revision instead.");
    await tx.payment.update({ where: { id: paymentId }, data: { ...draftData(input, parties), version: { increment: 1 } } });
    await writeAudit(tx, corporateCtx, {
      action: "payment.draft.updated",
      targetType: "payment",
      targetId: paymentId,
      proposalRevision: payment.revision,
      changes: { amountMinor: input.amount.minor, transactionType: input.transactionType },
    });
  });
}

function enforceSubmittable(evaluation: PaymentEvaluation, opts: { acceptRolled: boolean; immediate: boolean }): void {
  if (evaluation.feeMinor === null) throw new DomainError("TRANSACTION_TYPE_DISABLED", { detail: "No tariff is configured for this transaction type." });
  if (evaluation.requiredCheckers === null) throw new DomainError("APPROVAL_POLICY_UNAVAILABLE");
  if (evaluation.structuralFailure) throwConstraint(evaluation.structuralFailure);
  if (evaluation.horizonExceeded) {
    throw new DomainError("VALIDATION_FAILED", {
      violations: [{ field: "execution.executeAt", rule: "horizon", message: "Choose a future time within the next 30 days." }],
    });
  }
  const window = evaluation.window;
  if (!window) throw new DomainError("RAIL_CONFIGURATION_REQUIRED");
  if (window.rolled && !opts.acceptRolled) {
    throw new DomainError("EXECUTION_WINDOW_CLOSED", {
      violations: [{ field: "execution", rule: window.reason ?? "ROLLED", nextExecuteAt: window.executeAt.toISOString(), businessDate: window.businessDate }],
    });
  }
  // Day/month capacity is only binding for something that would execute now.
  if (opts.immediate && !window.rolled && evaluation.cumulativeFailure) throwConstraint(evaluation.cumulativeFailure);
}

export async function submitPayment(
  deps: Deps,
  ctx: AuthContext,
  paymentId: string,
  expectedVersion: number,
  options: { acceptRolledExecution?: boolean; acknowledgeCloseMatch?: boolean } = {},
): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.create");
  const existing = await loadScoped(deps.db, corporateCtx, paymentId);
  if (!isOwnDraftActor(corporateCtx, existing)) throw denied("Only the creator can submit this draft.");

  // Re-resolve from current master data: the snapshot is taken at the moment of freezing.
  const input = paymentInputSchema.parse({
    moduleId: existing.moduleId,
    transactionType: existing.transactionType,
    sourceAccountId: existing.sourceAccountId,
    ...(existing.beneficiaryId ? { beneficiaryId: existing.beneficiaryId } : {}),
    ...(existing.destinationAccountId ? { destinationAccountId: existing.destinationAccountId } : {}),
    amount: minorToJson(existing.amountMinor, existing.currency),
    purpose: existing.purpose,
    ...(existing.clientReference ? { clientReference: existing.clientReference } : {}),
    execution: existing.executeAt ? { mode: "SCHEDULED", executeAt: existing.executeAt.toISOString() } : { mode: "IMMEDIATE" },
    acknowledgeCloseMatch:
      options.acknowledgeCloseMatch === true || (existing.destinationSnapshot as DestinationSnapshot).closeMatchAcknowledged === true,
  });
  const parties = await resolveParties(deps.db, corporateCtx, input);
  const requested = existing.executeAt;
  if (requested && requested.getTime() <= deps.clock.now().getTime()) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "execution.executeAt", rule: "future", message: "The execution time has passed." }] });
  }
  const evaluation = await evaluatePayment(deps, deps.db, factsFromInput(corporateCtx, input, requested));
  enforceSubmittable(evaluation, { acceptRolled: options.acceptRolledExecution === true, immediate: requested === null });
  const feeMinor = evaluation.feeMinor as bigint;
  const window = evaluation.window as NonNullable<PaymentEvaluation["window"]>;
  // A rolled or future execution is stored as a scheduled instant in UTC plus its business date.
  const executeAt = requested !== null || window.rolled ? window.executeAt : null;

  await inTx(deps.db, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) throw notFound();
    if (payment.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (payment.state !== "DRAFT") throw conflict("This payment was already submitted.");

    const frozen = await tx.payment.update({
      where: { id: paymentId },
      data: {
        destinationSnapshot: parties.destination as unknown as Prisma.InputJsonObject,
        feeMinor,
        executionMode: executeAt ? "SCHEDULED" : "IMMEDIATE",
        executeAt,
        executionBusinessDate: localDateToDbDate(window.businessDate),
      },
    });
    const payload = frozenPayload(frozen, feeMinor, executeAt, 1);
    const proposalHash = digestOf(payload);
    const policySnapshot = {
      policyVersion: 1,
      agreementVersionId: evaluation.policy.agreementVersionId,
      agreementVersionNo: evaluation.policy.versionNo,
      railParameterVersion: evaluation.railPolicy?.versionNo ?? null,
      feeMinor: feeMinor.toString(),
      requiredCheckers: evaluation.requiredCheckers,
      evaluatedAt: evaluation.evaluatedAt.toISOString(),
      constraints: evaluation.constraints.map(constraintToJson),
      execution: { executeAt: window.executeAt.toISOString(), businessDate: window.businessDate, rolled: window.rolled, reason: window.reason ?? null },
    } satisfies Prisma.InputJsonObject;

    const request = await createApprovalRequest(tx, {
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      klass: "PAYMENT",
      targetType: "payment",
      targetId: payment.id,
      targetRevision: payment.revision,
      payloadHash: proposalHash,
      summary: approvalSummary(frozen, parties.source, feeMinor, executeAt),
      makerPersonId: payment.makerPersonId,
      requiredApprovals: evaluation.requiredCheckers as number,
      policyVersion: 1,
      policySnapshot,
      sourceAccountId: payment.sourceAccountId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      expiresAt: new Date(deps.clock.now().getTime() + deps.settings.approvalValidityDays * 86_400_000),
    });
    await tx.paymentRevision.create({
      data: {
        paymentId,
        revisionNo: payment.revision,
        payload: JSON.parse(JSON.stringify(payload, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Prisma.InputJsonValue,
        hash: proposalHash,
        createdByPersonId: payment.makerPersonId,
      },
    });
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        state: "PENDING_APPROVAL",
        proposalHash,
        agreementVersionId: evaluation.policy.agreementVersionId,
        policySnapshot,
        approvalRequestId: request.id,
        submittedAt: deps.clock.now(),
        releaseBlockCode: null,
        failureCode: null,
        version: { increment: 1 },
      },
    });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      code: "PAYMENT_SUBMITTED",
      fromState: "DRAFT",
      toState: "PENDING_APPROVAL",
      ...timelineActor(corporateCtx),
      reference: payment.reference,
      detail: { requiredCheckers: evaluation.requiredCheckers as number, rolled: window.rolled },
    });
    await writeAudit(tx, corporateCtx, {
      action: "payment.submitted",
      targetType: "payment",
      targetId: paymentId,
      proposalRevision: payment.revision,
      changes: { proposalHash, feeMinor, requiredCheckers: evaluation.requiredCheckers, agreementVersionNo: evaluation.policy.versionNo },
    });
    await statusEvent(tx, { ...payment, state: "PENDING_APPROVAL" }, ctx.correlationId);
  });
}

async function statusEvent(tx: Tx, payment: Pick<Payment, "id" | "bankId" | "corporateId" | "reference" | "state" | "revision">, correlationId: string | null, suffix = ""): Promise<void> {
  await emitEvent(tx, {
    bankId: payment.bankId,
    corporateId: payment.corporateId,
    type: "payment.status_changed",
    data: { resourceId: payment.id, reference: payment.reference, state: payment.state, revision: payment.revision },
    dedupKey: `payment:${payment.id}:${payment.revision}:${payment.state}${suffix}`,
    correlationId,
  });
}

// ---------------------------------------------------------------------------------------------
// Approval effects
// ---------------------------------------------------------------------------------------------

async function ensureInstruction(tx: Tx, payment: Payment) {
  const destination = payment.destinationSnapshot as DestinationSnapshot;
  const source = await tx.account.findUniqueOrThrow({ where: { id: payment.sourceAccountId } });
  const data = {
    moduleId: payment.moduleId,
    transactionType: payment.transactionType,
    rail: payment.rail,
    sourceAccountId: payment.sourceAccountId,
    sourceCoreRef: source.coreAccountRef,
    destinationScheme: destination.scheme,
    destinationReference: destination.reference,
    destinationName: destination.name,
    destinationCoreRef: destination.kind === "OWN_ACCOUNT" ? destination.reference : null,
    amountMinor: payment.amountMinor,
    feeMinor: payment.feeMinor,
    currency: payment.currency,
    narrative: `${payment.reference} ${payment.purpose}`.slice(0, 200),
    makerMembershipId: payment.makerMembershipId,
  };
  const existing = await tx.businessInstruction.findUnique({ where: { paymentId: payment.id } });
  if (existing) {
    if (existing.state !== "PENDING") throw conflict("This payment is already being executed.");
    return tx.businessInstruction.update({ where: { id: existing.id }, data });
  }
  return tx.businessInstruction.create({
    data: {
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      businessKey: `PAY:${payment.id}`,
      kind: "SINGLE_PAYMENT",
      paymentId: payment.id,
      ...data,
    },
  });
}

/** Checks done at approval and again at release against CURRENT policy (APR-03). */
function comparePolicy(payment: Payment, evaluation: PaymentEvaluation, approvalsRequired: number): "OK" | "FEE_CHANGED" | "CHECKERS_INCREASED" {
  if (evaluation.feeMinor === null || evaluation.feeMinor !== payment.feeMinor) return "FEE_CHANGED";
  if (evaluation.requiredCheckers === null || evaluation.requiredCheckers > approvalsRequired) return "CHECKERS_INCREASED";
  return "OK";
}

registerApprovalTarget("payment", {
  checkVoter: async (tx, request, _ctx, deps) => {
    const payment = await lockPayment(tx, request.targetId);
    if (!payment || payment.state !== "PENDING_APPROVAL" || payment.approvalRequestId !== request.id || payment.revision !== request.targetRevision) {
      throw conflict("This proposal is no longer awaiting a decision.");
    }
    const evaluation = await evaluatePayment(deps, tx, await factsFromPayment(tx, payment, payment.executeAt));
    // The checker must never approve a fee or approval requirement that is no longer current.
    if (comparePolicy(payment, evaluation, request.requiredApprovals) !== "OK") throw new DomainError("REAPPROVAL_REQUIRED");
    if (evaluation.structuralFailure) throwConstraint(evaluation.structuralFailure);
  },
  onApproved: async (tx, request, ctx, deps) => {
    const payment = (await lockPayment(tx, request.targetId)) as Payment;
    const now = deps.clock.now();
    const scheduled = payment.executeAt !== null && payment.executeAt.getTime() > now.getTime();
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: payment.id,
      code: "PAYMENT_APPROVED",
      fromState: "PENDING_APPROVAL",
      toState: "APPROVED",
      ...timelineActor(ctx),
      reference: payment.reference,
    });

    if (scheduled) {
      // Future-dated: nothing is reserved until the due business date (D10).
      await tx.payment.update({ where: { id: payment.id }, data: { state: "SCHEDULED", version: { increment: 1 } } });
      await addTimeline(tx, {
      at: deps.clock.now(),
        bankId: payment.bankId,
        corporateId: payment.corporateId,
        aggregateType: "payment",
        aggregateId: payment.id,
        code: "PAYMENT_SCHEDULED",
        fromState: "APPROVED",
        toState: "SCHEDULED",
        actorService: "approval",
        reference: payment.reference,
      });
      await statusEvent(tx, { ...payment, state: "SCHEDULED" }, ctx.correlationId);
    } else {
      // Immediate: reserve every applicable counter in THIS transaction. If any limit would be
      // exceeded the DomainError rolls the vote back and nothing changes (DEC-011).
      const evaluation = await evaluatePayment(deps, tx, await factsFromPayment(tx, payment, null));
      const instruction = await ensureInstruction(tx, payment);
      const cycle = instruction.reservationCycle + 1;
      await tx.businessInstruction.update({ where: { id: instruction.id }, data: { reservationCycle: cycle, correlationId: ctx.correlationId } });
      await reserveLimits(tx, {
        bankId: payment.bankId,
        corporateId: payment.corporateId,
        currency: payment.currency,
        windows: evaluation.windows,
        items: [{ instructionId: instruction.id, cycle, amountMinor: payment.amountMinor, counters: evaluation.counters }],
        limits: evaluation.limits,
      });
      await tx.payment.update({ where: { id: payment.id }, data: { state: "QUEUED", version: { increment: 1 } } });
      await addTimeline(tx, {
      at: deps.clock.now(),
        bankId: payment.bankId,
        corporateId: payment.corporateId,
        aggregateType: "payment",
        aggregateId: payment.id,
        code: "PAYMENT_QUEUED",
        fromState: "APPROVED",
        toState: "QUEUED",
        actorService: "approval",
        reference: payment.reference,
      });
      await statusEvent(tx, { ...payment, state: "QUEUED" }, ctx.correlationId);
    }
    await enqueueJob(tx, {
      type: JOB_PAYMENT_RELEASE,
      payload: { paymentId: payment.id },
      dedupKey: `payment-release:${payment.id}`,
      ...(scheduled ? { availableAt: payment.executeAt as Date } : {}),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: payment.id,
      correlationId: ctx.correlationId,
    });
  },
  onRejected: async (tx, request, ctx, deps, reason) => {
    const payment = (await lockPayment(tx, request.targetId)) as Payment;
    await tx.payment.update({ where: { id: payment.id }, data: { state: "REJECTED", version: { increment: 1 } } });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: payment.id,
      code: "PAYMENT_REJECTED",
      fromState: "PENDING_APPROVAL",
      toState: "REJECTED",
      ...timelineActor(ctx),
      reference: payment.reference,
      detail: { reason },
    });
    await statusEvent(tx, { ...payment, state: "REJECTED" }, ctx.correlationId);
  },
});

/**
 * The fee or required checker count changed after submission. Votes are void: the proposal
 * returns to PENDING_APPROVAL with a new policy revision showing the current terms. It never
 * silently charges more and never carries approvals over (APR-03, LIM-04).
 */
export async function requireReapproval(deps: Deps, paymentId: string, reason: "FEE_CHANGED" | "CHECKERS_INCREASED" | "APPROVER_INELIGIBLE"): Promise<boolean> {
  return inTx(deps.db, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment || !["PENDING_APPROVAL", "QUEUED", "SCHEDULED", "APPROVED"].includes(payment.state)) return false;
    const evaluation = await evaluatePayment(deps, tx, await factsFromPayment(tx, payment, payment.executeAt)).catch(() => null);
    if (!evaluation || evaluation.feeMinor === null || evaluation.requiredCheckers === null) return false;

    const previous = payment.approvalRequestId ? await tx.approvalRequest.findUnique({ where: { id: payment.approvalRequestId } }) : null;
    if (previous?.state === "PENDING") await closeApprovalRequest(tx, previous.id, "SUPERSEDED");
    const instruction = await tx.businessInstruction.findUnique({ where: { paymentId } });
    if (instruction) await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");

    const policyVersion = (previous?.policyVersion ?? 1) + 1;
    const source = await tx.account.findUniqueOrThrow({ where: { id: payment.sourceAccountId } });
    const repriced = await tx.payment.update({ where: { id: paymentId }, data: { feeMinor: evaluation.feeMinor } });
    const payload = frozenPayload(repriced, evaluation.feeMinor, payment.executeAt, policyVersion);
    const proposalHash = digestOf(payload);
    const policySnapshot = {
      policyVersion,
      agreementVersionId: evaluation.policy.agreementVersionId,
      agreementVersionNo: evaluation.policy.versionNo,
      railParameterVersion: evaluation.railPolicy?.versionNo ?? null,
      feeMinor: evaluation.feeMinor.toString(),
      previousFeeMinor: payment.feeMinor.toString(),
      requiredCheckers: evaluation.requiredCheckers,
      evaluatedAt: evaluation.evaluatedAt.toISOString(),
      reapprovalReason: reason,
      constraints: evaluation.constraints.map(constraintToJson),
    } satisfies Prisma.InputJsonObject;
    const request = await createApprovalRequest(tx, {
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      klass: "PAYMENT",
      targetType: "payment",
      targetId: payment.id,
      targetRevision: payment.revision,
      payloadHash: proposalHash,
      summary: { ...approvalSummary(repriced, source, evaluation.feeMinor, payment.executeAt), reapprovalReason: reason, previousFee: minorToJson(payment.feeMinor, payment.currency) },
      makerPersonId: payment.makerPersonId,
      requiredApprovals: evaluation.requiredCheckers,
      policyVersion,
      policySnapshot,
      sourceAccountId: payment.sourceAccountId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      expiresAt: new Date(deps.clock.now().getTime() + deps.settings.approvalValidityDays * 86_400_000),
    });
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        state: "PENDING_APPROVAL",
        proposalHash,
        policySnapshot,
        agreementVersionId: evaluation.policy.agreementVersionId,
        approvalRequestId: request.id,
        releaseBlockCode: "REAPPROVAL_REQUIRED",
        version: { increment: 1 },
      },
    });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      code: "REAPPROVAL_REQUIRED",
      fromState: payment.state,
      toState: "PENDING_APPROVAL",
      actorService: "policy",
      reference: payment.reference,
      detail: { reason, previousFeeMinor: payment.feeMinor.toString(), feeMinor: evaluation.feeMinor.toString(), requiredCheckers: evaluation.requiredCheckers },
    });
    await statusEvent(tx, { ...payment, state: "PENDING_APPROVAL" }, null, `:p${policyVersion}`);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Release (worker)
// ---------------------------------------------------------------------------------------------

type ReleaseOutcome =
  | { kind: "started" }
  | { kind: "noop" }
  | { kind: "defer"; at: Date }
  | { kind: "reapproval"; reason: "FEE_CHANGED" | "CHECKERS_INCREASED" | "APPROVER_INELIGIBLE" };

class ReleaseBlocked extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function approversStillEligible(tx: Tx, payment: Payment): Promise<boolean> {
  if (!payment.approvalRequestId) return false;
  const votes = await tx.approvalVote.findMany({ where: { approvalRequestId: payment.approvalRequestId, decision: "APPROVE" } });
  for (const vote of votes) {
    const person = await tx.person.findUnique({ where: { id: vote.personId }, select: { status: true } });
    if (person?.status !== "ACTIVE") return false;
    const membership = await tx.membership.findFirst({
      where: { id: vote.membershipId, personId: vote.personId, corporateId: payment.corporateId, status: "ACTIVE" },
      include: { grants: { where: { accountId: payment.sourceAccountId } } },
    });
    if (!membership || !permissionsForRoles(membership.roles).has("payments.approve")) return false;
    if (!membership.grants.some((grant) => grant.canApprove)) return false;
  }
  return votes.length > 0;
}

async function makerStillEligible(tx: Tx, payment: Payment): Promise<boolean> {
  if (payment.createdByCredentialId) {
    const credential = await tx.apiCredential.findUnique({ where: { id: payment.createdByCredentialId }, select: { revokedAt: true } });
    return credential !== null && credential.revokedAt === null;
  }
  const person = await tx.person.findUnique({ where: { id: payment.makerPersonId }, select: { status: true } });
  if (person?.status !== "ACTIVE") return false;
  const membership = await tx.membership.findFirst({
    where: { id: payment.makerMembershipId, status: "ACTIVE" },
    include: { grants: { where: { accountId: payment.sourceAccountId } } },
  });
  return (
    membership !== null && permissionsForRoles(membership.roles).has("payments.create") && membership.grants.some((grant) => grant.canDebit)
  );
}

/**
 * Release transaction: claim the payment, re-evaluate everything against current policy,
 * (re)reserve usage in the current business windows and persist the execution intent with its
 * stable reference. No adapter is called here.
 */
export async function releasePayment(deps: Deps, paymentId: string): Promise<ReleaseOutcome> {
  let blocked: string | null = null;
  let outcome: ReleaseOutcome = { kind: "noop" };
  try {
    outcome = await inTx(deps.db, async (tx): Promise<ReleaseOutcome> => {
      const payment = await lockPayment(tx, paymentId);
      if (!payment || (payment.state !== "QUEUED" && payment.state !== "SCHEDULED")) return { kind: "noop" };
      const now = deps.clock.now();
      // Never execute early: a scheduled item waits for its instant.
      if (payment.state === "SCHEDULED" && payment.executeAt && payment.executeAt.getTime() > now.getTime()) {
        return { kind: "defer", at: payment.executeAt };
      }
      if (!(await makerStillEligible(tx, payment))) throw new ReleaseBlocked("MAKER_INELIGIBLE");
      if (!(await approversStillEligible(tx, payment))) return { kind: "reapproval", reason: "APPROVER_INELIGIBLE" };

      const source = await tx.account.findUniqueOrThrow({ where: { id: payment.sourceAccountId } });
      if (source.status !== "ACTIVE") throw new ReleaseBlocked("ACCOUNT_NOT_ALLOWED");
      if (payment.destinationAccountId) {
        const target = await tx.account.findUniqueOrThrow({ where: { id: payment.destinationAccountId } });
        if (target.status !== "ACTIVE") throw new ReleaseBlocked("ACCOUNT_NOT_ALLOWED");
      }

      const evaluation = await evaluatePayment(deps, tx, await factsFromPayment(tx, payment, null));
      const request = await tx.approvalRequest.findUniqueOrThrow({ where: { id: payment.approvalRequestId as string } });
      const comparison = comparePolicy(payment, evaluation, request.requiredApprovals);
      if (comparison !== "OK") return { kind: "reapproval", reason: comparison };
      if (evaluation.structuralFailure) throw new ReleaseBlocked(evaluation.structuralFailure.code);
      if (!evaluation.window) throw new ReleaseBlocked("RAIL_CONFIGURATION_REQUIRED");
      // Rail closed right now (cut-off, closed day, core offline): wait for the next window.
      if (evaluation.window.rolled) return { kind: "defer", at: evaluation.window.executeAt };

      const instruction = await ensureInstruction(tx, payment);
      // Drop any reservation from an older window/policy and reserve again NOW, atomically:
      // an old-window reservation can never be used to bypass today's limits (LIM-03, I-24).
      await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
      const cycle = instruction.reservationCycle + 1;
      await tx.businessInstruction.update({ where: { id: instruction.id }, data: { reservationCycle: cycle } });
      await reserveLimits(tx, {
        bankId: payment.bankId,
        corporateId: payment.corporateId,
        currency: payment.currency,
        windows: evaluation.windows,
        items: [{ instructionId: instruction.id, cycle, amountMinor: payment.amountMinor, counters: evaluation.counters }],
        limits: evaluation.limits,
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: { executionBusinessDate: localDateToDbDate(evaluation.windows.day), releaseBlockCode: null },
      });
      await startAttempt(tx, deps, instruction.id);
      return { kind: "started" };
    });
  } catch (error) {
    if (error instanceof ReleaseBlocked) blocked = error.code;
    else if (error instanceof DomainError && error.code !== "INTERNAL_ERROR") blocked = error.code;
    else throw error;
  }

  if (blocked) {
    await blockRelease(deps, paymentId, blocked);
    return { kind: "noop" };
  }
  if (outcome.kind === "reapproval") await requireReapproval(deps, paymentId, outcome.reason);
  return outcome;
}

/** Controls tightened but the proposal is unchanged: stop and ask for action; never release. */
async function blockRelease(deps: Deps, paymentId: string, code: string): Promise<void> {
  await inTx(deps.db, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment || (payment.state !== "QUEUED" && payment.state !== "SCHEDULED")) return;
    const instruction = await tx.businessInstruction.findUnique({ where: { paymentId } });
    if (instruction) await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
    await tx.payment.update({ where: { id: paymentId }, data: { state: "APPROVED", releaseBlockCode: code, version: { increment: 1 } } });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      code: "RELEASE_BLOCKED",
      fromState: payment.state,
      toState: "APPROVED",
      actorService: "worker",
      reference: payment.reference,
      detail: { blockCode: code },
    });
    await statusEvent(tx, { ...payment, state: "APPROVED" }, null, `:blocked:${code}`);
  });
}

registerJobHandler(JOB_PAYMENT_RELEASE, async (job, deps) => {
  const outcome = await releasePayment(deps, payloadString(job, "paymentId"));
  if (outcome.kind === "defer") return { kind: "poll", at: outcome.at };
  return { kind: "done" };
});

// Mirror instruction outcomes onto the payment, its timeline and the outbox.
registerInstructionObserver("SINGLE_PAYMENT", async (tx, instruction, change) => {
  if (!instruction.paymentId) return;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: instruction.paymentId } });
  const next = change.state === "PENDING" ? payment.state : change.state;
  if (next === payment.state) return;
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      state: next,
      failureCode: change.state === "FAILED" || change.state === "RETURNED" ? change.failureCode : null,
      ...(change.state === "SETTLED" ? { settledAt: change.at } : {}),
      version: { increment: 1 },
    },
  });
  await addTimeline(tx, {
    bankId: payment.bankId,
    corporateId: payment.corporateId,
    aggregateType: "payment",
    aggregateId: payment.id,
    code: `PAYMENT_${next}`,
    fromState: payment.state,
    toState: next,
    actorService: "worker",
    reference: change.reference,
    ...(change.failureCode ? { detail: { failureCode: change.failureCode } } : {}),
    at: change.at,
  });
  await statusEvent(tx, { ...payment, state: next }, instruction.correlationId);
});

// ---------------------------------------------------------------------------------------------
// Cancel, revise, retry release
// ---------------------------------------------------------------------------------------------

const CANCELLABLE: ReadonlySet<Payment["state"]> = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "QUEUED"]);

export async function cancelPayment(deps: Deps, ctx: AuthContext, paymentId: string, expectedVersion: number, reason: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.cancel");
  const existing = await loadScoped(deps.db, corporateCtx, paymentId);
  requireAccountRight(corporateCtx, existing.sourceAccountId, "debit");
  await inTx(deps.db, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) throw notFound();
    if (payment.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (payment.state === "STATUS_UNKNOWN") throw new DomainError("STATUS_UNRESOLVED");
    if (!CANCELLABLE.has(payment.state)) {
      // After dispatch only the bank can establish, by inquiry, whether anything was posted.
      throw conflict("This payment is already being executed and cannot be cancelled here. Ask bank operations to inquire.");
    }
    if (payment.approvalRequestId) await closeApprovalRequest(tx, payment.approvalRequestId, "CANCELLED");
    const instruction = await tx.businessInstruction.findUnique({ where: { paymentId } });
    if (instruction) {
      if (instruction.state !== "PENDING") throw conflict("This payment is already being executed.");
      await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
      await tx.businessInstruction.update({ where: { id: instruction.id }, data: { state: "CANCELLED", version: { increment: 1 } } });
    }
    await tx.payment.update({ where: { id: paymentId }, data: { state: "CANCELLED", releaseBlockCode: null, version: { increment: 1 } } });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      code: "PAYMENT_CANCELLED",
      fromState: payment.state,
      toState: "CANCELLED",
      ...timelineActor(corporateCtx),
      reference: payment.reference,
      detail: { reason },
    });
    await writeAudit(tx, corporateCtx, {
      action: "payment.cancelled",
      targetType: "payment",
      targetId: paymentId,
      reason,
      proposalRevision: payment.revision,
      changes: { before: payment.state, after: "CANCELLED" },
    });
    await statusEvent(tx, { ...payment, state: "CANCELLED" }, ctx.correlationId);
  });
}

const REVISABLE: ReadonlySet<Payment["state"]> = new Set(["PENDING_APPROVAL", "APPROVED", "SCHEDULED", "REJECTED", "EXPIRED"]);

/**
 * Changing submitted content always creates a NEW revision and voids previous approvals.
 * The reviser becomes the maker of the new revision (and so cannot approve it).
 */
export async function revisePayment(deps: Deps, ctx: AuthContext, paymentId: string, rawInput: unknown, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.create");
  const input = paymentInputSchema.parse(rawInput);
  await loadScoped(deps.db, corporateCtx, paymentId);
  const parties = await resolveParties(deps.db, corporateCtx, input);
  await evaluatePayment(deps, deps.db, factsFromInput(corporateCtx, input, null));
  await inTx(deps.db, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) throw notFound();
    if (payment.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (payment.state === "STATUS_UNKNOWN") throw new DomainError("STATUS_UNRESOLVED");
    if (!REVISABLE.has(payment.state)) {
      throw conflict("Only a payment that has not been dispatched can be revised. Cancel is unavailable once execution has started.");
    }
    if (payment.approvalRequestId) await closeApprovalRequest(tx, payment.approvalRequestId, "SUPERSEDED");
    const instruction = await tx.businessInstruction.findUnique({ where: { paymentId } });
    if (instruction) {
      if (instruction.state !== "PENDING") throw conflict("This payment is already being executed.");
      await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
    }
    const principal = corporateCtx.principal;
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        ...draftData(input, parties),
        state: "DRAFT",
        revision: { increment: 1 },
        feeMinor: 0n,
        proposalHash: null,
        policySnapshot: Prisma.DbNull,
        approvalRequestId: null,
        releaseBlockCode: null,
        failureCode: null,
        submittedAt: null,
        makerPersonId: principal.kind === "person" ? principal.personId : payment.makerPersonId,
        makerMembershipId: corporateCtx.membershipId ?? payment.makerMembershipId,
        createdByCredentialId: principal.kind === "credential" ? principal.credentialId : null,
        version: { increment: 1 },
      },
    });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      code: "PAYMENT_REVISED",
      fromState: payment.state,
      toState: "DRAFT",
      ...timelineActor(corporateCtx),
      reference: payment.reference,
      detail: { revision: payment.revision + 1 },
    });
    await writeAudit(tx, corporateCtx, {
      action: "payment.revised",
      targetType: "payment",
      targetId: paymentId,
      proposalRevision: payment.revision + 1,
      changes: { before: { state: payment.state, revision: payment.revision }, after: { state: "DRAFT", revision: payment.revision + 1 } },
    });
  });
}

/** Ask the worker to try the release again after a block was resolved. Approvals stay bound. */
export async function retryRelease(deps: Deps, ctx: AuthContext, paymentId: string, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.create");
  const existing = await loadScoped(deps.db, corporateCtx, paymentId);
  requireAccountRight(corporateCtx, existing.sourceAccountId, "debit");
  await inTx(deps.db, async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) throw notFound();
    if (payment.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (payment.state !== "APPROVED" || !payment.releaseBlockCode) throw conflict("This payment is not waiting for a release retry.");
    const scheduled = payment.executeAt !== null && payment.executeAt.getTime() > deps.clock.now().getTime();
    await tx.payment.update({
      where: { id: paymentId },
      data: { state: scheduled ? "SCHEDULED" : "QUEUED", releaseBlockCode: null, version: { increment: 1 } },
    });
    await addTimeline(tx, {
      at: deps.clock.now(),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      code: "RELEASE_RETRY_REQUESTED",
      fromState: "APPROVED",
      toState: scheduled ? "SCHEDULED" : "QUEUED",
      ...timelineActor(corporateCtx),
      reference: payment.reference,
    });
    await writeAudit(tx, corporateCtx, { action: "payment.release.retry", targetType: "payment", targetId: paymentId, proposalRevision: payment.revision });
    await enqueueJob(tx, {
      type: JOB_PAYMENT_RELEASE,
      payload: { paymentId },
      dedupKey: `payment-release:${paymentId}`,
      ...(scheduled ? { availableAt: payment.executeAt as Date } : {}),
      bankId: payment.bankId,
      corporateId: payment.corporateId,
      aggregateType: "payment",
      aggregateId: paymentId,
      correlationId: ctx.correlationId,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

export type PaymentView = {
  id: string;
  reference: string;
  state: Payment["state"];
  version: number;
  revision: number;
  moduleId: string;
  transactionType: string;
  rail: string;
  sourceAccount: { id: string; name: string; nameAr: string; maskedNumber: string };
  destination: { kind: string; name: string; maskedReference: string; bankName: string | null; matchStatus: string | null; closeMatchAcknowledged: boolean };
  amount: { currency: string; minor: string };
  fee: { currency: string; minor: string };
  totalDebit: { currency: string; minor: string };
  purpose: string;
  clientReference: string | null;
  execution: { mode: string; executeAt: string | null; businessDate: string | null; timeZone: string };
  maker: { personId: string; name: string; viaApi: boolean };
  createdAt: string;
  submittedAt: string | null;
  settledAt: string | null;
  releaseBlockCode: string | null;
  failureCode: string | null;
  proposalHash: string | null;
  actions: { edit: boolean; submit: boolean; cancel: boolean; revise: boolean; retryRelease: boolean };
};

export type PaymentDetail = PaymentView & {
  approval: ApprovalView | null;
  policy: Prisma.JsonValue | null;
  executionReference: string | null;
  timeline: Array<{ at: string; code: string; fromState: string | null; toState: string | null; actor: string | null; reference: string | null; detail: Prisma.JsonValue | null }>;
};

function actionsFor(ctx: AuthContext, payment: Payment): PaymentView["actions"] {
  const canCreate = hasPermission(ctx, "payments.create") && rightsFor(ctx, payment.sourceAccountId).debit;
  const own = isOwnDraftActor(ctx, payment);
  return {
    edit: canCreate && own && payment.state === "DRAFT",
    submit: canCreate && own && payment.state === "DRAFT",
    cancel: hasPermission(ctx, "payments.cancel") && rightsFor(ctx, payment.sourceAccountId).debit && CANCELLABLE.has(payment.state),
    revise: canCreate && REVISABLE.has(payment.state),
    retryRelease: canCreate && payment.state === "APPROVED" && payment.releaseBlockCode !== null,
  };
}

async function toViews(db: Db, ctx: AuthContext, payments: Payment[], timeZone: string): Promise<PaymentView[]> {
  const accountIds = [...new Set(payments.map((payment) => payment.sourceAccountId))];
  const makerIds = [...new Set(payments.map((payment) => payment.makerPersonId))];
  const [accounts, makers] = await Promise.all([
    db.account.findMany({ where: { id: { in: accountIds } } }),
    db.person.findMany({ where: { id: { in: makerIds } }, select: { id: true, name: true } }),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const nameById = new Map(makers.map((maker) => [maker.id, maker.name]));
  return payments.map((payment) => {
    const destination = payment.destinationSnapshot as DestinationSnapshot;
    const account = accountById.get(payment.sourceAccountId) as Account;
    return {
      id: payment.id,
      reference: payment.reference,
      state: payment.state,
      version: payment.version,
      revision: payment.revision,
      moduleId: payment.moduleId,
      transactionType: payment.transactionType,
      rail: payment.rail,
      sourceAccount: { id: account.id, name: account.name, nameAr: account.nameAr, maskedNumber: account.maskedNumber },
      destination: {
        kind: destination.kind,
        name: destination.name,
        maskedReference: maskAccountReference(destination.reference),
        bankName: destination.bankName,
        matchStatus: destination.matchStatus,
        closeMatchAcknowledged: destination.closeMatchAcknowledged,
      },
      amount: minorToJson(payment.amountMinor, payment.currency),
      fee: minorToJson(payment.feeMinor, payment.currency),
      totalDebit: minorToJson(payment.amountMinor + payment.feeMinor, payment.currency),
      purpose: payment.purpose,
      clientReference: payment.clientReference,
      execution: {
        mode: payment.executionMode,
        executeAt: payment.executeAt?.toISOString() ?? null,
        businessDate: payment.executionBusinessDate ? dbDateToLocalDate(payment.executionBusinessDate) : null,
        timeZone,
      },
      maker: { personId: payment.makerPersonId, name: nameById.get(payment.makerPersonId) ?? "", viaApi: payment.createdByCredentialId !== null },
      createdAt: payment.createdAt.toISOString(),
      submittedAt: payment.submittedAt?.toISOString() ?? null,
      settledAt: payment.settledAt?.toISOString() ?? null,
      releaseBlockCode: payment.releaseBlockCode,
      failureCode: payment.failureCode,
      proposalHash: payment.proposalHash,
      actions: actionsFor(ctx, payment),
    };
  });
}

export async function listPayments(
  deps: Deps,
  ctx: AuthContext,
  filter: { state?: string; accountId?: string; rail?: string; fromDate?: string; toDate?: string; reference?: string; cursor?: string; limit?: number },
): Promise<{ items: PaymentView[]; nextCursor: string | null }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.read");
  const readable = [...corporateCtx.grants.entries()].filter(([, rights]) => rights.read).map(([id]) => id);
  if (filter.accountId && !readable.includes(filter.accountId)) throw notFound();
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const rows = await deps.db.payment.findMany({
    where: {
      corporateId: corporateCtx.corporateId,
      sourceAccountId: { in: filter.accountId ? [filter.accountId] : readable },
      ...(filter.state ? { state: filter.state as Payment["state"] } : {}),
      ...(filter.rail ? { rail: filter.rail as Payment["rail"] } : {}),
      ...(filter.reference ? { reference: { contains: filter.reference, mode: "insensitive" as const } } : {}),
      ...(filter.fromDate || filter.toDate
        ? {
            createdAt: {
              ...(filter.fromDate ? { gte: new Date(`${filter.fromDate}T00:00:00.000Z`) } : {}),
              ...(filter.toDate ? { lt: new Date(new Date(`${filter.toDate}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: await toViews(deps.db, corporateCtx, page, deps.timeZone),
    nextCursor: rows.length > limit ? (page[page.length - 1] as Payment).id : null,
  };
}

export async function getPayment(deps: Deps, ctx: AuthContext, paymentId: string): Promise<PaymentDetail> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "payments.read");
  const payment = await loadScoped(deps.db, corporateCtx, paymentId);
  const [view] = await toViews(deps.db, corporateCtx, [payment], deps.timeZone);
  const timeline = await deps.db.timelineEvent.findMany({
    where: { aggregateType: "payment", aggregateId: payment.id },
    orderBy: { id: "asc" },
  });
  const actorIds = [...new Set(timeline.map((event) => event.actorPersonId).filter((id): id is string => id !== null))];
  const actors = await deps.db.person.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
  const actorName = new Map(actors.map((actor) => [actor.id, actor.name]));
  const instruction = await deps.db.businessInstruction.findUnique({
    where: { paymentId: payment.id },
    include: { attempts: { orderBy: { attemptNo: "desc" }, take: 1 } },
  });
  let approval: ApprovalView | null = null;
  if (payment.approvalRequestId) {
    approval = await getApproval(deps, corporateCtx, payment.approvalRequestId).catch(() => null);
  }
  return {
    ...(view as PaymentView),
    approval,
    policy: payment.policySnapshot,
    executionReference: instruction?.attempts[0]?.executionReference ?? null,
    timeline: timeline.map((event) => ({
      at: event.at.toISOString(),
      code: event.code,
      fromState: event.fromState,
      toState: event.toState,
      actor: event.actorPersonId ? (actorName.get(event.actorPersonId) ?? null) : event.actorService,
      reference: event.reference,
      detail: event.detail,
    })),
  };
}
