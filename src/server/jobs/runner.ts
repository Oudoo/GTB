/**
 * Job runner shared by the worker process (`worker/index.ts`), the smoke script and the tests.
 * Handlers never receive authority from the queued JSON: they load the persisted, already
 * authorized record by id and rebuild their context from it (document 03 "Worker behavior").
 */
import type { Db } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { logError, logInfo, logWarn } from "@/server/logging";
import { runWithRequest } from "@/server/request-context";
import { backoffDelayMs, claimJobs, completeJob, failJob, releaseJob, type ClaimedJob } from "./queue";

export type JobResult =
  | { kind: "done" }
  /** Re-run later without it counting as a failure (polling). */
  | { kind: "poll"; at: Date }
  /** Transient problem: retry with backoff until attempts are exhausted. */
  | { kind: "retry"; at?: Date; code: string }
  /** Give up now and leave the job in the dead-letter state for operations. */
  | { kind: "dead"; code: string };

export type JobHandler = (job: ClaimedJob, deps: Deps) => Promise<JobResult>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()];
}

export function payloadString(job: ClaimedJob, key: string): string {
  const value = (job.payload as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Job payload is missing ${key}`);
  return value;
}

/** Run one claimed job to an outcome and persist that outcome. */
export async function runJob(deps: Deps, workerId: string, job: ClaimedJob): Promise<"done" | "poll" | "retry" | "dead"> {
  const handler = handlers.get(job.type);
  const correlationId = job.correlationId ?? `job_${job.id}`;
  if (!handler) {
    await failJob(deps.db, job, workerId, { errorCode: "NO_HANDLER", dead: true });
    logWarn("worker", "no handler for job type", { jobId: job.id, type: job.type });
    return "dead";
  }
  const started = Date.now();
  let result: JobResult;
  try {
    result = await runWithRequest({ correlationId }, () => handler(job, deps));
  } catch (error) {
    logError("worker", "job failed", error, { jobId: job.id, type: job.type, attempt: job.attempts, correlationId });
    result = { kind: "retry", code: "HANDLER_ERROR" };
  }
  const durationMs = Date.now() - started;

  if (result.kind === "done") {
    await completeJob(deps.db, job.id, workerId);
    logInfo("worker", "job done", { jobId: job.id, type: job.type, attempt: job.attempts, durationMs, correlationId });
    return "done";
  }
  if (result.kind === "poll") {
    // Polling is not a failure: give the attempt back and look again at the requested time.
    await deps.db.job.updateMany({
      where: { id: job.id, state: "RUNNING", lockedBy: workerId },
      data: { state: "PENDING", lockedBy: null, lockedUntil: null, availableAt: result.at, attempts: Math.max(0, job.attempts - 1) },
    });
    return "poll";
  }
  if (result.kind === "dead") {
    await failJob(deps.db, job, workerId, { errorCode: result.code, dead: true });
    logWarn("worker", "job dead-lettered", { jobId: job.id, type: job.type, code: result.code, correlationId });
    return "dead";
  }
  const retryAt = result.at ?? new Date(deps.clock.now().getTime() + backoffDelayMs(job.attempts));
  const outcome = await failJob(deps.db, job, workerId, { errorCode: result.code, retryAt });
  if (outcome === "dead") logWarn("worker", "job exhausted its attempts", { jobId: job.id, type: job.type, code: result.code, correlationId });
  return outcome;
}

export type DrainOptions = {
  workerId?: string;
  /** Upper bound on jobs processed in this call. */
  maxJobs?: number;
  types?: readonly string[];
  leaseMs?: number;
};

/**
 * Process every job that is due now (by the injected clock), sequentially, until none is due.
 * Used by tests and the smoke script instead of sleeping; the long-running worker loops over
 * the same `claimJobs`/`runJob` pair.
 */
export async function drainJobs(deps: Deps, options: DrainOptions = {}): Promise<number> {
  const workerId = options.workerId ?? `drain-${process.pid}`;
  const maxJobs = options.maxJobs ?? 500;
  let processed = 0;
  while (processed < maxJobs) {
    const jobs = await claimJobs(deps.db, {
      workerId,
      limit: Math.min(10, maxJobs - processed),
      leaseMs: options.leaseMs ?? 60_000,
      now: deps.clock.now(),
      ...(options.types ? { types: options.types } : {}),
    });
    if (jobs.length === 0) break;
    for (const job of jobs) {
      await runJob(deps, workerId, job);
      processed += 1;
    }
  }
  return processed;
}

export type WorkerOptions = {
  workerId: string;
  pollMs: number;
  leaseMs: number;
  concurrency: number;
  getDeps: () => Promise<Deps>;
  signal: AbortSignal;
  heartbeat?: (db: Db, processed: number) => Promise<void>;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * Long-running worker loop. On shutdown it stops claiming, lets in-flight jobs finish, and
 * gives back any claim it could not finish — it never erases or abandons in-flight work.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  let processed = 0;
  const inFlight = new Map<string, { job: ClaimedJob; done: Promise<void> }>();
  let lastHeartbeat = 0;

  while (!options.signal.aborted) {
    const deps = await options.getDeps();
    if (options.heartbeat && Date.now() - lastHeartbeat > 5_000) {
      await options.heartbeat(deps.db, processed).catch((error) => logError("worker", "heartbeat failed", error));
      lastHeartbeat = Date.now();
    }
    const capacity = options.concurrency - inFlight.size;
    let claimed: ClaimedJob[] = [];
    if (capacity > 0) {
      try {
        claimed = await claimJobs(deps.db, { workerId: options.workerId, limit: capacity, leaseMs: options.leaseMs, now: deps.clock.now() });
      } catch (error) {
        logError("worker", "claim failed", error);
      }
    }
    for (const job of claimed) {
      const done = runJob(deps, options.workerId, job)
        .then(() => {
          processed += 1;
        })
        .catch((error) => logError("worker", "job outcome could not be recorded", error, { jobId: job.id }))
        .finally(() => {
          inFlight.delete(job.id);
        });
      inFlight.set(job.id, { job, done });
    }
    if (claimed.length === 0) await sleep(options.pollMs, options.signal);
  }

  // Graceful shutdown: wait briefly for running jobs, then release what is still claimed.
  const deadline = Date.now() + 20_000;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await Promise.race([...inFlight.values()].map((entry) => entry.done));
  }
  if (inFlight.size > 0) {
    const deps = await options.getDeps();
    for (const { job } of inFlight.values()) await releaseJob(deps.db, job.id, options.workerId).catch(() => undefined);
  }
}
