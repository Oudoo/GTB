/**
 * Branch teller and manager operations (S7). Bank session only: there is no corporate
 * credential scope that can capture or approve a deposit. The manager decision uses the
 * unified approval operations (`/approvals/{proposalId}/approve|reject`, class BRANCH_DEPOSIT).
 */
import { z } from "zod";
import { chequeEventSchema, customerLookupQuerySchema, depositIntakeSchema } from "@/contracts/collections";
import { idParamSchema } from "@/contracts/common";
import { applyChequeEvent, captureDeposit, getDeposit, listBranchDeposits, listPendingCheques, listTellerCorporates, lookupCustomer } from "@/server/domain/collections/deposits";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;
const branchQuery = z.strictObject({ state: z.string().max(40).optional(), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export const tellerOperations: AnyOperation[] = [
  query({
    id: "listTellerCorporates",
    method: "GET",
    path: "/bank/teller/corporates",
    summary: "Corporates of the teller's bank that accept branch deposits (names only)",
    tag: "Branch",
    scope: "bank",
    permission: "bank.teller.capture",
    handler: async ({ deps, ctx }) => ({ data: await listTellerCorporates(deps, ctx) }),
  }),
  query<Record<string, never>, z.infer<typeof customerLookupQuerySchema>>({
    id: "lookupDepositCustomer",
    method: "GET",
    path: "/bank/teller/customer-lookup",
    summary: "Resolve corporate + customer code for confirmation at the counter",
    description: "The corporate must be named explicitly: a code alone never identifies who is credited.",
    tag: "Branch",
    scope: "bank",
    permission: "bank.teller.capture",
    query: customerLookupQuerySchema,
    handler: async ({ deps, ctx, query: q }) => ({ data: await lookupCustomer(deps, ctx, q) }),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof depositIntakeSchema>>({
    id: "captureDeposit",
    method: "POST",
    path: "/bank/deposits",
    summary: "Capture a synthetic cash or cheque deposit",
    description: "Returns PENDING_MANAGER, PENDING_POSTING or ACCEPTED_PENDING_CLEARING — never an assumed credit. Bank and branch come from the teller's session.",
    tag: "Branch",
    scope: "bank",
    permission: "bank.teller.capture",
    body: depositIntakeSchema,
    successStatus: 202,
    execute: async ({ deps, ctx, body, newId }) => captureDeposit(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getDeposit(deps, ctx, ref.id),
  }),
  query<Record<string, never>, z.infer<typeof branchQuery>>({
    id: "listBranchDeposits",
    method: "GET",
    path: "/bank/deposits",
    summary: "Deposits of the caller's own branch",
    tag: "Branch",
    scope: "bank",
    permission: "bank.deposits.read",
    query: branchQuery,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listBranchDeposits(deps, ctx, q);
      return { data: result.items, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  query({
    id: "listBranchApprovals",
    method: "GET",
    path: "/bank/branch-approvals",
    summary: "Deposits of the caller's branch that wait for a manager",
    description: "The same person can never approve a deposit they captured.",
    tag: "Branch",
    scope: "bank",
    permission: "bank.deposits.read",
    handler: async ({ deps, ctx }) => ({ data: (await listBranchDeposits(deps, ctx, { state: "PENDING_MANAGER", limit: 100 })).items }),
  }),
  query({
    id: "listPendingCheques",
    method: "GET",
    path: "/bank/simulator/cheques",
    summary: "Cheques waiting for a simulated clearing event",
    tag: "Sandbox simulator",
    scope: "bank",
    permission: "bank.simulator.control",
    handler: async ({ deps, ctx }) => ({ data: await listPendingCheques(deps, ctx) }),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof chequeEventSchema>>({
    id: "sendChequeEvent",
    method: "POST",
    path: "/bank/simulator/cheques/{id}/events",
    summary: "Send a simulated clearing or return event for a cheque deposit",
    description: "An adapter fixture event, not a corporate mutation. A duplicate or late event has no effect.",
    tag: "Sandbox simulator",
    scope: "bank",
    permission: "bank.simulator.control",
    params: idParamSchema,
    body: chequeEventSchema,
    target: ({ params }) => ({ type: "deposit", id: params.id }),
    execute: async ({ deps, ctx, params, body }) => {
      await applyChequeEvent(deps, ctx, params.id, body);
    },
    render: async ({ deps, ctx }) => listPendingCheques(deps, ctx),
  }),
];
