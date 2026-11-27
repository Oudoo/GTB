import { payloadString, registerJobHandler } from "@/server/jobs/runner";
import {
  JOB_ATTEMPT_ADVANCE,
  JOB_ATTEMPT_INQUIRE,
  JOB_ATTEMPT_RETURN_CHECK,
  advanceAttempt,
  checkForReturn,
  inquireAttempt,
} from "./engine";

registerJobHandler(JOB_ATTEMPT_ADVANCE, async (job, deps) => {
  const result = await advanceAttempt(deps, payloadString(job, "attemptId"));
  if (result.kind === "poll") return { kind: "poll", at: result.at };
  if (result.kind === "retry") return { kind: "retry", at: result.at, code: result.code };
  return { kind: "done" };
});

registerJobHandler(JOB_ATTEMPT_INQUIRE, async (job, deps) => {
  const outcome = await inquireAttempt(deps, payloadString(job, "attemptId"), { service: "worker" });
  if (outcome === "BOOKED" || outcome === "NOT_UNKNOWN") return { kind: "done" };
  // Not found / unavailable: ask again later, a bounded number of times. After that the item
  // stays "result being checked" for operations — it is never retried blindly (DEC-012).
  if (job.attempts >= job.maxAttempts) return { kind: "dead", code: `INQUIRY_${outcome}` };
  return {
    kind: "retry",
    at: new Date(deps.clock.now().getTime() + deps.settings.autoInquiryDelaySeconds * 1000 * Math.min(job.attempts + 1, 4)),
    code: `INQUIRY_${outcome}`,
  };
});

registerJobHandler(JOB_ATTEMPT_RETURN_CHECK, async (job, deps) => {
  await checkForReturn(deps, payloadString(job, "attemptId"));
  return { kind: "done" };
});
