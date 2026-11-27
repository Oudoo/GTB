/**
 * Durable PostgreSQL job queue (document 03 "Worker behavior", DEC-004).
 *
 * - `enqueueJob` runs inside the caller's transaction, so a job exists if and only if the
 *   business change that needs it committed.
 * - Claims use `FOR UPDATE SKIP LOCKED` plus a lease. A crashed worker's lease expires and the
 *   job is claimed again; every handler is therefore written to be resumable and idempotent.
 * - Availability follows the injected business clock (so the sandbox clock can make scheduled
 *   work due); leases follow real database time.
 * - Exhausted jobs become DEAD (dead-letter) and stay visible to operations. Nothing is deleted.
 */
import { Prisma, type Db, type DbOrTx } from "@/server/db/client";

export type JobSpec = {
  type: string;
  payload: Prisma.InputJsonValue;
  /** Enqueueing the same dedup key twice is a no-op while the first job is pending or running. */
  dedupKey?: string;
  availableAt?: Date;
  maxAttempts?: number;
  bankId?: string | null;
  corporateId?: string | null;
  aggregateType?: string;
  aggregateId?: string;
  correlationId?: string | null;
};

export type ClaimedJob = {
  id: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  bankId: string | null;
  corporateId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  correlationId: string | null;
};

/** Sentinel for "run as soon as a worker is free", whatever the business clock says. */
export const IMMEDIATELY = new Date(0);

export async function enqueueJob(db: DbOrTx, spec: JobSpec): Promise<void> {
  await db.job.createMany({
    data: [
      {
        type: spec.type,
        payload: spec.payload,
        dedupKey: spec.dedupKey ?? null,
        // "Due immediately" must not depend on the wall clock: availability is compared with the
        // injected business clock, which tests and the sandbox simulator can move.
        availableAt: spec.availableAt ?? IMMEDIATELY,
        maxAttempts: spec.maxAttempts ?? 8,
        bankId: spec.bankId ?? null,
        corporateId: spec.corporateId ?? null,
        aggregateType: spec.aggregateType ?? null,
        aggregateId: spec.aggregateId ?? null,
        correlationId: spec.correlationId ?? null,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Claim up to `limit` due jobs for this worker. A RUNNING job whose lease expired is treated
 * as due (its previous worker died). Attempts are counted at claim time.
 */
export async function claimJobs(
  db: Db,
  options: { workerId: string; limit: number; leaseMs: number; now: Date; types?: readonly string[] },
): Promise<ClaimedJob[]> {
  const typeFilter = options.types?.length
    ? Prisma.sql`AND "type" IN (${Prisma.join([...options.types])})`
    : Prisma.empty;
  return db.$queryRaw<ClaimedJob[]>`
    UPDATE "Job" AS j
       SET "state" = 'RUNNING',
           "lockedBy" = ${options.workerId},
           "lockedUntil" = now() + (${options.leaseMs}::int * interval '1 millisecond'),
           "attempts" = j."attempts" + 1,
           "updatedAt" = now()
     WHERE j."id" IN (
             SELECT "id" FROM "Job"
              WHERE (("state" = 'PENDING' AND "availableAt" <= ${options.now})
                  OR ("state" = 'RUNNING' AND "lockedUntil" < now()))
                    ${typeFilter}
              ORDER BY "availableAt", "id"
              LIMIT ${options.limit}
                FOR UPDATE SKIP LOCKED
           )
    RETURNING j."id", j."type", j."payload", j."attempts", j."maxAttempts", j."bankId", j."corporateId",
              j."aggregateType", j."aggregateId", j."correlationId"`;
}

/** Extend the lease of a long-running job (heartbeat). Returns false if the claim was lost. */
export async function extendLease(db: Db, jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "Job" SET "lockedUntil" = now() + (${leaseMs}::int * interval '1 millisecond'), "updatedAt" = now()
     WHERE "id" = ${jobId}::uuid AND "state" = 'RUNNING' AND "lockedBy" = ${workerId}`;
  return count === 1;
}

export async function completeJob(db: DbOrTx, jobId: string, workerId: string): Promise<void> {
  await db.job.updateMany({
    where: { id: jobId, state: "RUNNING", lockedBy: workerId },
    // The dedup key guards only LIVE jobs: clearing it lets the same logical job be enqueued again.
    data: { state: "SUCCEEDED", lockedBy: null, lockedUntil: null, finishedAt: new Date(), lastErrorCode: null, dedupKey: null },
  });
}

/** Put the job back for a later attempt, or dead-letter it when attempts are exhausted. */
export async function failJob(
  db: Db,
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts">,
  workerId: string,
  outcome: { errorCode: string; retryAt?: Date; dead?: boolean },
): Promise<"retry" | "dead"> {
  const dead = outcome.dead === true || job.attempts >= job.maxAttempts || !outcome.retryAt;
  await db.job.updateMany({
    where: { id: job.id, state: "RUNNING", lockedBy: workerId },
    data: dead
      ? { state: "DEAD", lockedBy: null, lockedUntil: null, finishedAt: new Date(), lastErrorCode: outcome.errorCode, dedupKey: null }
      : {
          state: "PENDING",
          lockedBy: null,
          lockedUntil: null,
          availableAt: outcome.retryAt as Date,
          lastErrorCode: outcome.errorCode,
        },
  });
  return dead ? "dead" : "retry";
}

/**
 * Give a claimed-but-unfinished job back on graceful shutdown without burning an attempt.
 * The in-flight work is never erased; the next worker resumes it.
 */
export async function releaseJob(db: Db, jobId: string, workerId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "Job" SET "state" = 'PENDING', "lockedBy" = NULL, "lockedUntil" = NULL,
           "attempts" = GREATEST("attempts" - 1, 0), "updatedAt" = now()
     WHERE "id" = ${jobId}::uuid AND "state" = 'RUNNING' AND "lockedBy" = ${workerId}`;
}

/** Deterministic exponential backoff (seconds): 2, 4, 8 … capped at 5 minutes. */
export function backoffDelayMs(attempt: number, baseMs = 2_000, capMs = 300_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export type QueueDiagnostics = {
  pending: number;
  running: number;
  dead: number;
  oldestPendingAgeSeconds: number | null;
};

export async function queueDiagnostics(db: Db, now: Date): Promise<QueueDiagnostics> {
  const rows = await db.$queryRaw<Array<{ state: string; count: bigint; oldest: Date | null }>>`
    SELECT "state"::text AS state, count(*)::bigint AS count,
           min(GREATEST("availableAt", "createdAt")) FILTER (WHERE "availableAt" <= ${now}) AS oldest
      FROM "Job" WHERE "state" IN ('PENDING', 'RUNNING', 'DEAD') GROUP BY "state"`;
  const by = new Map(rows.map((row) => [row.state, row]));
  const oldest = by.get("PENDING")?.oldest ?? null;
  return {
    pending: Number(by.get("PENDING")?.count ?? 0n),
    running: Number(by.get("RUNNING")?.count ?? 0n),
    dead: Number(by.get("DEAD")?.count ?? 0n),
    oldestPendingAgeSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null,
  };
}
