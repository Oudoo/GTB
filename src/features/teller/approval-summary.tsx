import { getLocale, getTranslations } from "next-intl/server";
import { Callout, Code, DetailList, LinkButton, Money } from "@/components/ui/primitives";
import type { MoneyLike } from "@/lib/format";
import type { ApprovalView } from "@/server/domain/approvals/service";

type Summary = {
  reference?: string;
  linkPath?: string;
  method?: "CASH" | "CHEQUE";
  amount?: MoneyLike;
  corporateName?: string;
  corporateNameAr?: string;
  customerCode?: string;
  customerName?: string;
  creditAccount?: { name: string; nameAr: string; maskedNumber: string };
  branchCode?: string;
  depositorReference?: string;
  chequeReference?: string | null;
  cashReviewFlag?: boolean;
};

/** What a branch manager decides on: the exact intake that was captured. */
export async function DepositApprovalSummary({ approval }: { approval: ApprovalView; timeZone: string }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const summary = (approval.summary ?? {}) as Summary;
  return (
    <div className="flex flex-col gap-4" data-testid="deposit-approval-summary">
      <DetailList
        items={[
          { label: t("teller.approval.reference"), value: <Code>{summary.reference ?? ""}</Code> },
          { label: t("teller.approval.amount"), value: summary.amount ? <Money value={summary.amount} className="font-semibold" /> : "—", testId: "deposit-review-amount" },
          { label: t("teller.approval.method"), value: summary.method ? t(`collections.deposits.methods.${summary.method}`) : "—" },
          { label: t("teller.approval.corporate"), value: <bdi>{locale === "ar" ? summary.corporateNameAr : summary.corporateName}</bdi> },
          { label: t("teller.approval.customer"), value: <span><Code>{summary.customerCode ?? ""}</Code> <bdi>{summary.customerName}</bdi></span> },
          { label: t("teller.approval.account"), value: summary.creditAccount ? <span>{locale === "ar" ? summary.creditAccount.nameAr : summary.creditAccount.name} · <Code>{summary.creditAccount.maskedNumber}</Code></span> : "—" },
          { label: t("teller.approval.branch"), value: <Code>{summary.branchCode ?? ""}</Code> },
          { label: t("teller.approval.depositorReference"), value: <Code>{summary.depositorReference ?? ""}</Code> },
          ...(summary.chequeReference ? [{ label: t("teller.approval.chequeReference"), value: <Code>{summary.chequeReference}</Code> }] : []),
        ]}
      />
      {summary.cashReviewFlag ? <Callout tone="warning" title={t("teller.cashReview")}>{t("teller.cashReviewHelp")}</Callout> : null}
      <Callout tone="info">{t("teller.approval.note")}</Callout>
      {summary.linkPath ? (
        <div>
          <LinkButton href={summary.linkPath} variant="secondary">
            {t("teller.approval.open")}
          </LinkButton>
        </div>
      ) : null}
    </div>
  );
}
