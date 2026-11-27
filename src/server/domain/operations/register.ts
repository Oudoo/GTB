/**
 * Bank operations: repair approval target and the job that executes an approved repair.
 * Imported for its side effects by `src/server/bootstrap.ts` so the web app, the worker, the
 * seed and the tests all register the same handlers.
 *
 * The vote transaction only records the decision and queues a job: the adapter is never
 * called inside a platform transaction. The job inquires on the ORIGINAL reference again
 * before it acts, so a posting that surfaced after the proposal is acknowledged instead of
 * being sent twice (DEC-012).
 */
import { conflict } from "@/contracts/errors";
import { writeAudit } from "@/server/audit/audit";
import { requirePerson } from "@/server/auth/context";
import { inTx } from "@/server/db/client";
import { registerApprovalTarget } from "@/server/domain/approvals/service";
import { declareFailedUnposted, resubmitSameReference } from "@/server/domain/execution/engine";
import { enqueueJob } from "@/server/jobs/queue";
import { payloadString, registerJobHandler } from "@/server/jobs/runner";
import { JOB_RECON_RUN, executeReconciliationRun } from "./reconciliation";

export const JOB_REPAIR_EXECUTE = "repair.execute";

registerApprovalTarget("repairProposal", {
  checkVoter: async (tx, request) => {
    const proposal = await tx.repairProposal.findUnique({ where: { id: request.targetId } });
    if (!proposal || proposal.status !== "PENDING_APPROVAL") throw conflict("This repair proposal is no longer awaiting a decision.");
    const attempt = await tx.executionAttempt.findUniqueOrThrow({ where: { id: proposal.attemptId } });
    // The outcome may have been resolved by an inquiry in the meantime.
    if (attempt.state !== "UNKNOWN") throw conflict("The execution is no longer unknown; this repair is not needed.");
  },
  onApproved: async (tx, request, ctx) => {
    const approver = requirePerson(ctx);
    const proposal = await tx.repairProposal.findUniqueOrThrow({ where: { id: request.targetId } });
    await tx.repairProposal.update({ where: { id: proposal.id }, data: { status: "APPROVED" } });
    await enqueueJob(tx, {
      type: JOB_REPAIR_EXECUTE,
      payload: { proposalId: proposal.id, approverPersonId: approver.personId },
      dedupKey: `repair-execute:${proposal.id}`,
      bankId: proposal.bankId,
      corporateId: proposal.corporateId,
      aggregateType: "repairProposal",
      aggregateId: proposal.id,
      correlationId: ctx.correlationId,
    });
    await writeAudit(tx, ctx, {
      action: "repair.approved",
      targetType: "executionAttempt",
      targetId: proposal.attemptId,
      corporateId: proposal.corporateId,
      changes: { proposalId: proposal.id, action: proposal.action },
    });
  },
  onRejected: async (tx, request, ctx, _deps, reason) => {
    const proposal = await tx.repairProposal.findUniqueOrThrow({ where: { id: request.targetId } });
    await tx.repairProposal.update({ where: { id: proposal.id }, data: { status: "REJECTED", activeKey: null } });
    await writeAudit(tx, ctx, {
      action: "repair.rejected",
      targetType: "executionAttempt",
      targetId: proposal.attemptId,
      corporateId: proposal.corporateId,
      reason,
      changes: { proposalId: proposal.id, action: proposal.action },
    });
  },
  onExpired: async (tx, request) => {
    await tx.repairProposal.updateMany({ where: { id: request.targetId, status: "PENDING_APPROVAL" }, data: { status: "REJECTED", activeKey: null, outcome: { expired: true } } });
  },
});

registerJobHandler(JOB_REPAIR_EXECUTE, async (job, deps) => {
  const proposalId = payloadString(job, "proposalId");
  const approverPersonId = payloadString(job, "approverPersonId");
  const proposal = await deps.db.repairProposal.findUnique({ where: { id: proposalId } });
  if (!proposal || proposal.status !== "APPROVED") return { kind: "done" };

  const result =
    proposal.action === "RESUBMIT_SAME_REFERENCE"
      ? await resubmitSameReference(deps, proposal.attemptId, approverPersonId)
      : await declareFailedUnposted(deps, proposal.attemptId, approverPersonId);
  // The core did not answer: nothing was changed, try the same safe step again later.
  if (result === "UNAVAILABLE") return { kind: "retry", at: new Date(deps.clock.now().getTime() + 30_000), code: "CORE_UNAVAILABLE" };

  await inTx(
    deps.db,
    async (tx) => {
      const attempt = await tx.executionAttempt.findUniqueOrThrow({ where: { id: proposal.attemptId } });
      const updated = await tx.repairProposal.updateMany({
        where: { id: proposal.id, status: "APPROVED" },
        data: { status: "EXECUTED", activeKey: null, outcome: { result, attemptState: attempt.state, executionReference: attempt.executionReference } },
      });
      if (updated.count !== 1) return;
      await tx.auditEvent.create({
        data: {
          bankId: proposal.bankId,
          corporateId: proposal.corporateId,
          actorKind: "SERVICE",
          actorService: "worker",
          action: "repair.executed",
          targetType: "executionAttempt",
          targetId: proposal.attemptId,
          correlationId: job.correlationId ?? `job_${job.id}`,
          changes: { proposalId: proposal.id, action: proposal.action, result, attemptState: attempt.state, reference: attempt.executionReference },
          result: "SUCCESS",
        },
      });
    },
    { skipIdempotency: true },
  );
  return { kind: "done" };
});

registerJobHandler(JOB_RECON_RUN, async (job, deps) => {
  await executeReconciliationRun(deps, payloadString(job, "runId"));
  return { kind: "done" };
});
