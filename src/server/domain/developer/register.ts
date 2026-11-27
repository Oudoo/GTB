/**
 * Developer surface: outbox publisher and webhook delivery job handlers.
 * Imported for its side effects by `src/server/bootstrap.ts` so the web app, the worker, the
 * seed and the tests all register the same handlers.
 */
import { registerSweep } from "@/server/jobs/maintenance";
import { payloadString, registerJobHandler } from "@/server/jobs/runner";
import { JOB_OUTBOX_PUBLISH } from "@/server/outbox";
import { JOB_WEBHOOK_DELIVER, deliverWebhook, publishOutbox } from "./service";

registerJobHandler(JOB_OUTBOX_PUBLISH, async (_job, deps) => {
  // Keep going while a full page was published, so a burst is not left for the next event.
  while ((await publishOutbox(deps)) === 100) {
    /* next page */
  }
  return { kind: "done" };
});

registerJobHandler(JOB_WEBHOOK_DELIVER, async (job, deps) => {
  const outcome = await deliverWebhook(deps, payloadString(job, "deliveryId"));
  return outcome.kind === "again" ? { kind: "poll", at: outcome.at } : { kind: "done" };
});

// An event committed while the publisher job was already running is picked up here.
registerSweep({ name: "outbox.publish", run: (deps) => publishOutbox(deps) });
