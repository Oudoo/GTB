import { getLocale, getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/ui/status";
import { Code, DataList, LinkButton, Money, type Column } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/format";
import type { PaymentView } from "@/server/domain/payments/service";
import type { ReactNode } from "react";

/** Payment rows as a table on desktop and labelled cards on phones (MOB-04). */
export async function PaymentList({ payments, empty, timeZone }: { payments: PaymentView[]; empty: ReactNode; timeZone: string }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const columns: Column<PaymentView>[] = [
    {
      key: "reference",
      header: t("common.labels.reference"),
      primary: true,
      cell: (payment) => (
        <span className="flex flex-wrap items-center gap-2">
          <Code>{payment.reference}</Code>
          <StatusBadge family="payment" state={payment.state} />
        </span>
      ),
    },
    {
      key: "recipient",
      header: t("corp.payments.recipient"),
      cell: (payment) => (
        <span>
          {payment.destination.name}
          <span className="block text-xs text-muted">
            <Code>{payment.destination.maskedReference}</Code>
          </span>
        </span>
      ),
    },
    { key: "type", header: t("common.labels.type"), cell: (payment) => t(`types.transactionType.${payment.transactionType}` as Parameters<typeof t>[0]) },
    { key: "amount", header: t("common.labels.amount"), numeric: true, cell: (payment) => <Money value={payment.amount} className="font-semibold" /> },
    {
      key: "created",
      header: t("corp.payments.created"),
      cell: (payment) => <time dateTime={payment.createdAt}>{formatDateTime(payment.createdAt, locale, timeZone)}</time>,
    },
  ];
  return (
    <DataList
      rows={payments}
      columns={columns}
      rowKey={(payment) => payment.id}
      caption={t("corp.payments.title")}
      empty={empty}
      action={(payment) => (
        <LinkButton href={`/payments/${payment.id}`} variant="secondary" aria-label={`${t("common.actions.viewDetails")} ${payment.reference}`}>
          {t("common.actions.viewDetails")}
        </LinkButton>
      )}
    />
  );
}
