import { z } from "zod";
import { isDomainError } from "@/contracts/errors";
import { pageQuerySchema } from "@/contracts/common";
import { rejectSchema, voteSchema } from "@/contracts/payments";
import type { AuthContext } from "@/server/auth/context";
import type { Deps } from "@/server/deps";
import { castVote, getApproval, listApprovals } from "@/server/domain/approvals/service";
import { requireReapproval } from "@/server/domain/payments/service";
import { command, query, type AnyOperation } from "../framework";

const proposalParams = z.strictObject({ proposalId: z.uuid() });
type ProposalParams = z.infer<typeof proposalParams>;

const listQuery = pageQuerySchema.extend({ state: z.enum(["PENDING", "DECIDED", "ALL"]).optional() });

async function vote(
  deps: Deps,
  ctx: AuthContext,
  proposalId: string,
  decision: "APPROVE" | "REJECT",
  body: { proposalVersion: number; proposalHash: string; reason?: string | undefined },
  expectedVersion: number,
): Promise<void> {
  try {
    await castVote(deps, ctx, proposalId, { decision, proposalVersion: body.proposalVersion, proposalHash: body.proposalHash, reason: body.reason, expectedVersion });
  } catch (error) {
    if (isDomainError(error) && error.code === "REAPPROVAL_REQUIRED") {
      // The fee or required checker count changed since submission. Refresh the proposal to
      // the current terms (votes void) so the checker reviews what would really be charged.
      const request = await deps.db.approvalRequest.findUnique({ where: { id: proposalId }, select: { targetType: true, targetId: true } });
      if (request?.targetType === "payment") await requireReapproval(deps, request.targetId, "FEE_CHANGED");
    }
    throw error;
  }
}

export const approvalOperations: AnyOperation[] = [
  query<Record<string, never>, z.infer<typeof listQuery>>({
    id: "listApprovals",
    method: "GET",
    path: "/approvals",
    summary: "Approval queue for the caller's classes and accounts",
    description: "Payroll proposals expose aggregate figures only. `canAct` is advisory; eligibility is re-checked on every decision.",
    tag: "Approvals",
    scope: "any",
    query: listQuery,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listApprovals(deps, ctx, {
        ...(q.state ? { state: q.state } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      });
      return { data: result.items, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  query<ProposalParams>({
    id: "getApproval",
    method: "GET",
    path: "/approvals/{proposalId}",
    summary: "One proposal with its immutable summary, votes and the caller's eligibility",
    tag: "Approvals",
    scope: "any",
    params: proposalParams,
    handler: async ({ deps, ctx, params }) => ({ data: await getApproval(deps, ctx, params.proposalId) }),
  }),
  command<ProposalParams, Record<string, never>, z.infer<typeof voteSchema>>({
    id: "approveProposal",
    method: "POST",
    path: "/approvals/{proposalId}/approve",
    summary: "Approve the exact revision that was reviewed",
    description:
      "Requires a human session of the right approval class (bearer credentials can never vote). The maker of a proposal cannot approve it, whatever roles they hold. `If-Match` carries the proposal version; the body binds the vote to the revision and payload hash.",
    tag: "Approvals",
    scope: "any",
    params: proposalParams,
    body: voteSchema,
    ifMatch: true,
    target: ({ params }) => ({ type: "approval", id: params.proposalId }),
    execute: async ({ deps, ctx, params, body, expectedVersion }) => vote(deps, ctx, params.proposalId, "APPROVE", body, expectedVersion),
    render: async ({ deps, ctx }, ref) => getApproval(deps, ctx, ref.id),
  }),
  command<ProposalParams, Record<string, never>, z.infer<typeof rejectSchema>>({
    id: "rejectProposal",
    method: "POST",
    path: "/approvals/{proposalId}/reject",
    summary: "Reject the revision with a reason (terminal for that revision)",
    tag: "Approvals",
    scope: "any",
    params: proposalParams,
    body: rejectSchema,
    ifMatch: true,
    target: ({ params }) => ({ type: "approval", id: params.proposalId }),
    execute: async ({ deps, ctx, params, body, expectedVersion }) => vote(deps, ctx, params.proposalId, "REJECT", body, expectedVersion),
    render: async ({ deps, ctx }, ref) => getApproval(deps, ctx, ref.id),
  }),
];
