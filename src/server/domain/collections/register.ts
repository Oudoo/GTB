/**
 * Collections and deposits: approval target, job handlers and reconciliation source.
 * Imported for its side effects by `src/server/bootstrap.ts` so the web app, the worker, the
 * seed and the tests all register the same handlers.
 */
import { localDateToDbDate } from "@/lib/calendar";
import { registerApprovalTarget } from "@/server/domain/approvals/service";
import { registerAuditTargetLabeler } from "@/server/domain/audit/service";
import { registerReconciliationSource } from "@/server/domain/operations/reconciliation";
import { payloadString, registerJobHandler } from "@/server/jobs/runner";
import { JOB_DEPOSIT_INQUIRE, JOB_DEPOSIT_POST, depositApprovalTarget, inquireDeposit, postDeposit } from "./deposits";

registerApprovalTarget("deposit", depositApprovalTarget);

registerJobHandler(JOB_DEPOSIT_POST, async (job, deps) => {
  const outcome = await postDeposit(deps, payloadString(job, "depositId"));
  return outcome.kind === "retry" ? { kind: "retry", at: outcome.at, code: "CORE_UNAVAILABLE" } : { kind: "done" };
});

registerJobHandler(JOB_DEPOSIT_INQUIRE, async (job, deps) => {
  const outcome = await inquireDeposit(deps, payloadString(job, "depositId"));
  return outcome.kind === "retry" ? { kind: "retry", at: outcome.at, code: "CORE_UNAVAILABLE" } : { kind: "done" };
});

// A posted deposit is one core journal under the deposit's own reference.
registerReconciliationSource(async (db, scope) => {
  const posted = await db.deposit.findMany({ where: { bankId: scope.bankId, state: "POSTED", businessDate: localDateToDbDate(scope.businessDate) }, select: { executionReference: true, corporateId: true, amountMinor: true } });
  return posted.map((deposit) => ({ executionReference: deposit.executionReference, corporateId: deposit.corporateId, principalMinor: deposit.amountMinor, feeMinor: 0n, source: "DEPOSIT" }));
});

registerAuditTargetLabeler("deposit", async (db, ids) => {
  const rows = await db.deposit.findMany({ where: { id: { in: [...ids] } }, select: { id: true, intakeReference: true } });
  return new Map(rows.map((row) => [row.id, row.intakeReference]));
});
