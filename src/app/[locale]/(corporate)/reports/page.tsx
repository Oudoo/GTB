import { getTranslations } from "next-intl/server";
import { Callout, Card, CardHeader, Code, DataList, EmptyState, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { AutoRefresh } from "@/features/batches/client/batch-forms";
import { Forbidden, LoadError } from "@/features/common/states";
import { ReportRequestForm } from "@/features/reports/client/report-forms";
import { businessDateOf } from "@/lib/calendar";
import { formatDateTime } from "@/lib/format";
import { rightsFor } from "@/server/auth/context";
import { listAccounts } from "@/server/domain/accounts/service";
import { listReports, type ReportView } from "@/server/domain/reports/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function ReportsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "reports.request")) return <Forbidden />;
  const [accounts, reports] = await Promise.all([load(() => listAccounts(deps, ctx, { withBalances: false })), load(() => listReports(deps, ctx))]);
  const exportable = accounts.ok ? accounts.data.filter((account) => rightsFor(ctx, account.id).report).map((account) => ({ id: account.id, label: `${locale === "ar" ? account.nameAr : account.name} · ${account.maskedNumber}` })) : [];
  const columns: Column<ReportView>[] = [
    {
      key: "type",
      header: t("reports.type"),
      primary: true,
      cell: (report) => (
        <span>
          {t(`reports.types.${report.type === "DEPOSIT_SUMMARY" ? "DEPOSIT_SUMMARY" : "STATEMENT"}`)} · {report.format}
        </span>
      ),
    },
    { key: "accounts", header: t("reports.accounts"), cell: (report) => report.accounts.map((account) => account.maskedNumber).join(", ") },
    { key: "period", header: t("reports.period"), cell: (report) => <Code>{report.fromDate} — {report.toDate}</Code> },
    {
      key: "state",
      header: t("reports.state"),
      cell: (report) => (
        <span className="flex flex-col gap-1">
          <StatusBadge family="report" state={report.state} />
          {report.state === "FAILED" ? <span className="text-sm text-danger" data-code={report.failureCode ?? ""}>{report.failureCode === "PERMISSION_DENIED" ? t("reports.failedDenied") : t("reports.failed")}</span> : null}
          {report.state === "EXPIRED" ? <span className="text-sm text-muted">{t("reports.expired")}</span> : null}
        </span>
      ),
    },
    { key: "rows", header: t("reports.rows"), numeric: true, cell: (report) => report.rowCount ?? "—" },
    { key: "requested", header: t("reports.requested"), cell: (report) => <time dateTime={report.createdAt}>{formatDateTime(report.createdAt, locale, deps.timeZone)}</time> },
  ];
  const pending = reports.ok && reports.data.some((report) => report.state === "PENDING");
  return (
    <>
      {pending ? <AutoRefresh /> : null}
      <PageHeader title={t("reports.title")} description={t("reports.description")} />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title={t("reports.requestTitle")} />
          <div className="p-4 sm:p-5">
            {exportable.length === 0 ? <Callout tone="warning">{t("reports.noAccounts")}</Callout> : <ReportRequestForm accounts={exportable} today={businessDateOf(deps.clock.now(), deps.timeZone)} canDeposits={can(ctx, "deposits.read")} locale={locale} />}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("reports.listTitle")} />
          {!reports.ok ? (
            <div className="p-4">
              <LoadError code={reports.code} />
            </div>
          ) : (
            <div data-testid="report-list">
              <DataList
                rows={reports.data}
                columns={columns}
                rowKey={(report) => report.id}
                caption={t("reports.caption")}
                empty={<EmptyState title={t("reports.empty")} />}
                action={(report) =>
                  report.downloadable ? (
                    <a className="min-touch inline-flex items-center rounded-lg px-3 text-sm font-semibold text-accent underline" href={`/api/v1/reports/${report.id}/download`} download data-testid="report-download">
                      {t("reports.download")}
                    </a>
                  ) : report.state === "PENDING" ? (
                    <span className="text-sm text-muted">{t("reports.preparing")}</span>
                  ) : null
                }
              />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
