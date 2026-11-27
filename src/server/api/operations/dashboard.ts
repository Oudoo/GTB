import { getBankOverview, getDashboard } from "@/server/domain/dashboard/service";
import { query, type AnyOperation } from "../framework";

export const dashboardOperations: AnyOperation[] = [
  query({
    id: "getDashboard",
    method: "GET",
    path: "/dashboard",
    summary: "Corporate home: accounts, items needing a decision, scheduled and recent payments",
    description: "Every block is limited to the caller's permissions and account grants. Payroll row detail never appears here.",
    tag: "Dashboard",
    scope: "corporate",
    handler: async ({ deps, ctx }) => ({ data: await getDashboard(deps, ctx) }),
  }),
  query({
    id: "getBankOverview",
    method: "GET",
    path: "/bank/overview",
    summary: "Bank workspace home: agreement status counts, approvals waiting, worker and queue health",
    description: "Blocks appear only with the matching bank permission; a teller sees no corporate counts.",
    tag: "Dashboard",
    scope: "bank",
    handler: async ({ deps, ctx }) => ({ data: await getBankOverview(deps, ctx) }),
  }),
];
