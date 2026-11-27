import { getTranslations } from "next-intl/server";
import { ApprovalsQueue } from "@/features/approvals/approval-pages";
import { requireCorporatePage } from "@/server/page";

export default async function ApprovalsPage({ params }: { params: Promise<{ locale: string }> }) {
  const page = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale: page.locale, namespace: "corp.approvals" });
  return <ApprovalsQueue page={page} basePath="/approvals" title={t("title")} description={t("description")} />;
}
