import { getLocale, getTranslations } from "next-intl/server";
import { Callout, Code, DetailList, LinkButton, Money } from "@/components/ui/primitives";
import { formatDateTime, type MoneyLike } from "@/lib/format";
import type { ApprovalView } from "@/server/domain/approvals/service";

type Summary = {
  kind?: string;
  reference?: string;
  title?: string;
  linkPath?: string;
  count?: number;
  amount?: MoneyLike;
  fee?: MoneyLike;
  previousFee?: MoneyLike;
  totalDebit?: MoneyLike;
  sourceAccount?: { name: string; nameAr: string; maskedNumber: string };
  rail?: string;
  executeAt?: string | null;
  payPeriod?: string | null;
  isCorrection?: boolean;
  changeFlagCount?: number;
};

/**
 * What a checker decides on for a bulk or payroll batch: the frozen aggregate. For payroll the
 * summary holds AGGREGATES ONLY — there is no employee, account or per-person amount in the
 * record this component is given, so none can be rendered (SEC-04).
 */
export async function BatchApprovalSummary({ approval, timeZone }: { approval: ApprovalView; timeZone: string }) {
  const t = await getTranslations("batches");
  const locale = await getLocale();
  const summary = (approval.summary ?? {}) as Summary;
  const payroll = summary.kind === "PAYROLL";
  const money = (value: MoneyLike | undefined, strong = false) => (value ? <Money value={value} className={strong ? "font-semibold" : undefined} /> : "—");
  return (
    <div className="flex flex-col gap-4" data-testid="batch-approval-summary" data-kind={summary.kind ?? ""}>
      <DetailList
        items={[
          { label: t("approval.reference"), value: <Code>{summary.reference ?? ""}</Code>, testId: "batch-reference" },
          ...(payroll ? [{ label: t("approval.payPeriod"), value: <Code>{summary.payPeriod ?? ""}</Code>, testId: "batch-pay-period" }] : [{ label: t("approval.file"), value: <bdi>{summary.title ?? ""}</bdi> }]),
          { label: t("approval.count"), value: summary.count ?? "—", testId: "batch-count" },
          { label: t("approval.amount"), value: money(summary.amount), testId: "batch-amount" },
          { label: t("approval.fee"), value: money(summary.fee), testId: "batch-fee" },
          ...(summary.previousFee ? [{ label: t("approval.previousFee"), value: money(summary.previousFee) }] : []),
          { label: t("approval.totalDebit"), value: money(summary.totalDebit, true), testId: "batch-total-debit" },
          {
            label: t("approval.sourceAccount"),
            value: summary.sourceAccount ? (
              <span>
                {locale === "ar" ? summary.sourceAccount.nameAr : summary.sourceAccount.name} · <Code>{summary.sourceAccount.maskedNumber}</Code>
              </span>
            ) : (
              "—"
            ),
          },
          { label: t("approval.rail"), value: summary.rail === "ACH" ? t("upload.railACH") : t("upload.railLYPAY") },
          { label: t("approval.when"), value: summary.executeAt ? <time dateTime={summary.executeAt}>{formatDateTime(summary.executeAt, locale, timeZone)}</time> : t("detail.immediately") },
          ...(payroll ? [{ label: t("approval.changeFlags"), value: summary.changeFlagCount ?? 0, testId: "batch-change-flags" }] : []),
          ...(summary.isCorrection ? [{ label: t("approval.correction"), value: t("approval.yes") }] : []),
        ]}
      />
      <Callout tone="info" testId="approval-scope-note">
        {payroll ? t("approval.aggregateNote") : t("approval.bulkNote")}
      </Callout>
      {summary.linkPath ? (
        <div>
          <LinkButton href={summary.linkPath} variant="secondary" data-testid="open-batch">
            {t("approval.open")}
          </LinkButton>
        </div>
      ) : null}
    </div>
  );
}
