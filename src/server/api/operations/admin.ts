/**
 * Corporate administration (ADM-01): members, access-change proposals, suspension and
 * invitations. Session only — an API credential can never read or change access.
 * The decision on a proposal uses the unified approval operations (class CORPORATE_ADMIN).
 */
import { z } from "zod";
import { invitationAcceptSchema, invitationLookupSchema, suspendSchema, userProposalSchema } from "@/contracts/admin";
import { idParamSchema } from "@/contracts/common";
import { acceptInvitation, getUser, getUserProposal, listLocalInbox, listUserProposals, listUsers, lookupInvitation, proposeUserChange, suspendUser } from "@/server/domain/admin/service";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const adminOperations: AnyOperation[] = [
  query({
    id: "listUsers",
    method: "GET",
    path: "/admin/users",
    summary: "Members of the corporate with roles, account rights and allowances",
    description: "Never returns a password, a hash or a session.",
    tag: "Administration",
    scope: "corporate",
    permission: "admin.users.read",
    handler: async ({ deps, ctx }) => ({ data: await listUsers(deps, ctx) }),
  }),
  query({
    id: "listUserProposals",
    method: "GET",
    path: "/admin/user-proposals",
    summary: "Access-change proposals and their state",
    tag: "Administration",
    scope: "corporate",
    permission: "admin.users.read",
    handler: async ({ deps, ctx }) => ({ data: await listUserProposals(deps, ctx) }),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof userProposalSchema>>({
    id: "proposeUserChange",
    method: "POST",
    path: "/admin/user-proposals",
    summary: "Propose an invitation, an access change or a reactivation",
    description:
      "Carries the full desired access (roles, account rights, user allowance). Checked against the signed agreement; applied only after a different eligible person approves. Nobody can propose a change to their own access.",
    tag: "Administration",
    scope: "corporate",
    permission: "admin.users.propose",
    body: userProposalSchema,
    successStatus: 202,
    execute: async ({ deps, ctx, body, newId }) => proposeUserChange(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getUserProposal(deps, ctx, ref.id),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof suspendSchema>>({
    id: "suspendUser",
    method: "POST",
    path: "/admin/users/{id}/suspend",
    summary: "Remove a member's access immediately",
    description: "Ends the person's sessions. The last active administrator and the caller themself cannot be suspended. Re-enabling needs an approved proposal.",
    tag: "Administration",
    scope: "corporate",
    permission: "admin.users.suspend",
    params: idParamSchema,
    body: suspendSchema,
    ifMatch: true,
    target: ({ params }) => ({ type: "membership", id: params.id }),
    execute: async ({ deps, ctx, params, body, expectedVersion }) => suspendUser(deps, ctx, params.id, body.reason, expectedVersion),
    render: async ({ deps, ctx }, ref) => getUser(deps, ctx, ref.id),
  }),
  query({
    id: "listLocalInbox",
    method: "GET",
    path: "/admin/local-inbox",
    summary: "Sandbox-only local inbox with this corporate's invitation links",
    description: "No e-mail or SMS is ever sent by the sandbox. Used and expired links are not shown.",
    tag: "Administration",
    scope: "corporate",
    permission: "admin.users.propose",
    handler: async ({ deps, ctx }) => ({ data: await listLocalInbox(deps, ctx) }),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof invitationLookupSchema>>({
    id: "lookupInvitation",
    method: "POST",
    path: "/invitations/lookup",
    summary: "Show who an invitation is for (token in the body, never in a URL)",
    description: "Unknown, used and expired tokens answer identically with 404.",
    tag: "Administration",
    scope: "public",
    body: invitationLookupSchema,
    idempotent: false,
    execute: async () => undefined,
    render: async ({ deps, body }) => lookupInvitation(deps, body.token),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof invitationAcceptSchema>>({
    id: "acceptInvitation",
    method: "POST",
    path: "/invitations/accept",
    summary: "Accept an invitation once and receive the approved access",
    description: "Creates the identity if the e-mail is new. An invitation never changes the password of an existing identity.",
    tag: "Administration",
    scope: "public",
    body: invitationAcceptSchema,
    idempotent: false,
    execute: async ({ deps, body, correlationId }) => {
      await acceptInvitation(deps, body, correlationId);
    },
    render: async () => ({ accepted: true }),
  }),
];
