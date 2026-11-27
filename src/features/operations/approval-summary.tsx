import { getLocale, getTranslations } from "next-intl/server";
import { Code, DetailList, Money } from "@/components/ui/primitives";
import type { ApprovalSummary } from "@/features/approvals/summary-fields";
import type { MoneyLike } from "@/lib/format";
import type { ApprovalView } from "@/server/domain/approvals/service";

const text = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

/** Bank repair proposals (resubmit with the same reference / declare failed, not posted). */
export async function RepairApprovalSummary({ approval }: { approval: ApprovalView; timeZone: string }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const summary = (approval.summary ?? {}) as ApprovalSummary;
  const amount = summary["amount"] && typeof summary["amount"] === "object" ? (summary["amount"] as MoneyLike) : null;
  const action = text(summary["action"]);
  const actionKey = `ops.detail.actions.${action}` as Parameters<typeof t>[0];
  return (
    <DetailList
      items={[
        { label: t("ops.summary.action"), value: <span className="font-semibold" data-testid="repair-action">{t.has(actionKey) ? t(actionKey) : action}</span>, wide: true },
        { label: t("ops.summary.execution"), value: <Code>{text(summary["reference"])}</Code>, wide: true },
        { label: t("common.labels.corporate"), value: <bdi>{locale === "ar" ? text(summary["corporateNameAr"]) : text(summary["corporateName"])}</bdi> },
        { label: t("common.labels.amount"), value: amount ? <Money value={amount} /> : t("ops.queue.masked") },
        { label: t("ops.summary.lastInquiry"), value: <Code>{text(summary["lastInquiryResult"])}</Code> },
        { label: t("ops.summary.inquiries"), value: text(summary["inquiryCount"]) },
        { label: t("common.labels.reason"), value: <bdi>{text(summary["reason"])}</bdi>, wide: true },
        ...(summary["evidenceReference"] ? [{ label: t("ops.summary.evidence"), value: <Code>{text(summary["evidenceReference"])}</Code> }] : []),
      ]}
    />
  );
}
