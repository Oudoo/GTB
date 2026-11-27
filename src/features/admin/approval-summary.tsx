import { SummaryFields, type ApprovalSummary } from "@/features/approvals/summary-fields";
import type { ApprovalView } from "@/server/domain/approvals/service";

/** Access-change proposals (users, roles, account rights, limits, approval rules). */
export async function AdminApprovalSummary({ approval }: { approval: ApprovalView; timeZone: string }) {
  return <SummaryFields summary={(approval.summary ?? {}) as ApprovalSummary} />;
}
