/**
 * Append-only audit trail, security events and status timelines (SEC-05, APR-01).
 *
 * `writeAudit` takes the caller's transaction so a successful mutation and its audit event
 * commit together. Before/after differences are redacted before they are stored: passwords,
 * tokens, upload contents and employee/salary detail never enter an audit row.
 */
import type { AuthContext } from "@/server/auth/context";
import type { DbOrTx } from "@/server/db/client";
import type { Prisma } from "@/server/db/client";
import { redact } from "@/server/logging";

export type AuditInput = {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  /** Sanitized before insert. Pass ids, states and amounts — never row-level payroll data. */
  changes?: unknown;
  result?: "SUCCESS" | "DENIED" | "FAILED";
  proposalRevision?: number | null;
  /** Marks a sensitive read/export (e.g. payroll detail). Content is not logged. */
  sensitiveRead?: boolean;
  /** Tenant override for bank actions on a specific corporate. */
  corporateId?: string | null;
};

export async function writeAudit(db: DbOrTx, ctx: AuthContext, input: AuditInput): Promise<void> {
  const principal = ctx.principal;
  await db.auditEvent.create({
    data: {
      bankId: ctx.bankId,
      corporateId: input.corporateId !== undefined ? input.corporateId : ctx.corporateId,
      actorKind: principal.kind === "person" ? "PERSON" : principal.kind === "credential" ? "CREDENTIAL" : "SERVICE",
      actorPersonId: principal.kind === "person" ? principal.personId : null,
      actorCredentialId: principal.kind === "credential" ? principal.credentialId : null,
      actorService: principal.kind === "service" ? principal.service : null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
      proposalRevision: input.proposalRevision ?? null,
      changes: input.changes === undefined ? undefined : (redact(input.changes) as Prisma.InputJsonValue),
      result: input.result ?? "SUCCESS",
      sensitiveRead: input.sensitiveRead ?? false,
    },
  });
}

export type SecurityEventInput = {
  kind:
    | "LOGIN_FAILED"
    | "LOGIN_THROTTLED"
    | "LOGIN_SUCCEEDED"
    | "LOGOUT"
    | "CSRF_REJECTED"
    | "PERMISSION_DENIED"
    | "TOKEN_REJECTED"
    | "QUOTA_EXCEEDED"
    | "SESSION_REVOKED";
  identifierHash?: string | null;
  personId?: string | null;
  bankId?: string | null;
  corporateId?: string | null;
  correlationId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
};

/** Rejected authentication/authorization attempts are recorded apart from business audit. */
export async function writeSecurityEvent(db: DbOrTx, input: SecurityEventInput): Promise<void> {
  await db.securityEvent.create({
    data: {
      kind: input.kind,
      identifierHash: input.identifierHash ?? null,
      personId: input.personId ?? null,
      bankId: input.bankId ?? null,
      corporateId: input.corporateId ?? null,
      correlationId: input.correlationId ?? null,
      detail: input.detail ? (redact(input.detail) as Prisma.InputJsonValue) : undefined,
    },
  });
}

export type TimelineInput = {
  bankId: string;
  corporateId?: string | null;
  aggregateType: "payment" | "batch" | "deposit" | "instruction" | "agreement" | "report";
  aggregateId: string;
  code: string;
  fromState?: string | null;
  toState?: string | null;
  actorPersonId?: string | null;
  actorService?: string | null;
  /** Adapter/core/rail reference for this step, when there is one. */
  reference?: string | null;
  detail?: Record<string, string | number | boolean | null>;
  at?: Date;
};

export async function addTimeline(db: DbOrTx, input: TimelineInput): Promise<void> {
  await db.timelineEvent.create({
    data: {
      bankId: input.bankId,
      corporateId: input.corporateId ?? null,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      code: input.code,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      actorPersonId: input.actorPersonId ?? null,
      actorService: input.actorService ?? null,
      reference: input.reference ?? null,
      detail: input.detail ? (redact(input.detail) as Prisma.InputJsonValue) : undefined,
      ...(input.at ? { at: input.at } : {}),
    },
  });
}

/** Actor fields for a timeline entry from an authorization context. */
export function timelineActor(ctx: AuthContext): { actorPersonId: string | null; actorService: string | null } {
  if (ctx.principal.kind === "person") return { actorPersonId: ctx.principal.personId, actorService: null };
  if (ctx.principal.kind === "credential") return { actorPersonId: null, actorService: `api:${ctx.principal.credentialId}` };
  return { actorPersonId: null, actorService: ctx.principal.service };
}
