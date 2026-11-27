/**
 * Bank payment operations (OPS-01, DEC-012): the attention queue, authoritative inquiry and
 * repair proposals.
 *
 * Operations staff never edit a ledger, a balance or a status. They can
 *   - look at executions of their OWN bank that failed, are unknown or are overdue;
 *   - ask the core about the ORIGINAL reference (every inquiry is recorded, not only the
 *     successful one);
 *   - PROPOSE one of two safe repairs for an unknown outcome the core does not know:
 *     resubmit with the same reference, or declare "failed, not posted". A different person
 *     with the repair-approval permission must approve, and the repair itself inquires again
 *     before it acts.
 * Payroll rows are masked here: operations sees references and states, not who was paid what.
 */
import { z } from "zod";
import { reasonSchema, safeCode } from "@/contracts/common";
import { DomainError, conflict, notFound } from "@/contracts/errors";
import { minorToJson, type MoneyJson } from "@/contracts/money";
import { writeAudit } from "@/server/audit/audit";
import { requireBank, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { inTx, type Prisma } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { createApprovalRequest } from "@/server/domain/approvals/service";
import { inquireAttempt, type InquiryOutcome } from "@/server/domain/execution/engine";
import { digestOf } from "@/server/hash";
import type { BusinessInstruction, ExecutionAttempt, RepairProposal } from "@/generated/prisma/client";

/** An in-flight attempt that has not moved for this long is shown as overdue. */
export const OVERDUE_AFTER_SECONDS = 300;

export const executionQuerySchema = z.strictObject({
  category: z.enum(["ATTENTION", "UNKNOWN", "FAILED", "OVERDUE", "ALL"]).optional(),
  reference: z.string().trim().min(1).max(64).optional(),
  corporateId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const repairProposalSchema = z.strictObject({
  action: z.enum(["RESUBMIT_SAME_REFERENCE", "MARK_FAILED_UNPOSTED"]),
  reason: reasonSchema,
  evidenceReference: safeCode(64).optional(),
});

export type ExecutionCategory = "UNKNOWN" | "FAILED" | "OVERDUE" | "IN_FLIGHT" | "BOOKED";

export type ExecutionView = {
  id: string;
  executionReference: string;
  attemptNo: number;
  state: ExecutionAttempt["state"];
  category: ExecutionCategory;
  unknownPhase: string | null;
  failureCode: string | null;
  instruction: {
    id: string;
    kind: BusinessInstruction["kind"];
    state: BusinessInstruction["state"];
    rail: string;
    transactionType: string;
    /** Null for confidential (payroll) rows: operations never sees a salary. */
    amount: MoneyJson | null;
    fee: MoneyJson | null;
    destinationName: string | null;
    destinationMasked: string | null;
    confidential: boolean;
    reference: string | null;
  };
  corporate: { id: string; name: string; nameAr: string };
  inquiryCount: number;
  lastInquiryAt: string | null;
  lastInquiryResult: string | null;
  bookedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** What this caller may do next. Re-checked on the server for every action. */
  actions: { inquire: boolean; proposeRepair: boolean };
  /** Why a repair cannot be proposed yet, for the screen. */
  repairBlockedBy: "NOT_UNKNOWN" | "INQUIRE_FIRST" | "CORE_HAS_POSTING" | "OPEN_PROPOSAL" | null;
  openProposal: { id: string; action: RepairProposal["action"]; status: RepairProposal["status"]; approvalRequestId: string | null } | null;
};

function maskReference(reference: string | null): string | null {
  if (!reference) return null;
  return reference.length <= 4 ? "••••" : `${reference.slice(0, reference.length - 6)}••${reference.slice(-4)}`;
}

function categoryOf(attempt: ExecutionAttempt, wallNow: number): ExecutionCategory {
  if (attempt.state === "UNKNOWN") return "UNKNOWN";
  if (attempt.state === "FAILED") return "FAILED";
  if (attempt.state === "BOOKED") return "BOOKED";
  return wallNow - attempt.updatedAt.getTime() > OVERDUE_AFTER_SECONDS * 1000 ? "OVERDUE" : "IN_FLIGHT";
}

type AttemptRow = ExecutionAttempt & { instruction: BusinessInstruction };

async function project(deps: Deps, ctx: AuthContext, rows: AttemptRow[]): Promise<ExecutionView[]> {
  const corporateIds = [...new Set(rows.map((row) => row.corporateId))];
  const corporates = await deps.db.corporate.findMany({ where: { id: { in: corporateIds } }, select: { id: true, legalName: true, legalNameAr: true } });
  const corporateById = new Map(corporates.map((corporate) => [corporate.id, corporate]));
  const paymentIds = rows.map((row) => row.instruction.paymentId).filter((id): id is string => id !== null);
  const payments = await deps.db.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, reference: true } });
  const paymentReference = new Map(payments.map((payment) => [payment.id, payment.reference]));
  const proposals = await deps.db.repairProposal.findMany({
    where: { attemptId: { in: rows.map((row) => row.id) }, status: "PENDING_APPROVAL" },
  });
  const openByAttempt = new Map(proposals.map((proposal) => [proposal.attemptId, proposal]));
  const canAct = ctx.permissions.has("bank.operations.act");
  // Row age is wall-clock process liveness, like the worker heartbeat.
  const wallNow = Date.now();

  return rows.map((row) => {
    const { instruction } = row;
    const corporate = corporateById.get(row.corporateId);
    const open = openByAttempt.get(row.id) ?? null;
    const confidential = instruction.confidential;
    let repairBlockedBy: ExecutionView["repairBlockedBy"] = null;
    if (row.state !== "UNKNOWN") repairBlockedBy = "NOT_UNKNOWN";
    else if (open) repairBlockedBy = "OPEN_PROPOSAL";
    else if (row.lastInquiryResult === null || row.lastInquiryResult === "UNAVAILABLE") repairBlockedBy = "INQUIRE_FIRST";
    else if (row.lastInquiryResult !== "NOT_FOUND") repairBlockedBy = "CORE_HAS_POSTING";
    return {
      id: row.id,
      executionReference: row.executionReference,
      attemptNo: row.attemptNo,
      state: row.state,
      category: categoryOf(row, wallNow),
      unknownPhase: row.unknownPhase,
      failureCode: row.failureCode,
      instruction: {
        id: instruction.id,
        kind: instruction.kind,
        state: instruction.state,
        rail: instruction.rail,
        transactionType: instruction.transactionType,
        amount: confidential ? null : minorToJson(instruction.amountMinor, instruction.currency),
        fee: confidential ? null : minorToJson(instruction.feeMinor, instruction.currency),
        destinationName: confidential ? null : instruction.destinationName,
        destinationMasked: confidential ? null : maskReference(instruction.destinationReference),
        confidential,
        reference: instruction.paymentId ? (paymentReference.get(instruction.paymentId) ?? null) : null,
      },
      corporate: { id: row.corporateId, name: corporate?.legalName ?? "", nameAr: corporate?.legalNameAr ?? "" },
      inquiryCount: row.inquiryCount,
      lastInquiryAt: row.lastInquiryAt?.toISOString() ?? null,
      lastInquiryResult: row.lastInquiryResult,
      bookedAt: row.bookedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      actions: { inquire: canAct && row.state === "UNKNOWN", proposeRepair: canAct && repairBlockedBy === null },
      repairBlockedBy,
      openProposal: open ? { id: open.id, action: open.action, status: open.status, approvalRequestId: open.approvalRequestId } : null,
    };
  });
}

export async function listExecutions(
  deps: Deps,
  ctx: AuthContext,
  query: z.infer<typeof executionQuerySchema>,
): Promise<{ items: ExecutionView[]; nextCursor: string | null; counts: { unknown: number; failed: number; overdue: number } }> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.operations.read");
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const category = query.category ?? "ATTENTION";
  const overdueBefore = new Date(Date.now() - OVERDUE_AFTER_SECONDS * 1000);
  const inFlight: Prisma.ExecutionAttemptWhereInput = { state: { in: ["INTENT", "HOLD_PLACED", "RAIL_SUBMITTED"] }, updatedAt: { lt: overdueBefore } };
  const byCategory: Record<typeof category, Prisma.ExecutionAttemptWhereInput> = {
    UNKNOWN: { state: "UNKNOWN" },
    FAILED: { state: "FAILED" },
    OVERDUE: inFlight,
    ATTENTION: { OR: [{ state: "UNKNOWN" }, inFlight] },
    ALL: {},
  };
  const where: Prisma.ExecutionAttemptWhereInput = {
    AND: [
      // The bank boundary comes from the session, never from a filter (SEC-01).
      { bankId: bankCtx.bankId },
      byCategory[category],
      query.reference ? { executionReference: { contains: query.reference.toUpperCase() } } : {},
      query.corporateId ? { corporateId: query.corporateId } : {},
    ],
  };
  const rows = await deps.db.executionAttempt.findMany({
    where,
    include: { instruction: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  const [unknown, failed, overdue] = await Promise.all([
    deps.db.executionAttempt.count({ where: { bankId: bankCtx.bankId, state: "UNKNOWN" } }),
    deps.db.executionAttempt.count({ where: { bankId: bankCtx.bankId, state: "FAILED" } }),
    deps.db.executionAttempt.count({ where: { AND: [{ bankId: bankCtx.bankId }, inFlight] } }),
  ]);
  return {
    items: await project(deps, bankCtx, page),
    nextCursor: rows.length > limit ? (page[page.length - 1] as AttemptRow).id : null,
    counts: { unknown, failed, overdue },
  };
}

async function loadScoped(deps: Deps, ctx: AuthContext, attemptId: string): Promise<AttemptRow> {
  const row = await deps.db.executionAttempt.findFirst({ where: { id: attemptId, bankId: ctx.bankId }, include: { instruction: true } });
  // Another bank's execution does not exist for this caller.
  if (!row) throw notFound();
  return row;
}

export type ExecutionDetail = ExecutionView & {
  history: Array<{ at: string; code: string; actor: string | null; service: string | null; reference: string | null }>;
  proposals: Array<{
    id: string;
    action: RepairProposal["action"];
    status: RepairProposal["status"];
    reason: string;
    evidenceReference: string | null;
    proposedBy: string;
    approvalRequestId: string | null;
    outcome: Prisma.JsonValue | null;
    createdAt: string;
  }>;
};

export async function getExecution(deps: Deps, ctx: AuthContext, attemptId: string): Promise<ExecutionDetail> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.operations.read");
  const row = await loadScoped(deps, bankCtx, attemptId);
  const [view] = await project(deps, bankCtx, [row]);
  const timeline = await deps.db.timelineEvent.findMany({
    where: { aggregateType: "instruction", aggregateId: row.instructionId },
    orderBy: { id: "asc" },
    take: 200,
  });
  const proposals = await deps.db.repairProposal.findMany({ where: { attemptId, bankId: bankCtx.bankId }, orderBy: { createdAt: "desc" } });
  const personIds = [...new Set([...timeline.map((event) => event.actorPersonId), ...proposals.map((proposal) => proposal.proposedByPersonId)].filter((id): id is string => id !== null))];
  const people = await deps.db.person.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  return {
    ...(view as ExecutionView),
    history: timeline.map((event) => ({
      at: event.at.toISOString(),
      code: event.code,
      actor: event.actorPersonId ? (names.get(event.actorPersonId) ?? null) : null,
      service: event.actorService,
      reference: event.reference,
    })),
    proposals: proposals.map((proposal) => ({
      id: proposal.id,
      action: proposal.action,
      status: proposal.status,
      reason: proposal.reason,
      evidenceReference: proposal.evidenceReference,
      proposedBy: names.get(proposal.proposedByPersonId) ?? "",
      approvalRequestId: proposal.approvalRequestId,
      outcome: proposal.outcome,
      createdAt: proposal.createdAt.toISOString(),
    })),
  };
}

/**
 * Ask the core about the original reference. Posted → the original booking is acknowledged
 * (never a second debit). Not found → the item STAYS unknown. Every call is audited.
 */
export async function inquireExecution(deps: Deps, ctx: AuthContext, attemptId: string): Promise<InquiryOutcome> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.operations.act");
  const person = requirePerson(bankCtx);
  const row = await loadScoped(deps, bankCtx, attemptId);
  if (row.state !== "UNKNOWN") throw conflict("Only an execution with an unknown outcome can be inquired.");
  const outcome = await inquireAttempt(deps, attemptId, { personId: person.personId });
  await writeAudit(deps.db, bankCtx, {
    action: "operations.inquiry",
    targetType: "executionAttempt",
    targetId: attemptId,
    corporateId: row.corporateId,
    changes: { executionReference: row.executionReference, outcome },
  });
  return outcome;
}

/** Propose a safe repair for an unknown outcome the core does not know about. */
export async function proposeRepair(deps: Deps, ctx: AuthContext, attemptId: string, rawInput: unknown, proposalId: string): Promise<void> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.operations.act");
  const person = requirePerson(bankCtx);
  const input = repairProposalSchema.parse(rawInput);
  const scoped = await loadScoped(deps, bankCtx, attemptId);
  const corporate = await deps.db.corporate.findUniqueOrThrow({ where: { id: scoped.corporateId } });

  await inTx(deps.db, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ExecutionAttempt" WHERE "id" = ${attemptId}::uuid FOR UPDATE`;
    const attempt = await tx.executionAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { instruction: true } });
    if (attempt.state !== "UNKNOWN") throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "Only an unknown outcome can be repaired." });
    // A repair is only meaningful after the core answered "not found" for the original reference.
    if (attempt.lastInquiryResult !== "NOT_FOUND") {
      throw new DomainError("STATUS_UNRESOLVED", { detail: "Inquire first: a repair can be proposed only after the core answered that it has no posting." });
    }
    const payloadHash = digestOf({
      attemptId,
      executionReference: attempt.executionReference,
      action: input.action,
      reason: input.reason,
      evidenceReference: input.evidenceReference ?? null,
      attemptVersion: attempt.version,
    });
    const { instruction } = attempt;
    const request = await createApprovalRequest(tx, {
      bankId: bankCtx.bankId,
      corporateId: null,
      klass: "BANK_REPAIR",
      targetType: "repairProposal",
      targetId: proposalId,
      targetRevision: attempt.inquiryCount,
      payloadHash,
      summary: {
        kind: "REPAIR",
        action: input.action,
        reference: attempt.executionReference,
        title: corporate.legalName,
        corporateName: corporate.legalName,
        corporateNameAr: corporate.legalNameAr,
        rail: instruction.rail,
        // Payroll rows stay masked for the approver as well.
        amount: instruction.confidential ? null : { currency: instruction.currency, minor: instruction.amountMinor.toString() },
        lastInquiryResult: attempt.lastInquiryResult,
        inquiryCount: attempt.inquiryCount,
        reason: input.reason,
        evidenceReference: input.evidenceReference ?? null,
        linkPath: `/bank/operations/${attemptId}`,
      },
      makerPersonId: person.personId,
      requiredApprovals: 1,
      // One open proposal per attempt.
      activeKey: `repair:${attemptId}`,
    });
    await tx.repairProposal.create({
      data: {
        id: proposalId,
        bankId: bankCtx.bankId,
        corporateId: attempt.corporateId,
        instructionId: attempt.instructionId,
        attemptId,
        action: input.action,
        reason: input.reason,
        evidenceReference: input.evidenceReference ?? null,
        payloadHash,
        status: "PENDING_APPROVAL",
        proposedByPersonId: person.personId,
        approvalRequestId: request.id,
        activeKey: attemptId,
      },
    });
    await writeAudit(tx, bankCtx, {
      action: "repair.proposed",
      targetType: "executionAttempt",
      targetId: attemptId,
      corporateId: attempt.corporateId,
      reason: input.reason,
      changes: { proposalId, action: input.action, executionReference: attempt.executionReference, evidenceReference: input.evidenceReference ?? null },
    });
  });
}
