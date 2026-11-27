/**
 * Maker-checker decisions for every approval class (APR-01..03, AGR-02, COL-02, OPS-01).
 *
 * One vote transaction: lock the request row → check version/hash → check the voter is an
 * eligible, DIFFERENT human → insert the unique vote → count quorum → transition exactly once
 * and run the target's effect (reservation, job, activation…) in the same commit.
 *
 * Guarantees: a person never approves their own proposal whatever roles they hold; a repeated
 * or racing click returns the existing vote without adding a second; two final checkers racing
 * produce one transition; a vote is bound to the exact revision and payload hash it reviewed.
 */
import { DomainError, conflict, notFound } from "@/contracts/errors";
import { writeAudit } from "@/server/audit/audit";
import { requirePerson, rightsFor, type AuthContext } from "@/server/auth/context";
import { APPROVAL_CLASS_PERMISSION, type ApprovalClassName } from "@/server/auth/permissions";
import { inTx, isUniqueViolation, type Db, type DbOrTx, type Prisma, type Tx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import type { ApprovalRequest } from "@/generated/prisma/client";

export type ApprovalTargetHandler = {
  /**
   * Runs in the vote transaction when quorum is reached. May throw a DomainError (for example
   * a limit that can no longer be reserved): the vote is then NOT recorded and nothing changes.
   */
  onApproved: (tx: Tx, request: ApprovalRequest, ctx: AuthContext, deps: Deps) => Promise<void>;
  onRejected: (tx: Tx, request: ApprovalRequest, ctx: AuthContext, deps: Deps, reason: string) => Promise<void>;
  /** Extra target-specific eligibility (called for every vote, inside the transaction). */
  checkVoter?: (tx: Tx, request: ApprovalRequest, ctx: AuthContext, deps: Deps) => Promise<void>;
};

const handlers = new Map<string, ApprovalTargetHandler>();

export function registerApprovalTarget(targetType: string, handler: ApprovalTargetHandler): void {
  handlers.set(targetType, handler);
}

export type NewApprovalRequest = {
  bankId: string;
  corporateId: string | null;
  klass: ApprovalClassName;
  targetType: string;
  targetId: string;
  targetRevision: number;
  payloadHash: string;
  /** Redacted display summary. Must not contain payroll row detail. */
  summary: Prisma.InputJsonValue;
  makerPersonId: string;
  requiredApprovals: number;
  policyVersion?: number;
  policySnapshot?: Prisma.InputJsonValue;
  sourceAccountId?: string | null;
  branchId?: string | null;
  amountMinor?: bigint | null;
  currency?: string | null;
  expiresAt?: Date | null;
  /** Uniqueness scope while pending; defaults to `<targetType>:<targetId>`. */
  activeKey?: string;
};

export async function createApprovalRequest(tx: Tx, input: NewApprovalRequest): Promise<ApprovalRequest> {
  if (input.requiredApprovals < 1) throw new DomainError("APPROVAL_POLICY_UNAVAILABLE");
  try {
    return await tx.approvalRequest.create({
      data: {
        bankId: input.bankId,
        corporateId: input.corporateId,
        klass: input.klass,
        targetType: input.targetType,
        targetId: input.targetId,
        targetRevision: input.targetRevision,
        payloadHash: input.payloadHash,
        summary: input.summary,
        makerPersonId: input.makerPersonId,
        requiredApprovals: input.requiredApprovals,
        policyVersion: input.policyVersion ?? 1,
        ...(input.policySnapshot !== undefined ? { policySnapshot: input.policySnapshot } : {}),
        sourceAccountId: input.sourceAccountId ?? null,
        branchId: input.branchId ?? null,
        amountMinor: input.amountMinor ?? null,
        currency: input.currency ?? null,
        expiresAt: input.expiresAt ?? null,
        activeKey: input.activeKey ?? `${input.targetType}:${input.targetId}`,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("A decision is already pending for this item.");
    throw error;
  }
}

/** Close a pending request without a decision (revision replaced, cancelled, expired). */
export async function closeApprovalRequest(
  tx: Tx,
  requestId: string,
  state: "CANCELLED" | "SUPERSEDED" | "EXPIRED",
): Promise<boolean> {
  const updated = await tx.approvalRequest.updateMany({
    where: { id: requestId, state: "PENDING" },
    data: { state, activeKey: null, decidedAt: new Date(), version: { increment: 1 } },
  });
  return updated.count === 1;
}

/** Tenant scope: a request outside the caller's bank/corporate does not exist for them. */
function inScope(ctx: AuthContext, request: Pick<ApprovalRequest, "bankId" | "corporateId" | "klass" | "branchId">): boolean {
  if (request.bankId !== ctx.bankId) return false;
  const bankClass = request.klass === "BANK_GOVERNANCE" || request.klass === "BANK_REPAIR" || request.klass === "BRANCH_DEPOSIT";
  if (bankClass) {
    if (ctx.workspace !== "BANK") return false;
    // Branch staff only ever see their own branch's items.
    if (request.klass === "BRANCH_DEPOSIT" && ctx.branchId !== null && request.branchId !== ctx.branchId) return false;
    return true;
  }
  return ctx.workspace === "CORPORATE" && request.corporateId === ctx.corporateId;
}

export type Eligibility = { eligible: boolean; reason: "OK" | "OWN_PROPOSAL" | "NO_PERMISSION" | "NO_ACCOUNT_RIGHT" | "NOT_PERSON" | "WRONG_BRANCH" };

/** Whether this caller may vote on this request (used for hints; re-checked on every vote). */
export function voterEligibility(ctx: AuthContext, request: Pick<ApprovalRequest, "klass" | "makerPersonId" | "sourceAccountId" | "branchId">): Eligibility {
  if (ctx.principal.kind !== "person") return { eligible: false, reason: "NOT_PERSON" };
  // The human who made the proposal can never decide it, whatever roles they combine. This is
  // checked first so the refusal is explicit (and audited) rather than a generic denial.
  if (ctx.principal.personId === request.makerPersonId) return { eligible: false, reason: "OWN_PROPOSAL" };
  if (!ctx.permissions.has(APPROVAL_CLASS_PERMISSION[request.klass])) return { eligible: false, reason: "NO_PERMISSION" };
  if (request.klass === "PAYMENT" || request.klass === "BULK" || request.klass === "PAYROLL") {
    if (!request.sourceAccountId || !rightsFor(ctx, request.sourceAccountId).approve) return { eligible: false, reason: "NO_ACCOUNT_RIGHT" };
  }
  if (request.klass === "BRANCH_DEPOSIT" && (ctx.branchId === null || ctx.branchId !== request.branchId)) {
    return { eligible: false, reason: "WRONG_BRANCH" };
  }
  return { eligible: true, reason: "OK" };
}

export type VoteInput = {
  decision: "APPROVE" | "REJECT";
  /** Revision of the target the voter reviewed. */
  proposalVersion: number;
  proposalHash: string;
  reason?: string | undefined;
  /** `If-Match` version of the approval request itself. */
  expectedVersion: number;
};

export type VoteOutcome = { requestId: string; state: ApprovalRequest["state"]; approvalsCount: number; requiredApprovals: number; replayed: boolean };

export async function castVote(deps: Deps, ctx: AuthContext, requestId: string, input: VoteInput): Promise<VoteOutcome> {
  const person = requirePerson(ctx);
  if (input.decision === "REJECT") {
    const reason = input.reason?.trim() ?? "";
    if (reason.length < 3 || reason.length > 500) {
      throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "reason", rule: "length", message: "Give a reason between 3 and 500 characters." }] });
    }
  }

  const run = (tx: Tx) => voteInTx(tx, deps, ctx, person.personId, requestId, input);
  try {
    return await inTx(deps.db, run);
  } catch (error) {
    // Two requests from the same person raced past the "existing vote" check: the unique
    // (request, person) constraint let exactly one insert. Answer with that existing vote.
    if (isUniqueViolation(error)) return inTx(deps.db, run);
    if (error instanceof SelfApprovalError) await auditSelfApprovalDenied(deps.db, ctx, error.request);
    throw error;
  }
}

async function voteInTx(
  tx: Tx,
  deps: Deps,
  ctx: AuthContext,
  personId: string,
  requestId: string,
  input: VoteInput,
): Promise<VoteOutcome> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw notFound();
  const request = await tx.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (!inScope(ctx, request)) throw notFound();

  const existing = await tx.approvalVote.findUnique({
    where: { approvalRequestId_personId: { approvalRequestId: requestId, personId } },
  });
  if (existing) {
    // Idempotent: the same person's repeated decision returns the vote already counted.
    if (existing.decision !== input.decision) throw conflict("You already recorded a different decision for this proposal.");
    return {
      requestId,
      state: request.state,
      approvalsCount: request.approvalsCount,
      requiredApprovals: request.requiredApprovals,
      replayed: true,
    };
  }

  const eligibility = voterEligibility(ctx, request);
  if (!eligibility.eligible) {
    // The denial is audited by the caller, outside this (rolled back) transaction.
    if (eligibility.reason === "OWN_PROPOSAL") throw new SelfApprovalError(request);
    throw new DomainError("PERMISSION_DENIED");
  }

  if (request.state !== "PENDING") throw conflict("This proposal is no longer awaiting a decision.");
  if (request.expiresAt && request.expiresAt.getTime() <= deps.clock.now().getTime()) {
    throw conflict("The approval period for this proposal has ended.");
  }
  if (input.expectedVersion !== request.version) {
    throw new DomainError("VERSION_CONFLICT", { detail: "The proposal changed. Review the latest revision before deciding." });
  }
  if (input.proposalVersion !== request.targetRevision || input.proposalHash !== request.payloadHash) {
    throw new DomainError("VERSION_CONFLICT", { detail: "Your decision refers to an older revision of this proposal." });
  }

  const handler = handlers.get(request.targetType);
  if (!handler) throw new Error(`No approval handler for target type ${request.targetType}`);
  if (handler.checkVoter) await handler.checkVoter(tx, request, ctx, deps);

  await tx.approvalVote.create({
    data: {
      approvalRequestId: requestId,
      personId,
      membershipId: ctx.membershipId as string,
      decision: input.decision,
      reason: input.reason?.trim() || null,
      policyVersion: request.policyVersion,
    },
  });

  let updated: ApprovalRequest;
  if (input.decision === "REJECT") {
    updated = await tx.approvalRequest.update({
      where: { id: requestId },
      data: { state: "REJECTED", activeKey: null, decidedAt: deps.clock.now(), version: { increment: 1 } },
    });
    await handler.onRejected(tx, updated, ctx, deps, input.reason?.trim() ?? "");
  } else {
    const approvals = request.approvalsCount + 1;
    const quorum = approvals >= request.requiredApprovals;
    updated = await tx.approvalRequest.update({
      where: { id: requestId },
      data: {
        approvalsCount: approvals,
        version: { increment: 1 },
        ...(quorum ? { state: "APPROVED", activeKey: null, decidedAt: deps.clock.now() } : {}),
      },
    });
    if (quorum) await handler.onApproved(tx, updated, ctx, deps);
  }

  await writeAudit(tx, ctx, {
    action: input.decision === "APPROVE" ? "approval.approved" : "approval.rejected",
    targetType: request.targetType,
    targetId: request.targetId,
    reason: input.reason?.trim() || null,
    proposalRevision: request.targetRevision,
    corporateId: request.corporateId,
    changes: {
      approvalRequestId: requestId,
      klass: request.klass,
      approvalsCount: updated.approvalsCount,
      requiredApprovals: updated.requiredApprovals,
      state: updated.state,
      payloadHash: request.payloadHash,
    },
  });

  return {
    requestId,
    state: updated.state,
    approvalsCount: updated.approvalsCount,
    requiredApprovals: updated.requiredApprovals,
    replayed: false,
  };
}

/** Raised inside the vote transaction; the audit of the denial is written separately. */
class SelfApprovalError extends DomainError {
  constructor(readonly request: ApprovalRequest) {
    super("SELF_APPROVAL_FORBIDDEN");
  }
}

/** Record a denied self-approval outside the rolled-back vote transaction. */
export async function auditSelfApprovalDenied(db: Db, ctx: AuthContext, request: Pick<ApprovalRequest, "targetType" | "targetId" | "targetRevision" | "corporateId">): Promise<void> {
  await writeAudit(db, ctx, {
    action: "approval.vote",
    targetType: request.targetType,
    targetId: request.targetId,
    result: "DENIED",
    reason: "SELF_APPROVAL_FORBIDDEN",
    proposalRevision: request.targetRevision,
    corporateId: request.corporateId,
  });
}

export type ApprovalView = {
  id: string;
  klass: ApprovalRequest["klass"];
  targetType: string;
  targetId: string;
  targetRevision: number;
  payloadHash: string;
  summary: Prisma.JsonValue;
  state: ApprovalRequest["state"];
  requiredApprovals: number;
  approvalsCount: number;
  amount: { currency: string; minor: string } | null;
  sourceAccountId: string | null;
  maker: { personId: string; name: string };
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  version: number;
  /** Whether the CALLER may vote now, and why not. Re-checked on the server at vote time. */
  canAct: boolean;
  eligibility: Eligibility["reason"];
  votes: Array<{ personId: string; name: string; decision: "APPROVE" | "REJECT"; reason: string | null; at: string }>;
  myVote: "APPROVE" | "REJECT" | null;
};

type RequestWithVotes = ApprovalRequest & { votes: Array<{ personId: string; decision: "APPROVE" | "REJECT"; reason: string | null; createdAt: Date }> };

async function project(db: DbOrTx, ctx: AuthContext, rows: RequestWithVotes[]): Promise<ApprovalView[]> {
  const personIds = new Set<string>();
  for (const row of rows) {
    personIds.add(row.makerPersonId);
    for (const vote of row.votes) personIds.add(vote.personId);
  }
  const people = await db.person.findMany({ where: { id: { in: [...personIds] } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  const me = ctx.principal.kind === "person" ? ctx.principal.personId : null;
  return rows.map((row) => {
    const eligibility = voterEligibility(ctx, row);
    const mine = me ? row.votes.find((vote) => vote.personId === me) : undefined;
    return {
      id: row.id,
      klass: row.klass,
      targetType: row.targetType,
      targetId: row.targetId,
      targetRevision: row.targetRevision,
      payloadHash: row.payloadHash,
      summary: row.summary,
      state: row.state,
      requiredApprovals: row.requiredApprovals,
      approvalsCount: row.approvalsCount,
      amount: row.amountMinor !== null && row.currency ? { currency: row.currency, minor: row.amountMinor.toString() } : null,
      sourceAccountId: row.sourceAccountId,
      maker: { personId: row.makerPersonId, name: names.get(row.makerPersonId) ?? "" },
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      version: row.version,
      canAct: row.state === "PENDING" && eligibility.eligible && !mine,
      eligibility: eligibility.reason,
      votes: row.votes.map((vote) => ({
        personId: vote.personId,
        name: names.get(vote.personId) ?? "",
        decision: vote.decision,
        reason: vote.reason,
        at: vote.createdAt.toISOString(),
      })),
      myVote: mine?.decision ?? null,
    };
  });
}

/** Classes the caller may see in a queue: those they can decide, or (corporate) could have made. */
function visibleClasses(ctx: AuthContext): ApprovalRequest["klass"][] {
  const out = new Set<ApprovalRequest["klass"]>();
  for (const [klass, permission] of Object.entries(APPROVAL_CLASS_PERMISSION) as Array<[ApprovalClassName, (typeof APPROVAL_CLASS_PERMISSION)[ApprovalClassName]]>) {
    if (ctx.permissions.has(permission)) out.add(klass);
  }
  if (ctx.workspace === "CORPORATE") {
    if (ctx.permissions.has("payments.read")) out.add("PAYMENT");
    if (ctx.permissions.has("batches.read")) out.add("BULK");
    if (ctx.permissions.has("payroll.aggregate.read")) out.add("PAYROLL");
    if (ctx.permissions.has("admin.users.read")) out.add("CORPORATE_ADMIN");
  } else {
    if (ctx.permissions.has("bank.agreement.propose") || ctx.permissions.has("bank.rail.propose")) out.add("BANK_GOVERNANCE");
    if (ctx.permissions.has("bank.operations.read")) out.add("BANK_REPAIR");
    if (ctx.permissions.has("bank.deposits.read")) out.add("BRANCH_DEPOSIT");
  }
  return [...out];
}

function scopeWhere(ctx: AuthContext): Prisma.ApprovalRequestWhereInput {
  const classes = visibleClasses(ctx);
  if (ctx.workspace === "CORPORATE") {
    const readable = [...ctx.grants.entries()].filter(([, rights]) => rights.read).map(([id]) => id);
    return {
      bankId: ctx.bankId,
      corporateId: ctx.corporateId,
      klass: { in: classes.filter((klass) => klass === "PAYMENT" || klass === "BULK" || klass === "PAYROLL" || klass === "CORPORATE_ADMIN") },
      // Money proposals are visible only for accounts the caller may read.
      OR: [{ klass: "CORPORATE_ADMIN" }, { sourceAccountId: { in: readable } }],
    };
  }
  return {
    bankId: ctx.bankId,
    klass: { in: classes.filter((klass) => klass === "BANK_GOVERNANCE" || klass === "BANK_REPAIR" || klass === "BRANCH_DEPOSIT") },
    ...(ctx.branchId ? { OR: [{ klass: { not: "BRANCH_DEPOSIT" } }, { branchId: ctx.branchId }] } : {}),
  };
}

export async function listApprovals(
  deps: Deps,
  ctx: AuthContext,
  filter: { state?: "PENDING" | "DECIDED" | "ALL"; limit?: number; cursor?: string | null } = {},
): Promise<{ items: ApprovalView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const state = filter.state ?? "PENDING";
  const rows = await deps.db.approvalRequest.findMany({
    where: {
      AND: [
        scopeWhere(ctx),
        state === "PENDING" ? { state: "PENDING" } : state === "DECIDED" ? { state: { not: "PENDING" } } : {},
      ],
    },
    include: { votes: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: await project(deps.db, ctx, page),
    nextCursor: rows.length > limit ? ((page[page.length - 1] as RequestWithVotes).id ?? null) : null,
  };
}

export async function getApproval(deps: Deps, ctx: AuthContext, requestId: string): Promise<ApprovalView> {
  const row = await deps.db.approvalRequest.findFirst({
    where: { AND: [{ id: requestId }, scopeWhere(ctx)] },
    include: { votes: { orderBy: { createdAt: "asc" } } },
  });
  if (!row) throw notFound();
  return (await project(deps.db, ctx, [row]))[0] as ApprovalView;
}

/** Number of proposals the caller can decide right now (navigation badge; no PII). */
export async function countActionable(deps: Deps, ctx: AuthContext): Promise<number> {
  if (ctx.principal.kind !== "person") return 0;
  const personId = ctx.principal.personId;
  const rows = await deps.db.approvalRequest.findMany({
    where: { AND: [scopeWhere(ctx), { state: "PENDING", makerPersonId: { not: personId } }] },
    select: { klass: true, makerPersonId: true, sourceAccountId: true, branchId: true, votes: { where: { personId }, select: { id: true } } },
    take: 200,
  });
  return rows.filter((row) => row.votes.length === 0 && voterEligibility(ctx, row).eligible).length;
}
