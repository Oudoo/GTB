import { SummaryFields, type ApprovalSummary } from "@/features/approvals/summary-fields";
import type { ApprovalView } from "@/server/domain/approvals/service";

/** Branch deposits awaiting a manager decision. */
export async function DepositApprovalSummary({ approval }: { approval: ApprovalView; timeZone: string }) {
  return <SummaryFields summary={(approval.summary ?? {}) as ApprovalSummary} />;
}
