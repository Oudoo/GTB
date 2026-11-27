/** Reconciliation runs, breaks and resolutions (S8). */
import { z } from "zod";
import { idParamSchema } from "@/contracts/common";
import { getReconciliationRun, listReconciliationRuns, resolutionSchema, resolveBreak, startReconciliationRun, startRunSchema } from "@/server/domain/operations/reconciliation";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const reconciliationOperations: AnyOperation[] = [
  query({
    id: "listReconciliationRuns",
    method: "GET",
    path: "/bank/reconciliation-runs",
    summary: "Reconciliation runs of the caller's bank",
    tag: "Reconciliation",
    scope: "bank",
    permission: "bank.recon.manage",
    handler: async ({ deps, ctx }) => ({ data: await listReconciliationRuns(deps, ctx) }),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof startRunSchema>>({
    id: "startReconciliationRun",
    method: "POST",
    path: "/bank/reconciliation-runs",
    summary: "Compare platform expectations with the simulated core for one business date",
    description: "Runs as a worker job. It records breaks; it never changes a ledger, a balance or an instruction.",
    tag: "Reconciliation",
    scope: "bank",
    permission: "bank.recon.manage",
    body: startRunSchema,
    successStatus: 202,
    execute: async ({ deps, ctx, body, newId }) => startReconciliationRun(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getReconciliationRun(deps, ctx, ref.id),
  }),
  query<IdParams>({
    id: "getReconciliationRun",
    method: "GET",
    path: "/bank/reconciliation-runs/{id}",
    summary: "One run with its breaks and their resolution history",
    tag: "Reconciliation",
    scope: "bank",
    permission: "bank.recon.manage",
    params: idParamSchema,
    handler: async ({ deps, ctx, params }) => ({ data: await getReconciliationRun(deps, ctx, params.id) }),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof resolutionSchema>>({
    id: "resolveReconciliationBreak",
    method: "POST",
    path: "/bank/reconciliation-breaks/{id}/resolution",
    summary: "Record an evidenced disposition for one break (append-only)",
    description: "There is no bulk resolution and nothing is deleted. A disposition never edits the ledger.",
    tag: "Reconciliation",
    scope: "bank",
    permission: "bank.recon.manage",
    params: idParamSchema,
    body: resolutionSchema,
    successStatus: 201,
    target: ({ params }) => ({ type: "reconciliationBreak", id: params.id }),
    execute: async ({ deps, ctx, params, body }) => {
      await resolveBreak(deps, ctx, params.id, body);
    },
    render: async ({ deps, ctx }, ref) => {
      const entry = await deps.db.reconciliationBreak.findFirst({ where: { id: ref.id, bankId: ctx.bankId }, select: { runId: true } });
      return entry ? getReconciliationRun(deps, ctx, entry.runId) : null;
    },
  }),
];
