/**
 * Bulk transfers and payroll runs: approval target, instruction observers and job handlers.
 * Imported for its side effects by `src/server/bootstrap.ts` so the web app, the worker, the
 * seed and the tests all register the same handlers.
 */
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { registerApprovalTarget } from "@/server/domain/approvals/service";
import { registerInstructionObserver } from "@/server/domain/execution/engine";
import { payloadString, registerJobHandler } from "@/server/jobs/runner";
import {
  JOB_BATCH_DISPATCH,
  JOB_BATCH_RELEASE,
  JOB_BATCH_VALIDATE,
  batchApprovalTarget,
  dispatchBatch,
  logValidationFailure,
  onRowInstructionChange,
  releaseBatch,
  validateBatch,
} from "./service";

registerApprovalTarget("batch", batchApprovalTarget);

registerInstructionObserver("BULK_ROW", onRowInstructionChange);
registerInstructionObserver("PAYROLL_ROW", onRowInstructionChange);

registerJobHandler(JOB_BATCH_VALIDATE, async (job, deps) => {
  const batchId = payloadString(job, "batchId");
  try {
    await validateBatch(deps, batchId);
    return { kind: "done" };
  } catch (error) {
    // The name check could not be made: keep the batch VALIDATING and try again. Rows are
    // never accepted unchecked.
    if (error instanceof CoreUnavailableError) return { kind: "retry", at: new Date(deps.clock.now().getTime() + 30_000), code: "CORE_UNAVAILABLE" };
    logValidationFailure(batchId, error);
    throw error;
  }
});

registerJobHandler(JOB_BATCH_RELEASE, async (job, deps) => {
  const outcome = await releaseBatch(deps, payloadString(job, "batchId"));
  if (outcome.kind === "defer") return { kind: "poll", at: outcome.at };
  return { kind: "done" };
});

registerJobHandler(JOB_BATCH_DISPATCH, async (job, deps) => {
  await dispatchBatch(deps, payloadString(job, "batchId"));
  return { kind: "done" };
});
