import { SummaryFields, type ApprovalSummary } from "@/features/approvals/summary-fields";
import type { ApprovalView } from "@/server/domain/approvals/service";

/** Bank repair proposals (resubmit with the same reference / declare failed, not posted). */
export async function RepairApprovalSummary({ approval }: { approval: ApprovalView; timeZone: string }) {
  return <SummaryFields summary={(approval.summary ?? {}) as ApprovalSummary} />;
}
