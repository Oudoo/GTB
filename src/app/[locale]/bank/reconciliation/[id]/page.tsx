import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, DetailList, EmptyState, Money, PageHeader } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { ResolutionForm } from "@/features/operations/client/recon-forms";
import { Link } from "@/i18n/navigation";
import { formatDate, formatDateTime } from "@/lib/format";
import { getReconciliationRun } from "@/server/domain/operations/reconciliation";
import { can, load, requireBankPage } from "@/server/page";

type Side = { principalMinor?: string; feeMinor?: string; count?: number; platformState?: string; kind?: string; source?: string } | null;

export default async function ReconciliationRunPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireBankPage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.recon.manage")) return <Forbidden />;
  const result = await load(() => getReconciliationRun(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const { run, breaks } = result.data;

  const side = (value: Side) =>
    value ? (
      <span className="flex flex-col text-sm">
        {value.principalMinor !== undefined ? <Money value={{ currency: "LYD", minor: value.principalMinor }} /> : null}
        {value.feeMinor !== undefined && value.feeMinor !== "0" ? (
          <span className="text-muted">
            {t("common.labels.fee")}: <Money value={{ currency: "LYD", minor: value.feeMinor }} />
          </span>
        ) : null}
        {value.count !== undefined && value.count !== 1 ? <span>× {value.count}</span> : null}
        {value.platformState ? <Code className="text-xs">{value.platformState}</Code> : null}
      </span>
    ) : (
      <span className="text-muted">—</span>
    );

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {t("ops.recon.runTitle", { date: formatDate(run.businessDate, locale, deps.timeZone) })}
            <span data-testid="run-state" data-state={run.state}>
              <Badge tone={run.state === "COMPLETED" ? (run.openBreaks > 0 ? "warning" : "success") : run.state === "FAILED" ? "danger" : "info"}>
                {t(`ops.recon.runState.${run.state}` as Parameters<typeof t>[0])}
              </Badge>
            </span>
          </span>
        }
        back={
          <Link href="/bank/reconciliation" className="text-accent hover:underline">
            ← {t("ops.recon.title")}
          </Link>
        }
      />
      <div className="flex flex-col gap-5">
        {run.state === "RUNNING" ? <Callout tone="info" role="status">{t("ops.recon.refresh")}</Callout> : null}
        <Card>
          <div className="p-4 sm:p-5">
            <DetailList
              items={[
                { label: t("ops.recon.expected"), value: <span className="tabular" data-testid="run-expected">{run.expectedCount}</span> },
                { label: t("ops.recon.inCore"), value: <span className="tabular">{run.coreCount}</span> },
                { label: t("ops.recon.matched"), value: <span className="tabular" data-testid="run-matched">{run.matchedCount}</span> },
                { label: t("ops.recon.breaks"), value: <span className="tabular font-semibold" data-testid="run-breaks">{run.breakCount}</span> },
                { label: t("common.labels.created"), value: `${formatDateTime(run.startedAt, locale, deps.timeZone)} · ${run.startedBy ?? ""}` },
              ]}
            />
          </div>
        </Card>
        <Card data-testid="recon-breaks">
          <CardHeader title={t("ops.recon.breaks")} />
          {breaks.length === 0 ? (
            <EmptyState title={run.state === "COMPLETED" ? t("ops.recon.noBreaks") : t("ops.recon.refresh")} />
          ) : (
            <ul className="divide-y divide-border">
              {breaks.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-3 p-4 sm:p-5" data-kind={entry.kind} data-break-state={entry.state} data-reference={entry.executionReference}>
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    <Badge tone="danger">{t(`ops.recon.kind.${entry.kind}`)}</Badge>
                    <Code className="text-xs">{entry.executionReference}</Code>
                    <Badge tone={entry.state === "RESOLVED" ? "success" : entry.state === "IN_REVIEW" ? "info" : "warning"}>{t(`ops.recon.breakState.${entry.state}` as Parameters<typeof t>[0])}</Badge>
                  </p>
                  {entry.corporate ? <bdi className="text-sm text-muted">{locale === "ar" ? entry.corporate.nameAr : entry.corporate.name}</bdi> : null}
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-muted">{t("ops.recon.platform")}</dt>
                      <dd>{side(entry.expected as Side)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t("ops.recon.core")}</dt>
                      <dd>{side(entry.actual as Side)}</dd>
                    </div>
                  </dl>
                  {entry.resolutions.length > 0 ? (
                    <div>
                      <p className="text-sm font-semibold">{t("ops.recon.resolutionHistory")}</p>
                      <ol className="mt-1 flex flex-col gap-1 text-sm" data-testid="resolution-history">
                        {entry.resolutions.map((resolution) => (
                          <li key={resolution.id}>
                            <Badge>{t(`ops.recon.dispositions.${resolution.disposition}` as Parameters<typeof t>[0])}</Badge> {resolution.actor} · {formatDateTime(resolution.at, locale, deps.timeZone)}
                            <bdi className="block text-muted">{resolution.reason}</bdi>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                  <div>
                    <ResolutionForm breakId={entry.id} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
