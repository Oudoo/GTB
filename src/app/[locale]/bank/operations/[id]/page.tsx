import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, DetailList, EmptyState, Money, PageHeader } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { InquireButton, RepairForm } from "@/features/operations/client/execution-actions";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { getExecution } from "@/server/domain/operations/service";
import { can, load, requireBankPage } from "@/server/page";

export default async function ExecutionPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireBankPage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.operations.read")) return <Forbidden />;
  const result = await load(() => getExecution(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const execution = result.data;
  const { instruction } = execution;
  const label = (prefix: string, key: string) => {
    const full = `ops.${prefix}.${key}` as Parameters<typeof t>[0];
    return t.has(full) ? t(full) : key;
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {t("ops.detail.title")} <Code className="text-lg">{execution.executionReference}</Code>
            <span data-testid="execution-state" data-state={execution.state}>
              <Badge tone={execution.state === "UNKNOWN" ? "warning" : execution.state === "FAILED" ? "danger" : execution.state === "BOOKED" ? "success" : "info"}>{t(`ops.state.${execution.state}`)}</Badge>
            </span>
          </span>
        }
        back={
          <Link href="/bank/operations" className="text-accent hover:underline">
            ← {t("ops.detail.back")}
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader title={t("ops.detail.instruction")} description={t("ops.detail.attempt", { number: execution.attemptNo })} />
            <div className="p-4 sm:p-5">
              <DetailList
                items={[
                  { label: t("ops.detail.corporate"), value: <bdi>{locale === "ar" ? execution.corporate.nameAr : execution.corporate.name}</bdi> },
                  { label: t("common.labels.reference"), value: instruction.reference ? <Code>{instruction.reference}</Code> : "—" },
                  { label: t("common.labels.amount"), value: instruction.amount ? <Money value={instruction.amount} className="font-semibold" /> : t("ops.queue.masked"), testId: "execution-amount" },
                  { label: t("common.labels.fee"), value: instruction.fee ? <Money value={instruction.fee} /> : "—" },
                  { label: t("common.labels.rail"), value: t(`types.rail.${instruction.rail}` as Parameters<typeof t>[0]) },
                  { label: t("common.labels.type"), value: t(`types.transactionType.${instruction.transactionType}` as Parameters<typeof t>[0]) },
                  {
                    label: t("corp.payments.recipient"),
                    value: instruction.confidential ? t("ops.queue.masked") : (
                      <>
                        <bdi>{instruction.destinationName ?? "—"}</bdi> {instruction.destinationMasked ? <Code className="text-xs">{instruction.destinationMasked}</Code> : null}
                      </>
                    ),
                    wide: true,
                  },
                  ...(execution.unknownPhase ? [{ label: t("ops.detail.phase"), value: <Code>{execution.unknownPhase}</Code> }] : []),
                  ...(execution.failureCode ? [{ label: t("types.failure.OTHER"), value: <Code>{execution.failureCode}</Code> }] : []),
                  { label: t("ops.detail.inquiries"), value: <span data-testid="inquiry-count">{execution.inquiryCount}</span> },
                  {
                    label: t("ops.queue.lastInquiry"),
                    value: execution.lastInquiryAt ? (
                      <span data-testid="last-inquiry" data-result={execution.lastInquiryResult ?? ""}>
                        {formatDateTime(execution.lastInquiryAt, locale, deps.timeZone)} · <Code className="text-xs">{execution.lastInquiryResult}</Code>
                      </span>
                    ) : (
                      t("ops.queue.never")
                    ),
                  },
                ]}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title={t("ops.detail.proposals")} />
            {execution.proposals.length === 0 ? (
              <EmptyState title={t("ops.detail.noProposals")} />
            ) : (
              <ul className="divide-y divide-border" data-testid="repair-proposals">
                {execution.proposals.map((proposal) => {
                  const outcome = (proposal.outcome ?? {}) as { result?: string };
                  return (
                    <li key={proposal.id} className="flex flex-col gap-1 px-4 py-3 sm:px-5" data-status={proposal.status}>
                      <p className="flex flex-wrap items-center gap-2 font-semibold">
                        {t(`ops.detail.actions.${proposal.action}`)}
                        <Badge tone={proposal.status === "EXECUTED" ? "success" : proposal.status === "PENDING_APPROVAL" ? "warning" : proposal.status === "APPROVED" ? "info" : "neutral"}>{t(`ops.detail.status.${proposal.status}`)}</Badge>
                      </p>
                      <p className="text-sm text-muted">
                        {t("ops.detail.proposedBy", { name: proposal.proposedBy })} · {formatDateTime(proposal.createdAt, locale, deps.timeZone)}
                      </p>
                      <bdi className="text-sm">{proposal.reason}</bdi>
                      {outcome.result ? (
                        <p className="text-sm" data-testid="repair-result" data-result={outcome.result}>
                          {t("ops.detail.result")}: {label("detail.results", outcome.result)}
                        </p>
                      ) : null}
                      {proposal.status === "PENDING_APPROVAL" && proposal.approvalRequestId ? (
                        <Link href={`/bank/approvals/${proposal.approvalRequestId}`} className="text-sm font-semibold text-accent hover:underline" data-testid="open-repair-approval">
                          {t("ops.detail.openApproval")}
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title={t("ops.detail.history")} />
            <ol className="divide-y divide-border" data-testid="execution-history">
              {execution.history.map((entry, index) => (
                <li key={index} className="px-4 py-2.5 text-sm sm:px-5" data-code={entry.code}>
                  <span className="font-semibold">{label("history", entry.code)}</span>
                  <span className="block text-muted">
                    {formatDateTime(entry.at, locale, deps.timeZone)} · <bdi>{entry.actor ?? entry.service ?? ""}</bdi>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {!can(ctx, "bank.operations.act") ? (
            <Callout tone="neutral" role="note">{t("ops.detail.noAccess")}</Callout>
          ) : (
            <>
              {execution.actions.inquire ? (
                <Card>
                  <CardHeader title={t("ops.detail.inquire")} />
                  <div className="p-4 sm:p-5">
                    <InquireButton executionId={execution.id} />
                  </div>
                </Card>
              ) : null}
              <Card>
                <CardHeader title={t("ops.detail.repairTitle")} />
                <div className="p-4 sm:p-5">
                  {execution.actions.proposeRepair ? (
                    <RepairForm executionId={execution.id} />
                  ) : (
                    <Callout tone={execution.repairBlockedBy === "INQUIRE_FIRST" ? "warning" : "neutral"} role="status" testId="repair-blocked">
                      <span data-reason={execution.repairBlockedBy ?? ""}>{execution.repairBlockedBy ? t(`ops.detail.blocked.${execution.repairBlockedBy}`) : ""}</span>
                    </Callout>
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
