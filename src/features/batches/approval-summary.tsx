import { SummaryFields, type ApprovalSummary } from "@/features/approvals/summary-fields";
import type { ApprovalView } from "@/server/domain/approvals/service";

/** Bulk and payroll proposals. Payroll shows AGGREGATES ONLY: never an employee, account or per-person amount. */
export async function BatchApprovalSummary({ approval }: { approval: ApprovalView; timeZone: string }) {
  return <SummaryFields summary={(approval.summary ?? {}) as ApprovalSummary} />;
}
