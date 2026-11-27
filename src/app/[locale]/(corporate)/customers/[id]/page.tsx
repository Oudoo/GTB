import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, DataList, DetailList, EmptyState, LinkButton, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { AllocateForm, CustomerArchiveButton, InvoiceAddForm } from "@/features/collections/client/collection-forms";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { formatDate, moneyText } from "@/lib/format";
import { listDeposits } from "@/server/domain/collections/deposits";
import { getCustomer, type InvoiceView } from "@/server/domain/collections/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function CustomerPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireCorporatePage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "customers.read")) return <Forbidden />;
  const result = await load(() => getCustomer(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const customer = result.data;
  const mayInvoice = can(ctx, "invoices.manage");
  // Posted deposits of this customer that still have something to allocate.
  const deposits = mayInvoice && can(ctx, "deposits.read") ? await load(() => listDeposits(deps, ctx, { customerId: id, state: "POSTED", limit: 100 })) : null;
  const allocatable = deposits?.ok ? deposits.data.items.filter((deposit) => BigInt(deposit.remaining.minor) > 0n) : [];
  const openInvoices = customer.invoices.filter((invoice) => invoice.status === "OPEN");
  const columns: Column<InvoiceView>[] = [
    { key: "reference", header: t("collections.invoices.reference"), primary: true, cell: (invoice) => <Code>{invoice.reference}</Code> },
    { key: "amount", header: t("collections.invoices.amount"), numeric: true, cell: (invoice) => <Money value={invoice.amount} /> },
    { key: "allocated", header: t("collections.invoices.allocated"), numeric: true, cell: (invoice) => <Money value={invoice.allocated} /> },
    { key: "due", header: t("collections.invoices.due"), numeric: true, cell: (invoice) => <span data-testid={`invoice-due-${invoice.reference}`}><Money value={invoice.due} /></span> },
    { key: "dueDate", header: t("collections.invoices.dueDate"), cell: (invoice) => formatDate(invoice.dueDate, locale, deps.timeZone) },
    { key: "status", header: t("collections.invoices.status"), cell: (invoice) => <span data-testid={`invoice-status-${invoice.reference}`} data-state={invoice.status}><Badge tone={invoice.status === "PAID" ? "success" : invoice.status === "OPEN" ? "warning" : "neutral"}>{t(`collections.invoices.state.${invoice.status}`)}</Badge></span> },
  ];
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              <Code>{customer.code}</Code> <bdi>{customer.displayName}</bdi>
            </span>
            <Badge tone={customer.archived ? "neutral" : "success"}>{customer.archived ? t("collections.customers.archived") : t("collections.customers.active")}</Badge>
          </span>
        }
        back={
          <Link href="/customers" className="text-accent hover:underline">
            ← {t("collections.customers.title")}
          </Link>
        }
        actions={
          can(ctx, "deposits.read") ? (
            <LinkButton href={`/deposits?customerId=${customer.id}`} variant="secondary">
              {t("collections.customer.viewDeposits")}
            </LinkButton>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t("collections.customer.totals")} />
            <div className="p-4 sm:p-5" data-testid="customer-totals">
              <DetailList
                items={[
                  { label: t("collections.customer.deposits"), value: customer.totals.deposits },
                  { label: t("collections.customer.posted"), value: <Money value={customer.totals.posted} /> },
                  { label: t("collections.customer.invoiced"), value: <Money value={customer.totals.invoiced} /> },
                  { label: t("collections.customer.paid"), value: <Money value={customer.totals.paid} /> },
                  { label: t("collections.customer.due"), value: <Money value={customer.totals.due} className="font-semibold" />, testId: "customer-due" },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("collections.customer.details")} />
            <div className="flex flex-col gap-4 p-4 sm:p-5">
              <DetailList
                items={[
                  { label: t("collections.customers.company"), value: <bdi>{customer.company}</bdi> },
                  { label: t("collections.customers.mobile"), value: <Code>{customer.mobile}</Code> },
                  ...(customer.industry ? [{ label: t("collections.customers.industry"), value: <bdi>{customer.industry}</bdi> }] : []),
                  ...(customer.billingAddress ? [{ label: t("collections.customers.billingAddress"), value: <bdi>{customer.billingAddress}</bdi>, wide: true }] : []),
                ]}
              />
              {can(ctx, "customers.manage") ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-muted">{t("collections.customer.archiveHelp")}</p>
                  <CustomerArchiveButton customerId={customer.id} version={customer.version} archived={customer.archived} />
                </div>
              ) : null}
            </div>
          </Card>
        </div>
        <Card>
          <CardHeader title={t("collections.invoices.title")} description={t("collections.invoices.help")} />
          <div data-testid="invoice-list">
            <DataList rows={customer.invoices} columns={columns} rowKey={(invoice) => invoice.id} caption={t("collections.invoices.caption")} empty={<EmptyState title={t("collections.invoices.empty")} />} />
          </div>
        </Card>
        {mayInvoice && !customer.archived ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title={t("collections.invoices.addTitle")} />
              <div className="p-4 sm:p-5">
                <InvoiceAddForm customerId={customer.id} />
              </div>
            </Card>
            <Card>
              <CardHeader title={t("collections.invoices.allocateTitle")} />
              <div className="p-4 sm:p-5">
                {openInvoices.length > 0 && allocatable.length > 0 ? (
                  <AllocateForm
                    invoices={openInvoices.map((invoice) => ({ id: invoice.id, label: t("collections.invoices.invoiceOption", { reference: invoice.reference, due: moneyText(invoice.due) }) }))}
                    deposits={allocatable.map((deposit) => ({ id: deposit.id, label: t("collections.invoices.depositOption", { reference: deposit.intakeReference, remaining: moneyText(deposit.remaining) }) }))}
                  />
                ) : (
                  <Callout tone="info">{t("collections.invoices.nothingToAllocate")}</Callout>
                )}
              </div>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
