/** Report requests and authorized downloads (S8, RPT-01). Session only: files are never reachable with an API credential. */
import { z } from "zod";
import { idParamSchema } from "@/contracts/common";
import { reportRequestSchema } from "@/contracts/reports";
import { downloadReport, getReport, listReports, requestReport } from "@/server/domain/reports/service";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const reportOperations: AnyOperation[] = [
  query({
    id: "listReports",
    method: "GET",
    path: "/reports",
    summary: "Reports requested by the caller",
    tag: "Reports",
    scope: "corporate",
    permission: "reports.request",
    handler: async ({ deps, ctx }) => ({ data: await listReports(deps, ctx) }),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof reportRequestSchema>>({
    id: "requestReport",
    method: "POST",
    path: "/reports",
    summary: "Request a statement (CSV or PDF) or a deposit summary (CSV)",
    description: "Accounts need the report right. At most 366 days. The file is prepared by a worker job with the requester's current rights.",
    tag: "Reports",
    scope: "corporate",
    permission: "reports.request",
    body: reportRequestSchema,
    successStatus: 202,
    execute: async ({ deps, ctx, body, newId }) => requestReport(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getReport(deps, ctx, ref.id),
  }),
  query<IdParams>({
    id: "getReport",
    method: "GET",
    path: "/reports/{id}",
    summary: "State of one requested report",
    tag: "Reports",
    scope: "corporate",
    permission: "reports.request",
    params: idParamSchema,
    handler: async ({ deps, ctx, params }) => ({ data: await getReport(deps, ctx, params.id) }),
  }),
  query<IdParams>({
    id: "downloadReport",
    method: "GET",
    path: "/reports/{id}/download",
    summary: "Download a completed report",
    description: "Authorized again at download time against the caller's current permissions and account rights. No public or signed URL exists.",
    tag: "Reports",
    scope: "corporate",
    permission: "reports.request",
    params: idParamSchema,
    handler: async ({ deps, ctx, params }) => ({ raw: await downloadReport(deps, ctx, params.id) }),
  }),
];
