/**
 * Reports: generation job.
 * Imported for its side effects by `src/server/bootstrap.ts` so the web app, the worker, the
 * seed and the tests all register the same handlers.
 */
import { payloadString, registerJobHandler } from "@/server/jobs/runner";
import { JOB_REPORT_GENERATE, generateReport } from "./service";

registerJobHandler(JOB_REPORT_GENERATE, async (job, deps) => {
  await generateReport(deps, payloadString(job, "reportId"));
  return { kind: "done" };
});
