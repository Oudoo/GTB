import { ApprovalReview } from "@/features/approvals/approval-pages";
import { requireBankPage } from "@/server/page";

export default async function BankApprovalDetailPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const page = await requireBankPage(locale);
  return <ApprovalReview page={page} basePath="/bank/approvals" approvalId={id} />;
}
