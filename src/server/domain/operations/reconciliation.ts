/**
 * Reconciliation of platform expectations against the core's extract for one business date
 * (OPS-01, I-43).
 *
 * A run compares, by stable execution reference, what the platform believes was booked with
 * what the simulated core reports, and records MISSING / UNEXPECTED / DUPLICATE / AMOUNT /
 * STATUS breaks. A break is never "fixed" here: nothing in this module writes to a ledger, a
 * balance or an instruction. People record evidenced dispositions in an append-only history;
 * there is no "mark all reconciled" and nothing is deleted.
 */
import { z } from "zod";
import { reasonSchema, safeCode } from "@/contracts/common";
import { DomainError, notFound } from "@/contracts/errors";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { writeAudit } from "@/server/audit/audit";
import { requireBank, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { businessDateOf, dbDateToLocalDate, localDateToDbDate, type LocalDate } from "@/server/calendar";
import { inTx, type DbOrTx, type Prisma } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { enqueueJob } from "@/server/jobs/queue";
import type { ReconciliationBreak, ReconciliationRun } from "@/generated/prisma/client";

export const JOB_RECON_RUN = "recon.run";

export const startRunSchema = z.strictObject({ businessDate: z.iso.date() });
export const DISPOSITIONS = ["INVESTIGATING", "EXPLAINED", "ESCALATED", "CORRECTED_AT_SOURCE"] as const;
export const resolutionSchema = z.strictObject({
  disposition: z.enum(DISPOSITIONS),
  reason: reasonSchema,
  evidenceReference: safeCode(64).optional(),
});

/** What the platform expects the core to hold for one reference on one business date. */
export type ExpectedPosting = { executionReference: string; corporateId: string | null; principalMinor: bigint; feeMinor: bigint; source: string };

type ExpectedSource = (db: DbOrTx, scope: { bankId: string; businessDate: LocalDate; timeZone: string }) => Promise<ExpectedPosting[]>;
const sources: ExpectedSource[] = [];

/** A feature that books through the core adds its expected postings here (e.g. deposits). */
export function registerReconciliationSource(source: ExpectedSource): void {
  sources.push(source);
}

// Payments, bulk rows and payroll rows all book through execution attempts.
registerReconciliationSource(async (db, scope) => {
  const day = localDateToDbDate(scope.businessDate);
  const booked = await db.executionAttempt.findMany({
    where: { bankId: scope.bankId, state: "BOOKED", bookedBusinessDate: day },
    select: { executionReference: true, corporateId: true, instruction: { select: { amountMinor: true, feeMinor: true } } },
  });
  const lines: ExpectedPosting[] = booked.map((attempt) => ({
    executionReference: attempt.executionReference,
    corporateId: attempt.corporateId,
    principalMinor: attempt.instruction.amountMinor,
    feeMinor: attempt.instruction.feeMinor,
    source: "EXECUTION",
  }));
  // A return books a compensating journal under "<reference>R" on the day it was returned.
  const start = new Date(day.getTime() - 86_400_000);
  const end = new Date(day.getTime() + 2 * 86_400_000);
  const returned = await db.businessInstruction.findMany({
    where: { bankId: scope.bankId, state: "RETURNED", returnedAt: { gte: start, lt: end } },
    select: { corporateId: true, amountMinor: true, returnedAt: true, attempts: { where: { state: "BOOKED" }, select: { executionReference: true } } },
  });
  for (const instruction of returned) {
    if (!instruction.returnedAt || businessDateOf(instruction.returnedAt, scope.timeZone) !== scope.businessDate) continue;
    const reference = instruction.attempts[0]?.executionReference;
    if (!reference) continue;
    lines.push({ executionReference: `${reference}R`, corporateId: instruction.corporateId, principalMinor: instruction.amountMinor, feeMinor: 0n, source: "RETURN" });
  }
  return lines;
});

/** Core journals the platform never originates and therefore never expects. */
const NOT_PLATFORM_ORIGINATED = new Set(["OPENING_BALANCE"]);

export async function startReconciliationRun(deps: Deps, ctx: AuthContext, rawInput: unknown, runId: string): Promise<void> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.recon.manage");
  const person = requirePerson(bankCtx);
  const input = startRunSchema.parse(rawInput);
  if (input.businessDate > businessDateOf(deps.clock.now(), deps.timeZone)) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "businessDate", rule: "notFuture", message: "A future business date cannot be reconciled." }] });
  }
  await inTx(deps.db, async (tx) => {
    await tx.reconciliationRun.create({
      data: { id: runId, bankId: bankCtx.bankId, businessDate: localDateToDbDate(input.businessDate), state: "RUNNING", startedByPersonId: person.personId, startedAt: deps.clock.now() },
    });
    await enqueueJob(tx, {
      type: JOB_RECON_RUN,
      payload: { runId },
      dedupKey: `recon-run:${runId}`,
      bankId: bankCtx.bankId,
      aggregateType: "reconciliationRun",
      aggregateId: runId,
      correlationId: bankCtx.correlationId,
    });
    await writeAudit(tx, bankCtx, { action: "recon.run.started", targetType: "reconciliationRun", targetId: runId, changes: { businessDate: input.businessDate } });
  });
}

const money = (value: bigint) => value.toString();

/** Worker step: build the comparison and store breaks and counts in one transaction. */
export async function executeReconciliationRun(deps: Deps, runId: string): Promise<void> {
  const run = await deps.db.reconciliationRun.findUnique({ where: { id: runId } });
  if (!run || run.state !== "RUNNING") return;
  const bank = await deps.db.bank.findUniqueOrThrow({ where: { id: run.bankId }, select: { code: true } });
  const businessDate = dbDateToLocalDate(run.businessDate);

  let core;
  try {
    core = await deps.core.getReconciliationExtract({ bankCode: bank.code, correlationId: `recon_${runId}` }, businessDate);
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
    // No answer means no comparison: the run fails visibly and records no breaks.
    await deps.db.reconciliationRun.updateMany({ where: { id: runId, state: "RUNNING" }, data: { state: "FAILED", failureCode: "CORE_UNAVAILABLE", finishedAt: deps.clock.now() } });
    return;
  }
  const coreLines = core.filter((line) => !NOT_PLATFORM_ORIGINATED.has(line.kind));

  const expected: ExpectedPosting[] = [];
  for (const source of sources) expected.push(...(await source(deps.db, { bankId: run.bankId, businessDate, timeZone: deps.timeZone })));
  const expectedByRef = new Map(expected.map((line) => [line.executionReference, line]));
  const coreByRef = new Map<string, typeof coreLines>();
  for (const line of coreLines) coreByRef.set(line.executionReference, [...(coreByRef.get(line.executionReference) ?? []), line]);

  type NewBreak = Prisma.ReconciliationBreakCreateManyInput;
  const breaks: NewBreak[] = [];
  let matched = 0;
  const base = { runId, bankId: run.bankId };
  for (const line of expected) {
    const found = coreByRef.get(line.executionReference) ?? [];
    const expectedJson = { principalMinor: money(line.principalMinor), feeMinor: money(line.feeMinor), source: line.source };
    if (found.length === 0) {
      breaks.push({ ...base, corporateId: line.corporateId, kind: "MISSING_IN_CORE", executionReference: line.executionReference, expected: expectedJson });
    } else if (found.length > 1) {
      breaks.push({ ...base, corporateId: line.corporateId, kind: "DUPLICATE_IN_CORE", executionReference: line.executionReference, expected: expectedJson, actual: { count: found.length } });
    } else {
      const actual = found[0] as (typeof coreLines)[number];
      if (actual.principalMinor !== line.principalMinor || actual.feeMinor !== line.feeMinor) {
        breaks.push({
          ...base,
          corporateId: line.corporateId,
          kind: "AMOUNT_MISMATCH",
          executionReference: line.executionReference,
          expected: expectedJson,
          actual: { principalMinor: money(actual.principalMinor), feeMinor: money(actual.feeMinor), kind: actual.kind },
        });
      } else {
        matched += 1;
      }
    }
  }
  const unexpected = [...coreByRef.keys()].filter((reference) => !expectedByRef.has(reference));
  if (unexpected.length > 0) {
    // The core has a posting the platform does not count as booked: either the platform's own
    // instruction is in another state (status break) or it is unknown to the platform.
    const attempts = await deps.db.executionAttempt.findMany({
      where: { bankId: run.bankId, executionReference: { in: unexpected.map((reference) => reference.replace(/R$/, "")) } },
      select: { executionReference: true, state: true, corporateId: true },
    });
    const attemptByRef = new Map(attempts.map((attempt) => [attempt.executionReference, attempt]));
    for (const reference of unexpected) {
      const lines = coreByRef.get(reference) as typeof coreLines;
      const first = lines[0] as (typeof coreLines)[number];
      const attempt = attemptByRef.get(reference) ?? attemptByRef.get(reference.replace(/R$/, ""));
      const actual = { principalMinor: money(first.principalMinor), feeMinor: money(first.feeMinor), kind: first.kind, count: lines.length };
      breaks.push(
        attempt
          ? { ...base, corporateId: attempt.corporateId, kind: "STATUS_MISMATCH", executionReference: reference, expected: { platformState: attempt.state }, actual }
          : { ...base, corporateId: null, kind: "UNEXPECTED_IN_CORE", executionReference: reference, actual },
      );
    }
  }

  await inTx(
    deps.db,
    async (tx) => {
      const claimed = await tx.reconciliationRun.updateMany({
        where: { id: runId, state: "RUNNING" },
        data: { state: "COMPLETED", expectedCount: expected.length, coreCount: coreLines.length, matchedCount: matched, breakCount: breaks.length, finishedAt: deps.clock.now() },
      });
      // A second worker finishing the same run records nothing.
      if (claimed.count !== 1) return;
      if (breaks.length > 0) await tx.reconciliationBreak.createMany({ data: breaks });
      await tx.auditEvent.create({
        data: {
          bankId: run.bankId,
          actorKind: "SERVICE",
          actorService: "worker",
          action: "recon.run.completed",
          targetType: "reconciliationRun",
          targetId: runId,
          correlationId: `recon_${runId}`,
          changes: { businessDate, expected: expected.length, core: coreLines.length, matched, breaks: breaks.length },
          result: "SUCCESS",
        },
      });
    },
    { skipIdempotency: true },
  );
}

export type ReconRunView = {
  id: string;
  businessDate: LocalDate;
  state: string;
  expectedCount: number;
  coreCount: number;
  matchedCount: number;
  breakCount: number;
  openBreaks: number;
  failureCode: string | null;
  startedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type ReconBreakView = {
  id: string;
  kind: ReconciliationBreak["kind"];
  executionReference: string;
  corporate: { id: string; name: string; nameAr: string } | null;
  expected: Prisma.JsonValue | null;
  actual: Prisma.JsonValue | null;
  state: string;
  resolutions: Array<{ id: string; disposition: string; reason: string; evidenceReference: string | null; actor: string; at: string }>;
};

async function projectRuns(deps: Deps, runs: ReconciliationRun[]): Promise<ReconRunView[]> {
  const people = await deps.db.person.findMany({
    where: { id: { in: runs.map((run) => run.startedByPersonId).filter((id): id is string => id !== null) } },
    select: { id: true, name: true },
  });
  const names = new Map(people.map((person) => [person.id, person.name]));
  const open = await deps.db.reconciliationBreak.groupBy({ by: ["runId"], where: { runId: { in: runs.map((run) => run.id) }, state: { not: "RESOLVED" } }, _count: { _all: true } });
  const openByRun = new Map(open.map((row) => [row.runId, row._count._all]));
  return runs.map((run) => ({
    id: run.id,
    businessDate: dbDateToLocalDate(run.businessDate),
    state: run.state,
    expectedCount: run.expectedCount,
    coreCount: run.coreCount,
    matchedCount: run.matchedCount,
    breakCount: run.breakCount,
    openBreaks: openByRun.get(run.id) ?? 0,
    failureCode: run.failureCode,
    startedBy: run.startedByPersonId ? (names.get(run.startedByPersonId) ?? null) : null,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));
}

export async function listReconciliationRuns(deps: Deps, ctx: AuthContext, limit = 25): Promise<ReconRunView[]> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.recon.manage");
  const runs = await deps.db.reconciliationRun.findMany({ where: { bankId: bankCtx.bankId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: Math.min(Math.max(limit, 1), 100) });
  return projectRuns(deps, runs);
}

export async function getReconciliationRun(deps: Deps, ctx: AuthContext, runId: string): Promise<{ run: ReconRunView; breaks: ReconBreakView[] }> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.recon.manage");
  const run = await deps.db.reconciliationRun.findFirst({ where: { id: runId, bankId: bankCtx.bankId } });
  if (!run) throw notFound();
  const breaks = await deps.db.reconciliationBreak.findMany({
    where: { runId, bankId: bankCtx.bankId },
    include: { resolutions: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ kind: "asc" }, { executionReference: "asc" }],
    take: 500,
  });
  const corporates = await deps.db.corporate.findMany({
    where: { id: { in: breaks.map((entry) => entry.corporateId).filter((id): id is string => id !== null) } },
    select: { id: true, legalName: true, legalNameAr: true },
  });
  const corporateById = new Map(corporates.map((corporate) => [corporate.id, corporate]));
  const people = await deps.db.person.findMany({ where: { id: { in: breaks.flatMap((entry) => entry.resolutions.map((resolution) => resolution.actorPersonId)) } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  const [view] = await projectRuns(deps, [run]);
  return {
    run: view as ReconRunView,
    breaks: breaks.map((entry) => {
      const corporate = entry.corporateId ? corporateById.get(entry.corporateId) : undefined;
      return {
        id: entry.id,
        kind: entry.kind,
        executionReference: entry.executionReference,
        corporate: corporate ? { id: corporate.id, name: corporate.legalName, nameAr: corporate.legalNameAr } : null,
        expected: entry.expected,
        actual: entry.actual,
        state: entry.state,
        resolutions: entry.resolutions.map((resolution) => ({
          id: resolution.id,
          disposition: resolution.disposition,
          reason: resolution.reason,
          evidenceReference: resolution.evidenceReference,
          actor: names.get(resolution.actorPersonId) ?? "",
          at: resolution.createdAt.toISOString(),
        })),
      };
    }),
  };
}

/** Record an evidenced disposition. It is appended; earlier entries are never changed. */
export async function resolveBreak(deps: Deps, ctx: AuthContext, breakId: string, rawInput: unknown): Promise<string> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.recon.manage");
  const person = requirePerson(bankCtx);
  const input = resolutionSchema.parse(rawInput);
  return inTx(deps.db, async (tx) => {
    const entry = await tx.reconciliationBreak.findFirst({ where: { id: breakId, bankId: bankCtx.bankId } });
    if (!entry) throw notFound();
    await tx.reconciliationResolution.create({
      data: { breakId, disposition: input.disposition, reason: input.reason, evidenceReference: input.evidenceReference ?? null, actorPersonId: person.personId, createdAt: deps.clock.now() },
    });
    const state = input.disposition === "EXPLAINED" || input.disposition === "CORRECTED_AT_SOURCE" ? "RESOLVED" : "IN_REVIEW";
    await tx.reconciliationBreak.update({ where: { id: breakId }, data: { state } });
    await writeAudit(tx, bankCtx, {
      action: "recon.break.disposition",
      targetType: "reconciliationBreak",
      targetId: breakId,
      corporateId: entry.corporateId,
      reason: input.reason,
      changes: { disposition: input.disposition, state, executionReference: entry.executionReference, evidenceReference: input.evidenceReference ?? null },
    });
    return entry.runId;
  });
}
