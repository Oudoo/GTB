/**
 * Audit trail read model (SEC-05, RPT-03). The trail itself is append-only (database trigger
 * and missing UPDATE/DELETE privilege); this module only reads it.
 *
 * Scope is decided by the verified context, never by a filter:
 *  - a corporate reader sees events of their own corporate only, with bank-internal governance
 *    drafts hidden and bank staff shown as "bank" rather than by name;
 *  - a bank reader sees events of their own bank only.
 * Stored `changes` were redacted on write and never contain payroll row detail.
 */
import { z } from "zod";
import { notFound } from "@/contracts/errors";
import { requireBank, requireCorporate, requirePermission, type AuthContext } from "@/server/auth/context";
import { addDays, startOfBusinessDay } from "@/server/calendar";
import type { DbOrTx, Prisma } from "@/server/db/client";
import type { Deps } from "@/server/deps";

export const auditQuerySchema = z.strictObject({
  /** Payment/batch reference, execution reference, record id or support reference. */
  q: z.string().trim().min(1).max(80).optional(),
  /** Action or action prefix, e.g. `payment.` or `approval.vote`. */
  action: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_.]{0,60}$/)
    .optional(),
  result: z.enum(["SUCCESS", "DENIED", "FAILED"]).optional(),
  targetType: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,40}$/)
    .optional(),
  targetId: z.string().trim().min(1).max(80).optional(),
  /** Bank business dates, inclusive. */
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  /** Bank readers only: narrow to one corporate of their bank. */
  corporateId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export type AuditEventView = {
  id: string;
  at: string;
  actor: { kind: "PERSON" | "CREDENTIAL" | "SERVICE" | "BANK"; name: string | null };
  action: string;
  target: { type: string; id: string | null; label: string | null };
  corporate: { id: string; name: string; nameAr: string } | null;
  reason: string | null;
  result: "SUCCESS" | "DENIED" | "FAILED";
  proposalRevision: number | null;
  correlationId: string | null;
  sensitiveRead: boolean;
  changes: Prisma.JsonValue | null;
};

/**
 * Bank-internal governance a corporate reader does not see: drafts, rejected proposals and the
 * bank's own voting on them. Only the decided outcomes that bind the corporate are shown.
 */
const BANK_INTERNAL_PREFIXES = ["agreement.", "rail.", "repair.", "recon.", "simulator.", "bank."];
const BANK_INTERNAL_TARGETS = ["agreementVersion", "agreementRestore", "railParameter", "repairProposal", "reconciliationRun", "reconciliationBreak"];
const CORPORATE_VISIBLE_BANK_ACTIONS = ["agreement.version.activated", "agreement.version.effective", "agreement.suspended", "agreement.restored"];

type Labeler = (db: DbOrTx, ids: string[]) => Promise<Map<string, string>>;
type Resolver = (db: DbOrTx, scope: { bankId: string; corporateId: string | null }, text: string) => Promise<Array<{ type: string; id: string }>>;

const labelers = new Map<string, Labeler>();
const resolvers: Resolver[] = [];

/** A feature tells the audit view how to name its records (e.g. a payment by its reference). */
export function registerAuditTargetLabeler(targetType: string, labeler: Labeler): void {
  labelers.set(targetType, labeler);
}

/** A feature tells the audit search how to find its records from a human reference. */
export function registerAuditReferenceResolver(resolver: Resolver): void {
  resolvers.push(resolver);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

registerAuditTargetLabeler("payment", async (db, ids) => {
  const rows = await db.payment.findMany({ where: { id: { in: ids } }, select: { id: true, reference: true } });
  return new Map(rows.map((row) => [row.id, row.reference]));
});
registerAuditTargetLabeler("agreementVersion", async (db, ids) => {
  const rows = await db.agreementVersion.findMany({ where: { id: { in: ids } }, select: { id: true, versionNo: true } });
  return new Map(rows.map((row) => [row.id, `v${row.versionNo}`]));
});
registerAuditTargetLabeler("beneficiary", async (db, ids) => {
  const rows = await db.beneficiary.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  return new Map(rows.map((row) => [row.id, row.displayName]));
});
registerAuditTargetLabeler("railParameter", async (db, ids) => {
  const rows = await db.railParameter.findMany({ where: { id: { in: ids } }, select: { id: true, rail: true, versionNo: true } });
  return new Map(rows.map((row) => [row.id, `${row.rail} v${row.versionNo}`]));
});

// A payment is found by its own reference or by the stable execution reference that also
// appears on the statement line — so statement, payment and audit lead to the same record.
registerAuditReferenceResolver(async (db, scope, text) => {
  const where = { bankId: scope.bankId, ...(scope.corporateId ? { corporateId: scope.corporateId } : {}) };
  const byReference = await db.payment.findMany({ where: { ...where, reference: { equals: text, mode: "insensitive" } }, select: { id: true }, take: 5 });
  const attempts = await db.executionAttempt.findMany({
    where: { executionReference: text.toUpperCase(), instruction: where },
    select: { instruction: { select: { paymentId: true } } },
    take: 5,
  });
  const ids = new Set(byReference.map((row) => row.id));
  for (const attempt of attempts) if (attempt.instruction.paymentId) ids.add(attempt.instruction.paymentId);
  return [...ids].map((id) => ({ type: "payment", id }));
});

function scopeOf(ctx: AuthContext, query: AuditQuery): { bankId: string; corporateId: string | null; corporateReader: boolean } {
  if (ctx.workspace === "CORPORATE") {
    const corporateCtx = requireCorporate(ctx);
    requirePermission(corporateCtx, "audit.read");
    // A corporate reader can never widen the scope with a filter.
    if (query.corporateId && query.corporateId !== corporateCtx.corporateId) throw notFound();
    return { bankId: corporateCtx.bankId, corporateId: corporateCtx.corporateId, corporateReader: true };
  }
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.audit.read");
  return { bankId: bankCtx.bankId, corporateId: query.corporateId ?? null, corporateReader: false };
}

export async function listAuditEvents(deps: Deps, ctx: AuthContext, query: AuditQuery): Promise<{ items: AuditEventView[]; nextCursor: string | null }> {
  const scope = scopeOf(ctx, query);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const and: Prisma.AuditEventWhereInput[] = [{ bankId: scope.bankId }];

  if (scope.corporateId) {
    if (!scope.corporateReader) {
      const corporate = await deps.db.corporate.findFirst({ where: { id: scope.corporateId, bankId: scope.bankId }, select: { id: true } });
      if (!corporate) throw notFound();
    }
    and.push({ corporateId: scope.corporateId });
  }
  if (scope.corporateReader) {
    and.push({
      OR: [
        {
          NOT: {
            OR: [...BANK_INTERNAL_PREFIXES.map((prefix) => ({ action: { startsWith: prefix } })), { targetType: { in: BANK_INTERNAL_TARGETS } }],
          },
        },
        { action: { in: CORPORATE_VISIBLE_BANK_ACTIONS } },
      ],
    });
  }
  if (query.action) and.push(query.action.endsWith(".") ? { action: { startsWith: query.action } } : { OR: [{ action: query.action }, { action: { startsWith: `${query.action}.` } }] });
  if (query.result) and.push({ result: query.result });
  if (query.targetType) and.push({ targetType: query.targetType });
  if (query.targetId) and.push({ targetId: query.targetId });
  if (query.fromDate) and.push({ at: { gte: startOfBusinessDay(query.fromDate, deps.timeZone) } });
  if (query.toDate) and.push({ at: { lt: startOfBusinessDay(addDays(query.toDate, 1), deps.timeZone) } });

  if (query.q) {
    const text = query.q;
    const matches: Prisma.AuditEventWhereInput[] = [{ correlationId: text }];
    if (UUID.test(text)) matches.push({ targetId: text.toLowerCase() });
    for (const resolver of resolvers) {
      for (const hit of await resolver(deps.db, { bankId: scope.bankId, corporateId: scope.corporateId }, text)) {
        matches.push({ targetType: hit.type, targetId: hit.id });
      }
    }
    and.push({ OR: matches });
  }

  const rows = await deps.db.auditEvent.findMany({
    where: { AND: and },
    // uuid v7 ids are time-ordered, so the id is a stable tiebreaker for equal instants.
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);

  const personIds = [...new Set(page.map((row) => row.actorPersonId).filter((id): id is string => id !== null))];
  const people = await deps.db.person.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  // For a corporate reader a name is shown only for members of that corporate.
  const members = scope.corporateReader
    ? new Set((await deps.db.membership.findMany({ where: { corporateId: scope.corporateId, personId: { in: personIds } }, select: { personId: true } })).map((row) => row.personId))
    : null;
  const credentialIds = [...new Set(page.map((row) => row.actorCredentialId).filter((id): id is string => id !== null))];
  const credentials = await deps.db.apiCredential.findMany({ where: { id: { in: credentialIds } }, select: { id: true, name: true } });
  const credentialNames = new Map(credentials.map((credential) => [credential.id, credential.name]));

  const labels = new Map<string, Map<string, string>>();
  for (const [type, labeler] of labelers) {
    const ids = [...new Set(page.filter((row) => row.targetType === type && row.targetId && UUID.test(row.targetId)).map((row) => row.targetId as string))];
    if (ids.length > 0) labels.set(type, await labeler(deps.db, ids));
  }
  const corporateIds = [...new Set(page.map((row) => row.corporateId).filter((id): id is string => id !== null))];
  const corporates = await deps.db.corporate.findMany({ where: { id: { in: corporateIds } }, select: { id: true, legalName: true, legalNameAr: true } });
  const corporateById = new Map(corporates.map((corporate) => [corporate.id, corporate]));

  const items: AuditEventView[] = page.map((row) => {
    let actor: AuditEventView["actor"];
    if (row.actorKind === "PERSON" && row.actorPersonId) {
      actor = members && !members.has(row.actorPersonId) ? { kind: "BANK", name: null } : { kind: "PERSON", name: names.get(row.actorPersonId) ?? null };
    } else if (row.actorKind === "CREDENTIAL") {
      actor = { kind: "CREDENTIAL", name: row.actorCredentialId ? (credentialNames.get(row.actorCredentialId) ?? null) : null };
    } else {
      actor = { kind: "SERVICE", name: row.actorService };
    }
    const corporate = row.corporateId ? corporateById.get(row.corporateId) : undefined;
    return {
      id: row.id,
      at: row.at.toISOString(),
      actor,
      action: row.action,
      target: { type: row.targetType, id: row.targetId, label: row.targetId ? (labels.get(row.targetType)?.get(row.targetId) ?? null) : null },
      corporate: corporate ? { id: corporate.id, name: corporate.legalName, nameAr: corporate.legalNameAr } : null,
      reason: row.reason,
      result: row.result,
      proposalRevision: row.proposalRevision,
      correlationId: row.correlationId,
      sensitiveRead: row.sensitiveRead,
      changes: row.changes,
    };
  });
  return { items, nextCursor: rows.length > limit ? (page[page.length - 1] as { id: string }).id : null };
}
