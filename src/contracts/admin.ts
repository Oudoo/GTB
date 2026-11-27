/**
 * Corporate administration contracts (ADM-01). A proposal carries the FULL desired access of a
 * member: roles, account rights and the user allowance. Unknown fields are rejected, so a
 * request cannot name a permission, a tenant or a person-id of its own.
 */
import { z } from "zod";
import { reasonSchema, safeText } from "./common";
import { positiveMoneyJsonSchema } from "./money";

export const ASSIGNABLE_ROLES = ["CORPORATE_ADMIN", "MAKER", "CHECKER", "TREASURER", "FINANCE", "PAYROLL_OFFICER", "VIEWER", "API_INTEGRATOR"] as const;

const grantSchema = z.strictObject({ accountId: z.uuid(), read: z.boolean(), debit: z.boolean(), approve: z.boolean(), report: z.boolean() });
const limitsSchema = z.strictObject({ perItem: positiveMoneyJsonSchema, daily: positiveMoneyJsonSchema }).nullable();

const access = {
  roles: z.array(z.enum(ASSIGNABLE_ROLES)).min(1).max(ASSIGNABLE_ROLES.length),
  grants: z.array(grantSchema).max(20),
  /** User allowance for money movement; null = none. Bounded by the signed agreement. */
  limits: limitsSchema,
  reason: reasonSchema,
};

export const userProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("INVITE"), email: z.email().max(200), displayName: safeText(2, 120), ...access }),
  z.strictObject({ kind: z.literal("CHANGE_ACCESS"), membershipId: z.uuid(), ...access }),
  z.strictObject({ kind: z.literal("REACTIVATE"), membershipId: z.uuid(), reason: reasonSchema }),
]);
export type UserProposalInput = z.infer<typeof userProposalSchema>;

export const suspendSchema = z.strictObject({ reason: reasonSchema });

export const invitationLookupSchema = z.strictObject({ token: z.string().min(20).max(200) });
export const invitationAcceptSchema = z.strictObject({
  token: z.string().min(20).max(200),
  /** Ignored when the invited e-mail already has an identity: an invitation never changes a password. */
  password: z.string().min(12).max(128),
});
