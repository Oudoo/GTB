/** Bank payment operations (S8): attention queue, inquiry, repair proposals. */
import type { z } from "zod";
import { idParamSchema } from "@/contracts/common";
import { executionQuerySchema, getExecution, inquireExecution, listExecutions, proposeRepair, repairProposalSchema } from "@/server/domain/operations/service";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const opsOperations: AnyOperation[] = [
  query<Record<string, never>, z.infer<typeof executionQuerySchema>>({
    id: "listExecutions",
    method: "GET",
    path: "/bank/operations/executions",
    summary: "Executions of the caller's bank that are unknown, failed or overdue",
    description: "Payroll rows are masked: references and states only, never the payee or the amount.",
    tag: "Bank operations",
    scope: "bank",
    permission: "bank.operations.read",
    query: executionQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listExecutions(deps, ctx, q);
      return { data: { items: result.items, counts: result.counts }, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  query<IdParams>({
    id: "getExecution",
    method: "GET",
    path: "/bank/operations/executions/{id}",
    summary: "One execution with its inquiry history and repair proposals",
    tag: "Bank operations",
    scope: "bank",
    permission: "bank.operations.read",
    params: idParamSchema,
    handler: async ({ deps, ctx, params }) => ({ data: await getExecution(deps, ctx, params.id) }),
  }),
  command<IdParams>({
    id: "inquireExecution",
    method: "POST",
    path: "/bank/operations/executions/{id}/inquire",
    summary: "Ask the core about the original reference of an unknown execution",
    description:
      "Posted → the original booking is acknowledged, never a second debit. Not found → the execution stays unknown. Every inquiry is recorded with its outcome.",
    tag: "Bank operations",
    scope: "bank",
    permission: "bank.operations.act",
    params: idParamSchema,
    target: ({ params }) => ({ type: "executionAttempt", id: params.id }),
    execute: async ({ deps, ctx, params }) => {
      await inquireExecution(deps, ctx, params.id);
    },
    render: async ({ deps, ctx }, ref) => getExecution(deps, ctx, ref.id),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof repairProposalSchema>>({
    id: "proposeExecutionRepair",
    method: "POST",
    path: "/bank/operations/executions/{id}/repair-proposals",
    summary: "Propose a safe repair for an unknown execution the core does not know",
    description:
      "Allowed only after an inquiry answered that no posting exists. Either resubmit with the SAME reference or declare failed-not-posted; a different person with the repair approval permission decides, and the repair inquires again before acting.",
    tag: "Bank operations",
    scope: "bank",
    permission: "bank.operations.act",
    params: idParamSchema,
    body: repairProposalSchema,
    successStatus: 201,
    execute: async ({ deps, ctx, params, body, newId }) => proposeRepair(deps, ctx, params.id, body, newId),
    render: async ({ deps, ctx, params }) => getExecution(deps, ctx, params.id),
  }),
];
