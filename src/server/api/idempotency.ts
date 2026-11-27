/**
 * Request idempotency (PAY-04, document 04).
 *
 * Scope = bank/corporate + authenticated principal + method + canonical route and path
 * parameters. Same scope/key/body → the original result is re-projected for the caller's
 * CURRENT permissions (no response body is ever stored, so payroll plaintext cannot be cached
 * here). A different body under the same key → 409. A concurrent duplicate either replays the
 * committed original or gets REQUEST_IN_PROGRESS; it can never execute twice.
 *
 * Completion is written by the first business transaction of the request (see `inTx`), so the
 * record and the effect commit together.
 */
import { DomainError } from "@/contracts/errors";
import { isUniqueViolation, type Db } from "@/server/db/client";
import type { Prisma } from "@/server/db/client";

export const IDEMPOTENCY_LOCK_MS = 60_000;
export const IDEMPOTENCY_RETENTION_DAYS = 30;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function validateIdempotencyKey(value: string | null): string {
  if (!value) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED");
  if (!KEY_PATTERN.test(value)) {
    throw new DomainError("VALIDATION_FAILED", {
      violations: [{ field: "Idempotency-Key", rule: "format", message: "8–128 characters: letters, digits, . _ : -" }],
    });
  }
  return value;
}

export type IdempotencyBegin =
  | { kind: "execute"; recordId: string; resultId: string }
  | { kind: "replay"; status: number; resultType: string; resultId: string; meta: Prisma.JsonValue | null };

export async function beginIdempotent(
  db: Db,
  input: {
    scopeKey: string;
    key: string;
    requestHash: string;
    resultType: string;
    /** Pre-allocated or target resource id the response will point at. */
    resultId: string;
    now: Date;
  },
): Promise<IdempotencyBegin> {
  const lockedUntil = new Date(input.now.getTime() + IDEMPOTENCY_LOCK_MS);
  const expiresAt = new Date(input.now.getTime() + IDEMPOTENCY_RETENTION_DAYS * 86_400_000);
  try {
    const created = await db.idempotencyRecord.create({
      data: {
        scopeKey: input.scopeKey,
        key: input.key,
        requestHash: input.requestHash,
        resultType: input.resultType,
        resultId: input.resultId,
        lockedUntil,
        expiresAt,
      },
    });
    return { kind: "execute", recordId: created.id, resultId: input.resultId };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const existing = await db.idempotencyRecord.findUnique({
    where: { scopeKey_key: { scopeKey: input.scopeKey, key: input.key } },
  });
  if (!existing) {
    // The winner failed and removed its record between our insert and read: start over once.
    return beginIdempotent(db, input);
  }
  if (existing.requestHash !== input.requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT");
  if (existing.state === "COMPLETED") {
    return {
      kind: "replay",
      status: existing.responseStatus ?? 200,
      resultType: existing.resultType ?? input.resultType,
      resultId: existing.resultId ?? input.resultId,
      meta: existing.resultMeta,
    };
  }
  if (existing.lockedUntil.getTime() > input.now.getTime()) {
    throw new DomainError("REQUEST_IN_PROGRESS", {
      retryAfterSeconds: Math.max(1, Math.ceil((existing.lockedUntil.getTime() - input.now.getTime()) / 1000)),
    });
  }
  // Stale claim: the original request died before its business transaction committed (a
  // committed transaction would have completed this record). Take it over, keeping the SAME
  // pre-allocated result id.
  const taken = await db.idempotencyRecord.updateMany({
    where: { id: existing.id, state: "IN_PROGRESS", lockedUntil: existing.lockedUntil },
    data: { lockedUntil },
  });
  if (taken.count !== 1) throw new DomainError("REQUEST_IN_PROGRESS", { retryAfterSeconds: 2 });
  return { kind: "execute", recordId: existing.id, resultId: existing.resultId ?? input.resultId };
}

/** The request finished without any business transaction: complete the record now. */
export async function completeIdempotent(db: Db, recordId: string, status: number): Promise<void> {
  await db.idempotencyRecord.updateMany({
    where: { id: recordId, state: "IN_PROGRESS" },
    data: { state: "COMPLETED", responseStatus: status, completedAt: new Date() },
  });
}

/** The request failed before committing anything: free the key for a corrected retry. */
export async function abandonIdempotent(db: Db, recordId: string): Promise<void> {
  await db.idempotencyRecord.deleteMany({ where: { id: recordId, state: "IN_PROGRESS" } });
}
