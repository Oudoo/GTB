import { getTranslations } from "next-intl/server";
import { Field, Input, Select, describe } from "@/components/ui/form";
import { Button, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { DepositList } from "@/features/collections/deposit-views";
import { Forbidden, LoadError } from "@/features/common/states";
import { listDeposits } from "@/server/domain/collections/deposits";
import { can, load, requireCorporatePage } from "@/server/page";

const STATES = ["PENDING_MANAGER", "PENDING_POSTING", "ACCEPTED_PENDING_CLEARING", "POSTED", "RETURNED", "REJECTED", "STATUS_UNKNOWN"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Search = { state?: string; customerId?: string; fromDate?: string; toDate?: string; cursor?: string };

export default async function DepositsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "deposits.read")) return <Forbidden />;
  const query = await searchParams;
  const state = STATES.find((entry) => entry === query.state);
  const fromDate = query.fromDate && DATE.test(query.fromDate) ? query.fromDate : undefined;
  const toDate = query.toDate && DATE.test(query.toDate) ? query.toDate : undefined;
  const customerId = query.customerId && /^[0-9a-f-]{36}$/i.test(query.customerId) ? query.customerId : undefined;
  const result = await load(() => listDeposits(deps, ctx, { ...(state ? { state } : {}), ...(customerId ? { customerId } : {}), ...(fromDate ? { fromDate } : {}), ...(toDate ? { toDate } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), limit: 25 }));
  const nextHref = (cursor: string) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ state, customerId, fromDate, toDate, cursor })) if (value) next.set(key, value);
    return `/deposits?${next.toString()}`;
  };
  return (
    <>
      <PageHeader title={t("collections.deposits.title")} description={t("collections.deposits.description")} />
      <Card>
        <form method="get" className="grid grid-cols-1 gap-3 border-b border-border px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          {customerId ? <input type="hidden" name="customerId" value={customerId} /> : null}
          <Field id="state" label={t("collections.deposits.filterState")}>
            <Select {...describe("state", {})} name="state" defaultValue={state ?? ""}>
              <option value="">{t("common.labels.all")}</option>
              {STATES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`status.deposit.${entry}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="fromDate" label={t("collections.deposits.from")}>
            <Input {...describe("fromDate", {})} type="date" name="fromDate" defaultValue={fromDate ?? ""} dir="ltr" />
          </Field>
          <Field id="toDate" label={t("collections.deposits.to")}>
            <Input {...describe("toDate", {})} type="date" name="toDate" defaultValue={toDate ?? ""} dir="ltr" />
          </Field>
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
          <div data-testid="deposit-list">
            <p className="border-b border-border px-4 py-3 text-sm text-muted sm:px-5">{t("collections.deposits.window", { from: result.data.window.fromDate, to: result.data.window.toDate })}</p>
            <DepositList deposits={result.data.items} locale={locale} timeZone={deps.timeZone} hrefBase="/deposits" audience="CORPORATE" empty={<EmptyState title={t("collections.deposits.empty")} />} />
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
    </>
  );
}
