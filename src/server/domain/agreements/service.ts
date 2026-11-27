/**
 * Bank agreement governance (AGR-01..03, GOV-001/002/006).
 *
 * A bank admin maker proposes a FULL immutable revision with simulated signature evidence;
 * a different bank admin checker approves it. Approval, predecessor truncation and agreement
 * activation happen in the vote transaction. History is never deleted. An emergency suspension
 * is immediate and audited; restoring needs an independent approval.
 */
import {
  agreementProposalSchema,
  agreementTermsSchema,
  validateAgreementTerms,
  type AgreementProposal,
  type AgreementTerms,
} from "@/contracts/agreement";
import { DomainError, conflict, notFound } from "@/contracts/errors";
import { writeAudit } from "@/server/audit/audit";
import { requireBank, requireCorporate, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { inTx, type Prisma, type Tx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { canonicalJson, digestOf } from "@/server/hash";
import { createApprovalRequest, registerApprovalTarget } from "@/server/domain/approvals/service";
import { loadAgreementStatus, type AgreementState } from "./policy";
import { segmentTemplate } from "./templates";

const MAX_BACKDATE_MS = 24 * 3_600_000;

async function corporateInBank(deps: Deps, ctx: AuthContext, corporateId: string) {
  const corporate = await deps.db.corporate.findFirst({ where: { id: corporateId, bankId: ctx.bankId } });
  // Another bank's corporate does not exist for this caller (I-02).
  if (!corporate) throw notFound();
  return corporate;
}

function materialize(versionId: string, corporateId: string, terms: AgreementTerms) {
  const entitlements: Prisma.ModuleEntitlementCreateManyInput[] = [];
  const entitlementAccounts: Array<{ moduleId: string; accountId: string; allowDebit: boolean; allowCredit: boolean }> = [];
  const limitRules: Prisma.LimitRuleCreateManyInput[] = [];
  const feeRules: Prisma.FeeRuleCreateManyInput[] = [];
  const approvalRules: Prisma.ApprovalRuleCreateManyInput[] = [];

  for (const moduleTerms of terms.moduleTerms) {
    entitlements.push({
      agreementVersionId: versionId,
      corporateId,
      moduleId: moduleTerms.moduleId,
      allowedTypes: moduleTerms.transactionTypes,
      currency: moduleTerms.currency,
      rowCap: moduleTerms.rowCap ?? null,
    });
    const accountIds = new Set([...moduleTerms.debitAccountIds, ...moduleTerms.creditAccountIds]);
    for (const accountId of accountIds) {
      entitlementAccounts.push({
        moduleId: moduleTerms.moduleId,
        accountId,
        allowDebit: moduleTerms.debitAccountIds.includes(accountId),
        allowCredit: moduleTerms.creditAccountIds.includes(accountId),
      });
    }
    for (const limit of moduleTerms.limits) {
      limitRules.push({
        agreementVersionId: versionId,
        scope: limit.scope,
        moduleId: moduleTerms.moduleId,
        transactionType: limit.scope === "TYPE" ? (limit.transactionType ?? null) : null,
        metric: limit.metric,
        period: limit.period,
        currency: limit.metric === "AMOUNT" ? limit.currency : null,
        valueMinor: limit.metric === "AMOUNT" ? BigInt(limit.minor) : null,
        itemCount: limit.metric === "ITEMS" ? limit.count : null,
        provenance: limit.provenance,
      });
    }
    for (const fee of moduleTerms.feeRules) {
      feeRules.push({
        agreementVersionId: versionId,
        transactionType: fee.transactionType,
        currency: fee.currency,
        fixedMinor: BigInt(fee.minor),
      });
    }
    for (const band of moduleTerms.approvalBands) {
      approvalRules.push({
        agreementVersionId: versionId,
        moduleId: moduleTerms.moduleId,
        transactionType: band.transactionType,
        currency: band.currency,
        minMinor: BigInt(band.minMinor),
        maxExclusiveMinor: band.maxExclusiveMinor === null ? null : BigInt(band.maxExclusiveMinor),
        checkerCount: band.checkerCount,
      });
    }
  }
  for (const limit of terms.corporateLimits) {
    limitRules.push({
      agreementVersionId: versionId,
      scope: "CORPORATE",
      moduleId: null,
      transactionType: null,
      metric: "AMOUNT",
      period: limit.period,
      currency: limit.currency,
      valueMinor: BigInt(limit.minor),
      itemCount: null,
      provenance: limit.provenance,
    });
  }
  return { entitlements, entitlementAccounts, limitRules, feeRules, approvalRules };
}

export type TermsChange = { path: string; before: string | null; after: string | null };

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      // Stable keys so reordering is not reported as a change.
      const key =
        item && typeof item === "object"
          ? ((item as Record<string, unknown>)["moduleId"] ??
              [
                (item as Record<string, unknown>)["scope"],
                (item as Record<string, unknown>)["transactionType"],
                (item as Record<string, unknown>)["metric"],
                (item as Record<string, unknown>)["period"],
                (item as Record<string, unknown>)["minMinor"],
              ]
                .filter((part) => part !== undefined)
                .join("/")) || String(index)
          : String(item);
      flatten(item && typeof item === "object" ? item : true, `${prefix}[${String(key)}]`, out);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  out.set(prefix, String(value));
}

/** Field-level differences between two versions of the terms, for the checker's review. */
export function diffTerms(before: AgreementTerms | null, after: AgreementTerms): TermsChange[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  if (before) flatten(before, "", a);
  flatten(after, "", b);
  const changes: TermsChange[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(path) ?? null;
    const right = b.get(path) ?? null;
    if (left !== right) changes.push({ path, before: left, after: right });
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

export async function proposeAgreementVersion(
  deps: Deps,
  ctx: AuthContext,
  corporateId: string,
  rawProposal: unknown,
  versionId: string,
): Promise<void> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.agreement.propose");
  const person = requirePerson(bankCtx);
  const corporate = await corporateInBank(deps, bankCtx, corporateId);
  const proposal: AgreementProposal = agreementProposalSchema.parse(rawProposal);

  const now = deps.clock.now();
  const effectiveFrom = new Date(proposal.effectiveFrom);
  const effectiveUntil = new Date(proposal.effectiveUntil);
  const violations: Array<{ field: string; rule: string; message: string }> = [];
  if (effectiveUntil.getTime() <= effectiveFrom.getTime()) {
    violations.push({ field: "effectiveUntil", rule: "after", message: "The end must be after the start (end is exclusive)." });
  }
  if (effectiveUntil.getTime() <= now.getTime()) {
    violations.push({ field: "effectiveUntil", rule: "future", message: "The validity period has already ended." });
  }
  if (effectiveFrom.getTime() < now.getTime() - MAX_BACKDATE_MS) {
    violations.push({ field: "effectiveFrom", rule: "backdate", message: "A revision cannot start more than one day in the past." });
  }
  if (proposal.terms.segment !== corporate.segment) {
    violations.push({ field: "terms.segment", rule: "match", message: "The segment must match the corporate's segment." });
  }
  const accounts = await deps.db.account.findMany({ where: { corporateId, status: { not: "CLOSED" } }, select: { id: true } });
  for (const issue of validateAgreementTerms(proposal.terms, new Set(accounts.map((account) => account.id)))) {
    violations.push({ field: `terms.${issue.path}`, rule: issue.code, message: issue.message });
  }
  if (violations.length > 0) {
    const deferred = violations.find((violation) => violation.rule === "MODULE_UNAVAILABLE");
    // A deferred module is an explicit, named refusal — never a silent success (I-07).
    throw new DomainError(deferred ? "MODULE_UNAVAILABLE" : "VALIDATION_FAILED", { violations });
  }

  const termsHash = digestOf({
    terms: proposal.terms,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: effectiveUntil.toISOString(),
    signatureEvidence: proposal.signatureEvidence,
  });

  await inTx(deps.db, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Agreement" WHERE "corporateId" = ${corporateId}::uuid FOR UPDATE`;
    let agreement = await tx.agreement.findUnique({ where: { corporateId } });
    agreement ??= await tx.agreement.create({ data: { bankId: corporate.bankId, corporateId, status: "DRAFT" } });
    if (agreement.status === "CLOSED") throw conflict("This agreement is closed.");

    const last = await tx.agreementVersion.findFirst({ where: { agreementId: agreement.id }, orderBy: { versionNo: "desc" } });
    const versionNo = (last?.versionNo ?? 0) + 1;
    const rows = materialize(versionId, corporateId, proposal.terms);

    const request = await createApprovalRequest(tx, {
      bankId: corporate.bankId,
      corporateId,
      klass: "BANK_GOVERNANCE",
      targetType: "agreementVersion",
      targetId: versionId,
      targetRevision: versionNo,
      payloadHash: termsHash,
      summary: {
        kind: "AGREEMENT_VERSION",
        corporateName: corporate.legalName,
        corporateNameAr: corporate.legalNameAr,
        versionNo,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveUntil: effectiveUntil.toISOString(),
        changeReason: proposal.changeReason,
        modules: proposal.terms.moduleTerms.map((terms) => terms.moduleId),
      },
      makerPersonId: person.personId,
      requiredApprovals: 1,
      // One open revision per agreement: a second proposal must wait for the decision.
      activeKey: `agreement:${agreement.id}`,
    });

    await tx.agreementVersion.create({
      data: {
        id: versionId,
        agreementId: agreement.id,
        bankId: corporate.bankId,
        corporateId,
        versionNo,
        status: "PENDING_APPROVAL",
        segment: proposal.terms.segment,
        effectiveFrom,
        effectiveUntil,
        terms: JSON.parse(canonicalJson(proposal.terms)) as Prisma.InputJsonValue,
        termsHash,
        signatureEvidence: proposal.signatureEvidence as Prisma.InputJsonValue,
        changeReason: proposal.changeReason,
        proposedByPersonId: person.personId,
        approvalRequestId: request.id,
      },
    });
    await tx.moduleEntitlement.createMany({ data: rows.entitlements });
    const created = await tx.moduleEntitlement.findMany({ where: { agreementVersionId: versionId }, select: { id: true, moduleId: true } });
    const byModule = new Map(created.map((row) => [row.moduleId, row.id]));
    if (rows.entitlementAccounts.length > 0) {
      await tx.moduleEntitlementAccount.createMany({
        data: rows.entitlementAccounts.map((row) => ({
          entitlementId: byModule.get(row.moduleId) as string,
          accountId: row.accountId,
          corporateId,
          allowDebit: row.allowDebit,
          allowCredit: row.allowCredit,
        })),
      });
    }
    if (rows.limitRules.length > 0) await tx.limitRule.createMany({ data: rows.limitRules });
    if (rows.feeRules.length > 0) await tx.feeRule.createMany({ data: rows.feeRules });
    if (rows.approvalRules.length > 0) await tx.approvalRule.createMany({ data: rows.approvalRules });

    await writeAudit(tx, bankCtx, {
      action: "agreement.version.proposed",
      targetType: "agreementVersion",
      targetId: versionId,
      corporateId,
      reason: proposal.changeReason,
      proposalRevision: versionNo,
      changes: { versionNo, termsHash, effectiveFrom: effectiveFrom.toISOString(), effectiveUntil: effectiveUntil.toISOString() },
    });
  });
}

async function activateVersion(tx: Tx, versionId: string, ctx: AuthContext, deps: Deps): Promise<void> {
  const version = await tx.agreementVersion.findUniqueOrThrow({ where: { id: versionId } });
  await tx.$queryRaw`SELECT "id" FROM "Agreement" WHERE "id" = ${version.agreementId}::uuid FOR UPDATE`;
  const agreement = await tx.agreement.findUniqueOrThrow({ where: { id: version.agreementId } });
  if (agreement.status === "CLOSED") throw conflict("This agreement is closed.");
  if (version.status !== "PENDING_APPROVAL") throw conflict("This revision is no longer pending.");

  const now = deps.clock.now();
  if (version.effectiveUntil.getTime() <= now.getTime()) throw conflict("The validity period of this revision has already ended.");
  const immediate = version.effectiveFrom.getTime() <= now.getTime();
  const cut = immediate ? now : version.effectiveFrom;

  // Keep the current version until its successor takes effect; never two binding at once.
  const binding = await tx.agreementVersion.findMany({
    where: { agreementId: agreement.id, status: { in: ["APPROVED", "EFFECTIVE"] }, id: { not: version.id } },
  });
  for (const other of binding) {
    if (other.effectiveUntil.getTime() <= cut.getTime()) continue;
    if (other.effectiveFrom.getTime() >= cut.getTime() || immediate) {
      await tx.agreementVersion.update({
        where: { id: other.id },
        data: {
          status: "SUPERSEDED",
          ...(other.effectiveFrom.getTime() < cut.getTime() ? { effectiveUntil: cut } : {}),
          version: { increment: 1 },
        },
      });
    } else {
      await tx.agreementVersion.update({ where: { id: other.id }, data: { effectiveUntil: cut, version: { increment: 1 } } });
    }
  }

  const approver = requirePerson(ctx);
  await tx.agreementVersion.update({
    where: { id: version.id },
    data: {
      status: immediate ? "EFFECTIVE" : "APPROVED",
      approvedByPersonId: approver.personId,
      approvedAt: now,
      version: { increment: 1 },
    },
  });
  if (agreement.status === "DRAFT") {
    await tx.agreement.update({ where: { id: agreement.id }, data: { status: "ACTIVE", version: { increment: 1 } } });
  }
  await writeAudit(tx, ctx, {
    action: "agreement.version.activated",
    targetType: "agreementVersion",
    targetId: version.id,
    corporateId: version.corporateId,
    proposalRevision: version.versionNo,
    changes: { status: immediate ? "EFFECTIVE" : "APPROVED", effectiveFrom: version.effectiveFrom.toISOString(), termsHash: version.termsHash },
  });
}

/**
 * Worker maintenance: an approved future revision becomes EFFECTIVE when its start passes and
 * the revision it replaces (already truncated to that instant at approval) becomes SUPERSEDED.
 * Enforcement never depends on this label — `loadAgreementStatus` decides by time — so a late
 * sweep only delays the wording, never the control.
 */
export async function promoteDueAgreementVersions(deps: Deps, limit = 50): Promise<number> {
  const now = deps.clock.now();
  const due = await deps.db.agreementVersion.findMany({
    where: { status: "APPROVED", effectiveFrom: { lte: now }, effectiveUntil: { gt: now } },
    select: { id: true, agreementId: true },
    orderBy: { effectiveFrom: "asc" },
    take: limit,
  });
  let promoted = 0;
  for (const row of due) {
    const done = await inTx(
      deps.db,
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Agreement" WHERE "id" = ${row.agreementId}::uuid FOR UPDATE`;
        const version = await tx.agreementVersion.findUnique({ where: { id: row.id } });
        if (!version || version.status !== "APPROVED" || version.effectiveFrom.getTime() > now.getTime()) return false;
        await tx.agreementVersion.updateMany({
          where: { agreementId: version.agreementId, status: "EFFECTIVE", effectiveUntil: { lte: version.effectiveFrom } },
          data: { status: "SUPERSEDED", version: { increment: 1 } },
        });
        await tx.agreementVersion.update({ where: { id: version.id }, data: { status: "EFFECTIVE", version: { increment: 1 } } });
        await tx.auditEvent.create({
          data: {
            bankId: version.bankId,
            corporateId: version.corporateId,
            actorKind: "SERVICE",
            actorService: "maintenance",
            action: "agreement.version.effective",
            targetType: "agreementVersion",
            targetId: version.id,
            correlationId: `maintenance_${version.id}`,
            proposalRevision: version.versionNo,
            changes: { before: "APPROVED", after: "EFFECTIVE" },
            result: "SUCCESS",
          },
        });
        return true;
      },
      { skipIdempotency: true },
    );
    if (done) promoted += 1;
  }
  return promoted;
}

registerApprovalTarget("agreementVersion", {
  onApproved: async (tx, request, ctx, deps) => activateVersion(tx, request.targetId, ctx, deps),
  onRejected: async (tx, request, ctx, _deps, reason) => {
    await tx.agreementVersion.update({
      where: { id: request.targetId },
      data: { status: "REJECTED", decisionReason: reason, version: { increment: 1 } },
    });
    await writeAudit(tx, ctx, {
      action: "agreement.version.rejected",
      targetType: "agreementVersion",
      targetId: request.targetId,
      corporateId: request.corporateId,
      reason,
      proposalRevision: request.targetRevision,
    });
  },
});

/** Emergency stop: immediate, single authorized person, mandatory reason, fully audited. */
export async function suspendAgreement(deps: Deps, ctx: AuthContext, corporateId: string, reason: string, expectedVersion: number): Promise<void> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.corporate.suspend");
  const person = requirePerson(bankCtx);
  await corporateInBank(deps, bankCtx, corporateId);
  await inTx(deps.db, async (tx) => {
    const agreement = await tx.agreement.findUnique({ where: { corporateId } });
    if (!agreement) throw notFound();
    if (agreement.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (agreement.status !== "ACTIVE") throw conflict("Only an active agreement can be suspended.");
    await tx.agreement.update({
      where: { id: agreement.id },
      data: {
        status: "SUSPENDED",
        suspendedAt: deps.clock.now(),
        suspendedByPersonId: person.personId,
        suspensionReason: reason,
        version: { increment: 1 },
      },
    });
    await writeAudit(tx, bankCtx, {
      action: "agreement.suspended",
      targetType: "agreement",
      targetId: agreement.id,
      corporateId,
      reason,
      changes: { before: "ACTIVE", after: "SUSPENDED" },
    });
  });
}

export async function proposeRestore(deps: Deps, ctx: AuthContext, corporateId: string, reason: string, proposalId: string): Promise<void> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.agreement.propose");
  const person = requirePerson(bankCtx);
  const corporate = await corporateInBank(deps, bankCtx, corporateId);
  await inTx(deps.db, async (tx) => {
    const agreement = await tx.agreement.findUnique({ where: { corporateId } });
    if (!agreement) throw notFound();
    if (agreement.status !== "SUSPENDED") throw conflict("Only a suspended agreement can be restored.");
    const request = await createApprovalRequest(tx, {
      bankId: corporate.bankId,
      corporateId,
      klass: "BANK_GOVERNANCE",
      targetType: "agreementRestore",
      targetId: proposalId,
      targetRevision: agreement.version,
      payloadHash: digestOf({ agreementId: agreement.id, reason, agreementVersion: agreement.version }),
      summary: { kind: "AGREEMENT_RESTORE", corporateName: corporate.legalName, corporateNameAr: corporate.legalNameAr, reason },
      makerPersonId: person.personId,
      requiredApprovals: 1,
      activeKey: `agreement-restore:${agreement.id}`,
    });
    await tx.agreementRestoreProposal.create({
      data: {
        id: proposalId,
        bankId: corporate.bankId,
        corporateId,
        agreementId: agreement.id,
        status: "PENDING_APPROVAL",
        reason,
        proposedByPersonId: person.personId,
        approvalRequestId: request.id,
      },
    });
    await writeAudit(tx, bankCtx, {
      action: "agreement.restore.proposed",
      targetType: "agreement",
      targetId: agreement.id,
      corporateId,
      reason,
    });
  });
}

registerApprovalTarget("agreementRestore", {
  onApproved: async (tx, request, ctx) => {
    const proposal = await tx.agreementRestoreProposal.findUniqueOrThrow({ where: { id: request.targetId } });
    const agreement = await tx.agreement.findUniqueOrThrow({ where: { id: proposal.agreementId } });
    if (agreement.status !== "SUSPENDED") throw conflict("The agreement is no longer suspended.");
    await tx.agreement.update({
      where: { id: agreement.id },
      data: { status: "ACTIVE", suspendedAt: null, suspendedByPersonId: null, suspensionReason: null, version: { increment: 1 } },
    });
    await tx.agreementRestoreProposal.update({ where: { id: proposal.id }, data: { status: "APPROVED" } });
    await writeAudit(tx, ctx, {
      action: "agreement.restored",
      targetType: "agreement",
      targetId: agreement.id,
      corporateId: proposal.corporateId,
      changes: { before: "SUSPENDED", after: "ACTIVE" },
    });
  },
  onRejected: async (tx, request, ctx, _deps, reason) => {
    await tx.agreementRestoreProposal.update({ where: { id: request.targetId }, data: { status: "REJECTED" } });
    await writeAudit(tx, ctx, {
      action: "agreement.restore.rejected",
      targetType: "agreementRestore",
      targetId: request.targetId,
      corporateId: request.corporateId,
      reason,
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

export type AgreementVersionView = {
  id: string;
  versionNo: number;
  status: string;
  segment: string;
  effectiveFrom: string;
  effectiveUntil: string;
  changeReason: string;
  termsHash: string;
  proposedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  approvalRequestId: string | null;
  createdAt: string;
  terms: AgreementTerms;
  signatureEvidence: unknown;
};

export type AgreementOverview = {
  corporate: { id: string; legalName: string; legalNameAr: string; segment: string; status: string };
  agreement: { id: string; status: string; version: number; suspensionReason: string | null; suspendedAt: string | null } | null;
  /** Derived operational state at this instant. */
  state: AgreementState;
  effectiveVersionId: string | null;
  versions: AgreementVersionView[];
  accounts: Array<{ id: string; name: string; nameAr: string; maskedNumber: string; kind: string; currency: string; status: string }>;
  /** A restore proposal awaiting an independent decision. Bank view only. */
  pendingRestore: { id: string; reason: string; proposedBy: string; approvalRequestId: string | null } | null;
};

async function buildOverview(deps: Deps, corporateId: string): Promise<AgreementOverview> {
  const corporate = await deps.db.corporate.findUniqueOrThrow({ where: { id: corporateId } });
  const agreement = await deps.db.agreement.findUnique({
    where: { corporateId },
    include: { versions: { orderBy: { versionNo: "desc" } } },
  });
  const status = await loadAgreementStatus(deps.db, corporateId, deps.clock.now());
  const personIds = new Set<string>();
  for (const version of agreement?.versions ?? []) {
    personIds.add(version.proposedByPersonId);
    if (version.approvedByPersonId) personIds.add(version.approvedByPersonId);
  }
  const people = await deps.db.person.findMany({ where: { id: { in: [...personIds] } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  const accounts = await deps.db.account.findMany({ where: { corporateId }, orderBy: { createdAt: "asc" } });
  const restore = agreement
    ? await deps.db.agreementRestoreProposal.findFirst({ where: { agreementId: agreement.id, status: "PENDING_APPROVAL" }, orderBy: { createdAt: "desc" } })
    : null;
  const restoreMaker = restore ? await deps.db.person.findUnique({ where: { id: restore.proposedByPersonId }, select: { name: true } }) : null;
  return {
    pendingRestore: restore
      ? { id: restore.id, reason: restore.reason, proposedBy: restoreMaker?.name ?? "", approvalRequestId: restore.approvalRequestId }
      : null,
    corporate: {
      id: corporate.id,
      legalName: corporate.legalName,
      legalNameAr: corporate.legalNameAr,
      segment: corporate.segment,
      status: corporate.status,
    },
    agreement: agreement
      ? {
          id: agreement.id,
          status: agreement.status,
          version: agreement.version,
          suspensionReason: agreement.suspensionReason,
          suspendedAt: agreement.suspendedAt?.toISOString() ?? null,
        }
      : null,
    state: status.state,
    effectiveVersionId: status.policy?.agreementVersionId ?? null,
    versions: (agreement?.versions ?? []).map((version) => ({
      id: version.id,
      versionNo: version.versionNo,
      status: version.status,
      segment: version.segment,
      effectiveFrom: version.effectiveFrom.toISOString(),
      effectiveUntil: version.effectiveUntil.toISOString(),
      changeReason: version.changeReason,
      termsHash: version.termsHash,
      proposedBy: names.get(version.proposedByPersonId) ?? "",
      approvedBy: version.approvedByPersonId ? (names.get(version.approvedByPersonId) ?? "") : null,
      approvedAt: version.approvedAt?.toISOString() ?? null,
      decisionReason: version.decisionReason,
      approvalRequestId: version.approvalRequestId,
      createdAt: version.createdAt.toISOString(),
      terms: agreementTermsSchema.parse(version.terms),
      signatureEvidence: version.signatureEvidence,
    })),
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      nameAr: account.nameAr,
      maskedNumber: account.maskedNumber,
      kind: account.kind,
      currency: account.currency,
      status: account.status,
    })),
  };
}

/** Bank view of one corporate's agreement, including full revision history. */
export async function getBankAgreementOverview(deps: Deps, ctx: AuthContext, corporateId: string): Promise<AgreementOverview> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.corporates.read");
  await corporateInBank(deps, bankCtx, corporateId);
  return buildOverview(deps, corporateId);
}

/** Corporate read-only view. Remains available when operational modules are off (AGR-01). */
export async function getCorporateAgreement(deps: Deps, ctx: AuthContext): Promise<AgreementOverview> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "agreement.read");
  const overview = await buildOverview(deps, corporateCtx.corporateId);
  // The corporate sees decided history only, not the bank's pending or rejected drafts.
  return {
    ...overview,
    pendingRestore: null,
    versions: overview.versions.filter((version) => ["APPROVED", "EFFECTIVE", "SUPERSEDED"].includes(version.status)),
  };
}

/**
 * Starting point for a proposal: the synthetic segment template with this corporate's own
 * accounts. It is test policy, not a bank-approved or CBL default (AGR-02).
 */
export async function getAgreementTemplate(
  deps: Deps,
  ctx: AuthContext,
  corporateId: string,
  segment?: AgreementTerms["segment"],
): Promise<AgreementTerms> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.agreement.propose");
  const corporate = await corporateInBank(deps, bankCtx, corporateId);
  const accounts = await deps.db.account.findMany({ where: { corporateId: corporate.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  const ids = (kinds: string[]) => accounts.filter((account) => kinds.includes(account.kind)).map((account) => account.id);
  const payroll = ids(["PAYROLL"]);
  return segmentTemplate(segment ?? corporate.segment, {
    all: accounts.map((account) => account.id),
    payments: ids(["OPERATING", "SAVINGS"]),
    payroll: payroll.length > 0 ? payroll : ids(["OPERATING"]),
    collections: ids(["OPERATING", "COLLECTION"]),
  });
}

export type BankCorporateRow = {
  id: string;
  legalName: string;
  legalNameAr: string;
  segment: string;
  status: string;
  agreementStatus: string;
  state: AgreementState;
  pendingProposal: boolean;
};

export async function listBankCorporates(deps: Deps, ctx: AuthContext): Promise<BankCorporateRow[]> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.corporates.read");
  const corporates = await deps.db.corporate.findMany({
    where: { bankId: bankCtx.bankId },
    include: { agreement: true },
    orderBy: { legalName: "asc" },
  });
  const now = deps.clock.now();
  const out: BankCorporateRow[] = [];
  for (const corporate of corporates) {
    const status = await loadAgreementStatus(deps.db, corporate.id, now);
    const pending = corporate.agreement
      ? await deps.db.agreementVersion.count({ where: { agreementId: corporate.agreement.id, status: "PENDING_APPROVAL" } })
      : 0;
    out.push({
      id: corporate.id,
      legalName: corporate.legalName,
      legalNameAr: corporate.legalNameAr,
      segment: corporate.segment,
      status: corporate.status,
      agreementStatus: corporate.agreement?.status ?? "NONE",
      state: status.state,
      pendingProposal: pending > 0,
    });
  }
  return out;
}

/** Version under review with the diff against the version it would replace. */
export async function getAgreementVersionReview(
  deps: Deps,
  ctx: AuthContext,
  versionId: string,
): Promise<{ version: AgreementVersionView; changes: TermsChange[]; previousVersionNo: number | null; corporateId: string }> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.corporates.read");
  const row = await deps.db.agreementVersion.findFirst({ where: { id: versionId, bankId: bankCtx.bankId } });
  if (!row) throw notFound();
  const overview = await buildOverview(deps, row.corporateId);
  const version = overview.versions.find((entry) => entry.id === versionId) as AgreementVersionView;
  const previous =
    overview.versions.find((entry) => entry.versionNo < version.versionNo && ["EFFECTIVE", "APPROVED", "SUPERSEDED"].includes(entry.status)) ?? null;
  return {
    version,
    changes: diffTerms(previous?.terms ?? null, version.terms),
    previousVersionNo: previous?.versionNo ?? null,
    corporateId: row.corporateId,
  };
}
