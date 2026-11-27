import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { ApprovalSummaryLine } from "@/features/approvals/approval-summary";
import { LoadError } from "@/features/common/states";
import { ageText, formatDateTime } from "@/lib/format";
import { getBankOverview } from "@/server/domain/dashboard/service";
import { can, load, requireBankPage } from "@/server/page";

export default async function BankOverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  const result = await load(() => getBankOverview(deps, ctx));
  if (!result.ok) return <LoadError code={result.code} />;
  const overview = result.data;
  const bankName = locale === "ar" ? overview.bank.nameAr : overview.bank.name;

  return (
    <>
      <PageHeader
        title={t("bank.overview.title")}
        description={
          <>
            {t("bank.overview.description", { bank: bankName })}
            {overview.branch ? <span className="block">{t("bank.overview.branch", { branch: locale === "ar" ? overview.branch.nameAr : overview.branch.name })}</span> : null}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card data-testid="bank-my-approvals">
          <CardHeader
            title={t("bank.overview.myApprovals")}
            action={overview.approvals.actionableCount > 0 ? <Badge tone="warning">{overview.approvals.actionableCount}</Badge> : null}
          />
          {overview.approvals.actionable.length === 0 ? (
            <EmptyState title={t("bank.overview.noApprovals")} />
          ) : (
            <ul className="divide-y divide-border">
              {overview.approvals.actionable.map((approval) => (
                <li key={approval.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <ApprovalSummaryLine approval={approval} />
                  </div>
                  <LinkButton href={`/bank/approvals/${approval.id}`}>{t("corp.approvals.review")}</LinkButton>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {overview.corporates ? (
          <Card>
            <CardHeader
              title={t("bank.overview.byState")}
              action={can(ctx, "bank.corporates.read") ? <LinkButton variant="secondary" href="/bank/corporates">{t("bank.overview.corporates")}</LinkButton> : null}
            />
            {overview.corporates.total === 0 ? (
              <EmptyState title={t("bank.corporates.empty")} />
            ) : (
              <ul className="divide-y divide-border">
                {overview.corporates.byState.map((entry) => (
                  <li key={entry.state} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <StatusBadge family="agreement" state={entry.state === "NO_AGREEMENT" ? "DRAFT" : entry.state} />
                    <span className="tabular font-semibold">{entry.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        {overview.worker ? (
          <Card className="lg:col-span-2" data-testid="worker-health" data-healthy={overview.worker.healthy}>
            <CardHeader
              title={t("bank.overview.worker")}
              action={<StatusBadge family="job" state={overview.worker.healthy ? "SUCCEEDED" : "DEAD"} />}
            />
            <div className="flex flex-col gap-3 p-4 sm:p-5">
              {overview.worker.lastSeenAt ? (
                <p className="text-sm">
                  {t("bank.overview.workerSeen", { when: ageText(overview.worker.lastSeenAt, new Date(), locale) })}{" "}
                  <span className="text-muted">({formatDateTime(overview.worker.lastSeenAt, locale, deps.timeZone)})</span>
                </p>
              ) : null}
              {!overview.worker.healthy ? (
                <Callout tone="warning" role="alert">{t("bank.overview.workerNever")}</Callout>
              ) : null}
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted">{t("bank.overview.queuePending")}</dt>
                  <dd className="tabular text-lg font-semibold" data-testid="queue-pending">{overview.worker.queue.pending}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t("bank.overview.queueDead")}</dt>
                  <dd className="tabular text-lg font-semibold" data-testid="queue-dead">{overview.worker.queue.dead}</dd>
                </div>
                {overview.worker.queue.oldestPendingAgeSeconds !== null ? (
                  <div className="col-span-2 sm:col-span-1">
                    <dt className="text-muted">{t("common.labels.details")}</dt>
                    <dd>{t("bank.overview.queueOldest", { seconds: overview.worker.queue.oldestPendingAgeSeconds })}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
