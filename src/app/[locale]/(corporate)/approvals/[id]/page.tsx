import { ApprovalReview } from "@/features/approvals/approval-pages";
import { requireCorporatePage } from "@/server/page";

export default async function ApprovalDetailPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const page = await requireCorporatePage(locale);
  return <ApprovalReview page={page} basePath="/approvals" approvalId={id} />;
}
