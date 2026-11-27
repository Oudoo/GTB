import { getTranslations } from "next-intl/server";
import { Badge, Card, CardHeader, DataList, EmptyState, LinkButton, PageHeader, type Column } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { StartRunForm } from "@/features/operations/client/recon-forms";
import { businessDateOf } from "@/lib/calendar";
import { formatDate, formatDateTime } from "@/lib/format";
import { listReconciliationRuns, type ReconRunView } from "@/server/domain/operations/reconciliation";
import { can, load, requireBankPage } from "@/server/page";

export default async function ReconciliationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.recon.manage")) return <Forbidden />;
  const result = await load(() => listReconciliationRuns(deps, ctx));
  if (!result.ok) return <LoadError code={result.code} />;
  const today = businessDateOf(deps.clock.now(), deps.timeZone);
  const runState = (state: string) => {
    const key = `ops.recon.runState.${state}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : state;
  };

  const columns: Column<ReconRunView>[] = [
    { key: "date", header: t("ops.recon.businessDate"), primary: true, cell: (run) => formatDate(run.businessDate, locale, deps.timeZone) },
    {
      key: "state",
      header: t("common.labels.status"),
      cell: (run) => <Badge tone={run.state === "COMPLETED" ? (run.openBreaks > 0 ? "warning" : "success") : run.state === "FAILED" ? "danger" : "info"}>{runState(run.state)}</Badge>,
    },
    { key: "expected", header: t("ops.recon.expected"), numeric: true, cell: (run) => <span className="tabular">{run.expectedCount}</span> },
    { key: "matched", header: t("ops.recon.matched"), numeric: true, cell: (run) => <span className="tabular">{run.matchedCount}</span> },
    { key: "breaks", header: t("ops.recon.breaks"), numeric: true, cell: (run) => <span className="tabular font-semibold">{run.breakCount}</span> },
    { key: "open", header: t("ops.recon.openBreaks"), numeric: true, cell: (run) => <span className="tabular">{run.openBreaks}</span> },
    { key: "started", header: t("common.labels.created"), cell: (run) => <>{formatDateTime(run.startedAt, locale, deps.timeZone)} · {run.startedBy ?? ""}</> },
  ];

  return (
    <>
      <PageHeader title={t("ops.recon.title")} description={t("ops.recon.description")} />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title={t("ops.recon.start")} description={t("common.labels.bankTime", { zone: deps.timeZone })} />
          <div className="p-4 sm:p-5">
            <StartRunForm defaultDate={today} maxDate={today} />
          </div>
        </Card>
        <Card data-testid="recon-runs">
          <CardHeader title={t("ops.recon.runs")} />
          <DataList
            rows={result.data}
            columns={columns}
            rowKey={(run) => run.id}
            caption={t("ops.recon.runs")}
            empty={<EmptyState title={t("ops.recon.noRuns")} />}
            action={(run) => (
              <LinkButton variant="secondary" href={`/bank/reconciliation/${run.id}`}>
                {t("common.actions.view")}
              </LinkButton>
            )}
          />
        </Card>
      </div>
    </>
  );
}
