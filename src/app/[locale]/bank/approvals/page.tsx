import { getTranslations } from "next-intl/server";
import { ApprovalsQueue } from "@/features/approvals/approval-pages";
import { requireBankPage } from "@/server/page";

export default async function BankApprovalsPage({ params }: { params: Promise<{ locale: string }> }) {
  const page = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale: page.locale, namespace: "bank.approvals" });
  return <ApprovalsQueue page={page} basePath="/bank/approvals" title={t("title")} description={t("description")} />;
}
