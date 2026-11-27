import { getTranslations } from "next-intl/server";
import { Checkbox, Field, Input, describe } from "@/components/ui/form";
import { Badge, Button, Callout, Card, CardHeader, Code, DataList, EmptyState, LinkButton, PageHeader, type Column } from "@/components/ui/primitives";
import { CustomerAddForm } from "@/features/collections/client/collection-forms";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { listCustomers, type CustomerView } from "@/server/domain/collections/service";
import { can, load, requireCorporatePage } from "@/server/page";

type Search = { search?: string; archived?: string; cursor?: string };

export default async function CustomersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "customers.read")) return <Forbidden />;
  const query = await searchParams;
  const search = query.search?.trim().slice(0, 80) ?? "";
  const includeArchived = query.archived === "on";
  const result = await load(() => listCustomers(deps, ctx, { ...(search ? { search } : {}), includeArchived: includeArchived ? "true" : "false", ...(query.cursor ? { cursor: query.cursor } : {}), limit: 25 }));
  const mayManage = can(ctx, "customers.manage");
  const columns: Column<CustomerView>[] = [
    {
      key: "name",
      header: t("collections.customers.name"),
      primary: true,
      cell: (customer) => (
        <Link href={`/customers/${customer.id}`} className="text-accent hover:underline" data-testid="customer-link">
          <Code>{customer.code}</Code> <bdi>{customer.displayName}</bdi>
        </Link>
      ),
    },
    { key: "company", header: t("collections.customers.company"), cell: (customer) => <bdi>{customer.company}</bdi> },
    { key: "mobile", header: t("collections.customers.mobile"), cell: (customer) => <Code>{customer.mobile}</Code> },
    { key: "status", header: t("collections.customers.status"), cell: (customer) => <Badge tone={customer.archived ? "neutral" : "success"}>{customer.archived ? t("collections.customers.archived") : t("collections.customers.active")}</Badge> },
  ];
  const nextHref = (cursor: string) => {
    const next = new URLSearchParams();
    if (search) next.set("search", search);
    if (includeArchived) next.set("archived", "on");
    next.set("cursor", cursor);
    return `/customers?${next.toString()}`;
  };
  return (
    <>
      <PageHeader title={t("collections.customers.title")} description={t("collections.customers.description")} />
      <div className="flex flex-col gap-4">
        {!mayManage ? <Callout tone="info">{t("collections.customers.noManage")}</Callout> : null}
        <Card>
          <form method="get" className="grid grid-cols-1 gap-3 border-b border-border px-4 py-4 sm:grid-cols-3 sm:px-5">
            <Field id="search" label={t("collections.customers.search")}>
              <Input {...describe("search", {})} name="search" defaultValue={search} maxLength={80} />
            </Field>
            <div className="flex items-end">
              <Checkbox id="archived" name="archived" label={t("collections.customers.showArchived")} defaultChecked={includeArchived} />
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="secondary" className="w-full">
                {t("common.actions.filter")}
              </Button>
            </div>
          </form>
          {!result.ok ? (
            <div className="p-4">
              <LoadError code={result.code} />
            </div>
          ) : (
            <div data-testid="customer-list">
              <DataList
                rows={result.data.items}
                columns={columns}
                rowKey={(customer) => customer.id}
                caption={t("collections.customers.caption")}
                empty={<EmptyState title={t("collections.customers.empty")} description={mayManage ? t("collections.customers.emptyHint") : undefined} />}
              />
              {result.data.nextCursor ? (
                <div className="border-t border-border p-4 text-center">
                  <LinkButton href={nextHref(result.data.nextCursor)} variant="secondary">
                    {t("common.actions.loadMore")}
                  </LinkButton>
                </div>
              ) : null}
            </div>
          )}
        </Card>
        {mayManage ? (
          <Card>
            <CardHeader title={t("collections.customers.addTitle")} />
            <div className="flex flex-col gap-4 p-4 sm:p-5">
              <CustomerAddForm />
              <Callout tone="info">{t("collections.customers.importDeferred")}</Callout>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
