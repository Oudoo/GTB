import type { z } from "zod";
import { auditQuerySchema, listAuditEvents } from "@/server/domain/audit/service";
import { query, type AnyOperation } from "../framework";

type AuditQueryInput = z.infer<typeof auditQuerySchema>;

export const auditOperations: AnyOperation[] = [
  query<Record<string, never>, AuditQueryInput>({
    id: "listAuditEvents",
    method: "GET",
    path: "/audit-events",
    summary: "Append-only audit trail of the caller's corporate",
    description:
      "Signed-in people only (no API credential scope). Search by payment reference, execution reference, record id or support reference. Bank-internal drafts are not shown and bank staff are not named. Stored changes are redacted and never contain payroll row detail.",
    tag: "Audit",
    scope: "corporate",
    permission: "audit.read",
    query: auditQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listAuditEvents(deps, ctx, q);
      return { data: result.items, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  query<Record<string, never>, AuditQueryInput>({
    id: "listBankAuditEvents",
    method: "GET",
    path: "/bank/audit-events",
    summary: "Append-only audit trail of the caller's bank",
    description: "Bank compliance and administrators only. Limited to the caller's own bank; `corporateId` narrows to one of its corporates.",
    tag: "Audit",
    scope: "bank",
    permission: "bank.audit.read",
    query: auditQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listAuditEvents(deps, ctx, q);
      return { data: result.items, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
];
