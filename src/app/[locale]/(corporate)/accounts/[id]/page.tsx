import { getTranslations } from "next-intl/server";
import { Field, Input, Select, describe } from "@/components/ui/form";
import { Badge, Button, Card, CardHeader, Code, DataList, EmptyState, LinkButton, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { BalanceCard } from "@/features/accounts/balance-card";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { formatDate, formatTime, moneyText } from "@/lib/format";
import { getAccount, getStatement, type StatementLine } from "@/server/domain/accounts/service";
import { can, load, requireCorporatePage } from "@/server/page";

type Search = { fromDate?: string; toDate?: string; view?: string; reference?: string; cursor?: string };

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const { locale: localeParam, id } = await params;
  const search = await searchParams;
  const { deps, ctx, locale } = await requireCorporatePage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "accounts.read")) return <Forbidden />;

  const account = await load(() => getAccount(deps, ctx, id));
  if (!account.ok) return <LoadError code={account.code} />;
  const view = search.view === "intraday" || search.view === "completed" ? search.view : "all";
  const statement = await load(() =>
    getStatement(deps, ctx, id, {
      fromDate: search.fromDate || undefined,
      toDate: search.toDate || undefined,
      view,
      reference: search.reference || undefined,
      cursor: search.cursor || undefined,
      limit: 25,
    }),
  );

  const columns: Column<StatementLine>[] = [
    {
      key: "description",
      header: t("corp.accounts.description2"),
      primary: true,
      cell: (line) => (
        <span data-line={line.kind} data-reference={line.reference ?? ""} data-signed-minor={line.signedMinor}>
          <Badge tone={line.kind === "RETURN" ? "warning" : "neutral"}>{t(`corp.accounts.lineKind.${line.kind}` as Parameters<typeof t>[0])}</Badge>{" "}
          {line.kind === "PAYROLL_RUN" ? (
            // One consolidated line per payroll run: no employee is identifiable here (PYR-02).
            <span data-testid="payroll-line">
              <bdi>{line.description}</bdi> · {t("corp.accounts.payrollRun", { count: line.itemCount })}
              {line.includedFee ? (
                <span className="block text-xs text-muted">
                  <bdi>{t("corp.accounts.payrollFee", { fee: moneyText(line.includedFee) })}</bdi>
                </span>
              ) : null}
            </span>
          ) : (
            <bdi>{line.description}</bdi>
          )}
          {line.reference ? (
            <span className="block text-xs text-muted">
              <Code>{line.reference}</Code>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "date",
      header: t("common.labels.date"),
      cell: (line) => (
        <time dateTime={line.postedAt}>
          {formatDate(line.businessDate, locale, deps.timeZone)} · {formatTime(line.postedAt, locale, deps.timeZone)}
        </time>
      ),
    },
    {
      key: "amount",
      header: t("common.labels.amount"),
      numeric: true,
      cell: (line) => (
        <span className={line.amount.direction === "CREDIT" ? "font-semibold text-success" : "font-semibold"}>
          <Money value={line.amount} signed={line.amount.direction} />
          <span className="sr-only"> {line.amount.direction === "CREDIT" ? t("corp.accounts.credit") : t("corp.accounts.debit")}</span>
        </span>
      ),
    },
  ];

  const nextHref = (cursor: string) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...search, cursor })) if (value) query.set(key, value);
    return `/accounts/${id}?${query.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={locale === "ar" ? account.data.nameAr : account.data.name}
        back={
          <Link href="/accounts" className="text-accent hover:underline">
            ← {t("corp.accounts.title")}
          </Link>
        }
        actions={
          account.data.rights.report && can(ctx, "reports.request") ? (
            <LinkButton href={`/reports?accountId=${id}`} variant="secondary">
              {t("corp.accounts.requestReport")}
            </LinkButton>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-4">
          <BalanceCard account={account.data} timeZone={deps.timeZone} link={false} />
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold">{t("corp.accounts.rights")}</h2>
            <ul className="flex flex-wrap gap-2">
              {account.data.rights.read ? <li><Badge>{t("corp.accounts.rightRead")}</Badge></li> : null}
              {account.data.rights.debit ? <li><Badge tone="info">{t("corp.accounts.rightDebit")}</Badge></li> : null}
              {account.data.rights.approve ? <li><Badge tone="info">{t("corp.accounts.rightApprove")}</Badge></li> : null}
              {account.data.rights.report ? <li><Badge>{t("corp.accounts.rightReport")}</Badge></li> : null}
            </ul>
          </Card>
        </div>

        <Card>
          <CardHeader title={t("corp.accounts.activity")} description={t("corp.accounts.rangeNote", { zone: deps.timeZone })} />
          <form method="get" className="grid grid-cols-1 gap-3 border-b border-border px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-5" aria-label={t("corp.accounts.filterTitle")}>
            <Field id="view" label={t("corp.accounts.view")}>
              <Select {...describe("view", {})} name="view" defaultValue={view}>
                <option value="all">{t("corp.accounts.viewAll")}</option>
                <option value="intraday">{t("corp.accounts.viewIntraday")}</option>
                <option value="completed">{t("corp.accounts.viewCompleted")}</option>
              </Select>
            </Field>
            <Field id="fromDate" label={t("common.labels.from")}>
              <Input {...describe("fromDate", {})} name="fromDate" type="date" defaultValue={search.fromDate ?? ""} />
            </Field>
            <Field id="toDate" label={t("common.labels.to")}>
              <Input {...describe("toDate", {})} name="toDate" type="date" defaultValue={search.toDate ?? ""} />
            </Field>
            <Field id="reference" label={t("corp.accounts.search")}>
              <Input {...describe("reference", {})} name="reference" defaultValue={search.reference ?? ""} maxLength={64} dir="ltr" />
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="secondary" className="w-full">
                {t("corp.accounts.apply")}
              </Button>
            </div>
          </form>
          {!statement.ok ? (
            <div className="p-4">
              <LoadError code={statement.code} />
            </div>
          ) : (
            <>
              <DataList
                rows={statement.data.lines}
                columns={columns}
                rowKey={(line) => line.lineId}
                caption={t("corp.accounts.activity")}
                empty={<EmptyState title={t("corp.accounts.noActivity")} />}
              />
              {statement.data.nextCursor ? (
                <div className="border-t border-border p-4 text-center">
                  <LinkButton href={nextHref(statement.data.nextCursor)} variant="secondary">
                    {t("common.actions.loadMore")}
                  </LinkButton>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
