import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, DetailList, LinkButton, Money, PageHeader } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { Forbidden, LoadError } from "@/features/common/states";
import { Timeline } from "@/features/common/timeline";
import { PaymentActions } from "@/features/payments/client/payment-actions";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { getPayment } from "@/server/domain/payments/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function PaymentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ submit?: string }>;
}) {
  const { locale: localeParam, id } = await params;
  const { submit } = await searchParams;
  const { deps, ctx, locale } = await requireCorporatePage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "payments.read")) return <Forbidden />;
  const result = await load(() => getPayment(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const payment = result.data;
  const approval = payment.approval;
  const remaining = approval ? Math.max(0, approval.requiredApprovals - approval.approvalsCount) : 0;
  const blockKey = payment.releaseBlockCode ? (`errors.${payment.releaseBlockCode}` as Parameters<typeof t>[0]) : null;
  const blockFallback = payment.releaseBlockCode ? (`types.failure.${payment.releaseBlockCode}` as Parameters<typeof t>[0]) : null;
  const failureKey = payment.failureCode ? (`types.failure.${payment.failureCode}` as Parameters<typeof t>[0]) : null;
  const policy = (payment.policy ?? {}) as { agreementVersionNo?: number; requiredCheckers?: number };

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{t("corp.payments.detail.title")} <Code>{payment.reference}</Code></span>
            <StatusBadge family="payment" state={payment.state} />
          </span>
        }
        description={t(`status.paymentHelp.${payment.state}`)}
        back={
          <Link href="/payments" className="text-accent hover:underline">
            ← {t("corp.payments.title")}
          </Link>
        }
      />

      <div className="flex flex-col gap-4">
        {submit === "failed" && payment.state === "DRAFT" ? (
          <Callout tone="warning" role="alert" title={t("corp.payments.wizard.saved")}>
            {t("corp.payments.wizard.cannotSubmit")}
          </Callout>
        ) : null}
        {payment.state === "STATUS_UNKNOWN" ? (
          <Callout tone="warning" role="alert" title={t("corp.payments.detail.unknownTitle")} testId="unknown-warning">
            {t("corp.payments.detail.unknownBody")}
          </Callout>
        ) : null}
        {payment.state === "PENDING_APPROVAL" ? (
          <Callout tone={payment.releaseBlockCode === "REAPPROVAL_REQUIRED" ? "warning" : "info"} role="status" testId="pending-note"
            title={payment.releaseBlockCode === "REAPPROVAL_REQUIRED" ? t("corp.payments.detail.reapprovalTitle") : undefined}>
            {payment.releaseBlockCode === "REAPPROVAL_REQUIRED" ? <p>{t("corp.payments.detail.reapprovalBody")}</p> : null}
            <p>{t("corp.payments.detail.pendingNote", { count: remaining })}</p>
            <p>{t("corp.payments.detail.nextActor")}</p>
          </Callout>
        ) : null}
        {payment.state === "APPROVED" && payment.releaseBlockCode ? (
          <Callout tone="warning" role="alert" title={t("corp.payments.detail.blockedTitle")} testId="release-blocked">
            <p>{t("corp.payments.detail.blockedBody")}</p>
            <p className="mt-1 font-medium" data-code={payment.releaseBlockCode}>
              {blockKey && t.has(blockKey) ? t(blockKey) : blockFallback && t.has(blockFallback) ? t(blockFallback) : payment.releaseBlockCode}
            </p>
          </Callout>
        ) : null}
        {payment.state === "FAILED" ? (
          <Callout tone="danger" role="alert" title={t("corp.payments.detail.failedTitle")} testId="failed-note">
            <p>{t("corp.payments.detail.failedBody")}</p>
            {failureKey ? <p className="mt-1 font-medium" data-code={payment.failureCode ?? ""}>{t.has(failureKey) ? t(failureKey) : t("types.failure.OTHER")}</p> : null}
          </Callout>
        ) : null}
        {payment.state === "RETURNED" ? (
          <Callout tone="warning" role="alert" title={t("corp.payments.detail.returnedTitle")}>
            {t("corp.payments.detail.returnedBody")}
          </Callout>
        ) : null}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader
                title={t("corp.payments.detail.instruction")}
                description={`${t("corp.payments.detail.revision", { revision: payment.revision })}${payment.maker.viaApi ? ` · ${t("corp.payments.detail.viaApi")}` : ""}`}
              />
              <div className="flex flex-col gap-4 p-4 sm:p-5">
                <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-canvas p-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.amount")}</p>
                    <p className="text-xl font-semibold" data-testid="payment-amount"><Money value={payment.amount} /></p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.fee")}</p>
                    <p className="text-xl font-semibold" data-testid="payment-fee">
                      {payment.state === "DRAFT" ? <span className="text-base font-normal text-muted">{t("common.money.estimate")}</span> : <Money value={payment.fee} />}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.totalDebit")}</p>
                    <p className="text-xl font-semibold" data-testid="payment-total">{payment.state === "DRAFT" ? "—" : <Money value={payment.totalDebit} />}</p>
                  </div>
                </div>
                <DetailList
                  items={[
                    {
                      label: t("corp.payments.recipient"),
                      value: (
                        <>
                          <span className="font-semibold">{payment.destination.name}</span>
                          <span className="block text-sm text-muted">
                            <Code>{payment.destination.maskedReference}</Code>
                            {payment.destination.bankName ? ` · ${payment.destination.bankName}` : ""}
                          </span>
                          {payment.destination.matchStatus ? <StatusBadge family="match" state={payment.destination.matchStatus} /> : null}
                        </>
                      ),
                    },
                    {
                      label: t("corp.payments.source"),
                      value: (
                        <>
                          {locale === "ar" ? payment.sourceAccount.nameAr : payment.sourceAccount.name}
                          <span className="block text-sm text-muted"><Code>{payment.sourceAccount.maskedNumber}</Code></span>
                        </>
                      ),
                    },
                    { label: t("common.labels.type"), value: t(`types.transactionType.${payment.transactionType}` as Parameters<typeof t>[0]) },
                    { label: t("common.labels.rail"), value: t(`types.rail.${payment.rail}` as Parameters<typeof t>[0]) },
                    { label: t("common.labels.purpose"), value: <bdi>{payment.purpose}</bdi>, wide: true },
                    {
                      label: t("corp.payments.executeAt"),
                      value: payment.execution.executeAt
                        ? `${formatDateTime(payment.execution.executeAt, locale, deps.timeZone)} · ${t("common.labels.bankTime", { zone: deps.timeZone })}`
                        : t("corp.payments.immediate"),
                    },
                    { label: t("common.labels.createdBy"), value: payment.maker.name },
                    ...(payment.clientReference ? [{ label: t("corp.payments.wizard.clientReference"), value: <Code>{payment.clientReference}</Code> }] : []),
                    ...(payment.executionReference
                      ? [{ label: t("corp.payments.detail.executionReference"), value: <Code>{payment.executionReference}</Code>, testId: "execution-reference", wide: true }]
                      : []),
                  ]}
                />
                <PaymentActions paymentId={payment.id} version={payment.version} actions={payment.actions} />
              </div>
            </Card>

            {approval ? (
              <Card>
                <CardHeader
                  title={t("corp.payments.detail.approvals")}
                  description={t("corp.payments.detail.approvalsCount", { count: approval.approvalsCount, required: approval.requiredApprovals })}
                  action={
                    approval.canAct ? (
                      <LinkButton href={`/approvals/${approval.id}`} data-testid="review-approval">
                        {t("corp.payments.detail.reviewApproval")}
                      </LinkButton>
                    ) : (
                      <StatusBadge family="approval" state={approval.state} />
                    )
                  }
                />
                <div className="p-4 sm:p-5">
                  {approval.votes.length === 0 ? (
                    <p className="text-muted">{t("corp.payments.detail.noVotes")}</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {approval.votes.map((vote) => (
                        <li key={vote.personId} className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            {vote.name}
                            {vote.reason ? <span className="block text-sm text-muted"><bdi>{vote.reason}</bdi></span> : null}
                          </span>
                          <span className="flex items-center gap-2 text-sm text-muted">
                            <Badge tone={vote.decision === "APPROVE" ? "success" : "danger"}>{vote.decision === "APPROVE" ? t("common.actions.approve") : t("common.actions.reject")}</Badge>
                            <time dateTime={vote.at}>{formatDateTime(vote.at, locale, deps.timeZone)}</time>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {policy.agreementVersionNo ? (
                    <p className="mt-3 text-sm text-muted">
                      {t("corp.payments.detail.policy")}: {t("corp.payments.detail.agreement", { version: policy.agreementVersionNo })}
                      {policy.requiredCheckers ? ` · ${t("corp.payments.wizard.checkersRequired", { count: policy.requiredCheckers })}` : ""}
                    </p>
                  ) : null}
                </div>
              </Card>
            ) : null}
          </div>

          <Card>
            <CardHeader title={t("common.labels.timeline")} />
            <div className="p-4 sm:p-5">
              <Timeline entries={payment.timeline} timeZone={deps.timeZone} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
