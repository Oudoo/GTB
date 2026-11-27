/**
 * Deposit list and detail shared by the corporate workspace (/deposits) and the branch
 * workspace (/bank/deposits). Both call the same read model, which decides what each audience
 * may see: a corporate reader never receives staff names or the bank's review flag.
 */
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Badge, Callout, Card, CardHeader, Code, DataList, DetailList, EmptyState, Money, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { Timeline } from "@/features/common/timeline";
import type { Locale } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import type { DepositDetail, DepositView } from "@/server/domain/collections/deposits";

export async function DepositList({ deposits, locale, timeZone, hrefBase, audience, empty }: { deposits: DepositView[]; locale: Locale; timeZone: string; hrefBase: string; audience: "BANK" | "CORPORATE"; empty: ReactNode }) {
  const t = await getTranslations({ locale });
  const columns: Column<DepositView>[] = [
    {
      key: "reference",
      header: t("collections.deposits.reference"),
      primary: true,
      cell: (deposit) => (
        <Link href={`${hrefBase}/${deposit.id}`} className="text-accent hover:underline" data-testid="deposit-link">
          <Code>{deposit.intakeReference}</Code>
        </Link>
      ),
    },
    ...(audience === "BANK" ? [{ key: "corporate", header: t("teller.corporate"), cell: (deposit: DepositView) => <bdi>{locale === "ar" ? deposit.corporate.nameAr : deposit.corporate.name}</bdi> }] : []),
    { key: "customer", header: t("collections.deposits.customer"), cell: (deposit) => <span><Code>{deposit.customer.code}</Code> <bdi>{deposit.customer.displayName}</bdi></span> },
    { key: "method", header: t("collections.deposits.method"), cell: (deposit) => t(`collections.deposits.methods.${deposit.method}`) },
    { key: "amount", header: t("collections.deposits.amount"), numeric: true, cell: (deposit) => <Money value={deposit.amount} /> },
    { key: "state", header: t("collections.deposits.state"), cell: (deposit) => <StatusBadge family="deposit" state={deposit.state} /> },
    { key: "date", header: t("collections.deposits.date"), cell: (deposit) => <time dateTime={deposit.createdAt}>{formatDateTime(deposit.createdAt, locale, timeZone)}</time> },
  ];
  return <DataList rows={deposits} columns={columns} rowKey={(deposit) => deposit.id} caption={t("collections.deposits.caption")} empty={empty} />;
}

export async function DepositDetailView({ deposit, locale, timeZone, children }: { deposit: DepositDetail; locale: Locale; timeZone: string; children?: ReactNode }) {
  const t = await getTranslations({ locale });
  const name = (value: { name: string; nameAr: string }) => (locale === "ar" ? value.nameAr : value.name);
  const failureKey = deposit.failureCode ? (`types.failure.${deposit.failureCode}` as Parameters<typeof t>[0]) : null;
  return (
    <div className="flex flex-col gap-4">
      <Callout tone={deposit.state === "POSTED" ? "success" : deposit.state === "STATUS_UNKNOWN" || deposit.state === "RETURNED" || deposit.state === "REJECTED" ? "warning" : "info"} role="status" testId="deposit-help">
        {t(`collections.deposits.help.${deposit.state}`)}
      </Callout>
      {deposit.cashReviewFlag ? (
        <Callout tone="warning" title={t("teller.cashReview")} testId="cash-review">
          {t("teller.cashReviewHelp")}
        </Callout>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("common.labels.details")} />
          <div className="p-4 sm:p-5">
            <DetailList
              items={[
                { label: t("teller.corporate"), value: <bdi>{name(deposit.corporate)}</bdi> },
                { label: t("collections.deposits.customer"), value: <span><Code>{deposit.customer.code}</Code> <bdi>{deposit.customer.displayName}</bdi></span>, testId: "deposit-customer" },
                { label: t("collections.deposits.amount"), value: <Money value={deposit.amount} className="font-semibold" />, testId: "deposit-amount" },
                { label: t("collections.deposits.method"), value: t(`collections.deposits.methods.${deposit.method}`) },
                { label: t("collections.deposits.account"), value: <span>{name(deposit.creditAccount)} · <Code>{deposit.creditAccount.maskedNumber}</Code></span> },
                { label: t("collections.deposits.branch"), value: <span><Code>{deposit.branch.code}</Code> {name(deposit.branch)}</span> },
                { label: t("collections.deposits.depositorReference"), value: <Code>{deposit.depositorReference}</Code> },
                ...(deposit.chequeReference ? [{ label: t("collections.deposits.chequeReference"), value: <Code>{deposit.chequeReference}</Code> }] : []),
                { label: t("collections.deposits.date"), value: <time dateTime={deposit.createdAt}>{formatDateTime(deposit.createdAt, locale, timeZone)}</time> },
                ...(deposit.businessDate ? [{ label: t("collections.deposits.businessDate"), value: <Code>{deposit.businessDate}</Code> }] : []),
                ...(deposit.executionReference ? [{ label: t("collections.deposits.postingReference"), value: <Code>{deposit.executionReference}</Code>, wide: true, testId: "deposit-posting-reference" }] : []),
                ...(deposit.state === "POSTED"
                  ? [
                      { label: t("collections.deposits.allocated"), value: <Money value={deposit.allocated} /> },
                      { label: t("collections.deposits.remaining"), value: <Money value={deposit.remaining} />, testId: "deposit-remaining" },
                    ]
                  : []),
                ...(deposit.returnReason ? [{ label: t("collections.deposits.returnReason"), value: <bdi>{deposit.returnReason}</bdi>, wide: true }] : []),
                ...(failureKey ? [{ label: t("collections.deposits.failure"), value: t.has(failureKey) ? t(failureKey) : t("types.failure.OTHER"), wide: true }] : []),
              ]}
            />
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          {deposit.receipt ? (
            <Card>
              <CardHeader title={t("collections.deposits.receipt")} action={<Badge tone={deposit.receipt.kind === "POSTED" ? "success" : "warning"}>{t(`collections.deposits.receiptKind.${deposit.receipt.kind}`)}</Badge>} />
              <div className="flex flex-col gap-2 p-4 sm:p-5" data-testid="deposit-receipt" data-kind={deposit.receipt.kind}>
                <p>
                  <Code>{deposit.receipt.reference}</Code>
                </p>
                <p className="flex flex-wrap gap-x-5 gap-y-2">
                  <a className="text-accent underline" href={`/api/v1/deposits/${deposit.id}/receipt?locale=en`} download data-testid="receipt-en">
                    {t("collections.deposits.downloadEn")}
                  </a>
                  <a className="text-accent underline" href={`/api/v1/deposits/${deposit.id}/receipt?locale=ar`} download data-testid="receipt-ar">
                    {t("collections.deposits.downloadAr")}
                  </a>
                </p>
              </div>
            </Card>
          ) : null}
          {children}
          <Card>
            <CardHeader title={t("common.labels.timeline")} />
            <div className="p-4 sm:p-5">
              <Timeline entries={deposit.timeline} timeZone={timeZone} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function NoDeposits({ title }: { title: string }) {
  return <EmptyState title={title} />;
}
