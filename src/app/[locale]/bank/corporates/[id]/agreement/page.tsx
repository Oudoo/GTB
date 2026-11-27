import { getTranslations } from "next-intl/server";
import { Callout, Card, CardHeader, Code, DetailList, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { RestoreControl, SuspendControl } from "@/features/agreement/client/agreement-controls";
import { TermsView } from "@/features/agreement/terms-view";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { getBankAgreementOverview } from "@/server/domain/agreements/service";
import { can, load, requireBankPage } from "@/server/page";

export default async function BankAgreementPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ proposed?: string }>;
}) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireBankPage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.corporates.read")) return <Forbidden />;
  const result = await load(() => getBankAgreementOverview(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const overview = result.data;
  const justProposed = (await searchParams).proposed === "1";

  const corporateName = locale === "ar" ? overview.corporate.legalNameAr : overview.corporate.legalName;
  const effective = overview.versions.find((version) => version.id === overview.effectiveVersionId) ?? null;
  const pending = overview.versions.find((version) => version.status === "PENDING_APPROVAL") ?? null;
  const canPropose = can(ctx, "bank.agreement.propose");
  const canSuspend = can(ctx, "bank.corporate.suspend");
  const status = overview.agreement?.status ?? "DRAFT";
  const closed = status === "CLOSED";

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi>{t("bank.agreement.title", { corporate: corporateName })}</bdi>
            <span data-testid="agreement-state"><StatusBadge family="agreement" state={overview.state === "NO_AGREEMENT" ? "DRAFT" : overview.state} /></span>
          </span>
        }
        back={
          <Link href="/bank/corporates" className="text-accent hover:underline">
            ← {t("bank.corporates.title")}
          </Link>
        }
        actions={
          canPropose && !pending && !closed ? (
            <LinkButton href={`/bank/corporates/${id}/agreement/propose`} data-testid="propose-revision">
              {overview.versions.length === 0 ? t("bank.agreement.proposeFirst") : t("bank.agreement.propose")}
            </LinkButton>
          ) : null
        }
      />
      <div className="flex flex-col gap-5">
        {justProposed && pending ? (
          <Callout tone="success" role="status" testId="proposal-created">{t("bank.editor.submitted")}</Callout>
        ) : null}
        {!canPropose ? <Callout tone="neutral" role="note">{t("bank.agreement.cannotPropose")}</Callout> : null}

        {pending ? (
          <Callout tone="warning" role="status" title={t("bank.agreement.pendingTitle")} testId="pending-revision">
            <p>{t("bank.agreement.pendingBody", { maker: pending.proposedBy })}</p>
            <p className="mt-2 flex flex-wrap gap-4">
              <Link href={`/bank/agreement-versions/${pending.id}`} className="font-semibold text-accent hover:underline" data-testid="open-pending-revision">
                {t("bank.agreement.review")}
              </Link>
              {pending.approvalRequestId ? (
                <Link href={`/bank/approvals/${pending.approvalRequestId}`} className="font-semibold text-accent hover:underline" data-testid="open-pending-approval">
                  {t("corp.approvals.detail.title")}
                </Link>
              ) : null}
            </p>
          </Callout>
        ) : null}

        {status === "SUSPENDED" ? (
          <Callout tone="warning" role="alert" title={t("bank.agreement.suspendedBy", { reason: overview.agreement?.suspensionReason ?? "" })} testId="agreement-suspended">
            {overview.pendingRestore ? (
              <p>
                {t("bank.agreement.restorePending")}{" "}
                {overview.pendingRestore.approvalRequestId ? (
                  <Link href={`/bank/approvals/${overview.pendingRestore.approvalRequestId}`} className="font-semibold text-accent hover:underline">
                    {t("corp.approvals.detail.title")}
                  </Link>
                ) : null}
              </p>
            ) : canPropose ? (
              <div className="mt-2">
                <RestoreControl corporateId={id} />
              </div>
            ) : null}
          </Callout>
        ) : null}

        {overview.versions.length === 0 ? (
          <Callout tone="info" role="note" testId="no-agreement">{t("bank.agreement.noVersion")}</Callout>
        ) : null}

        {effective ? (
          <Card>
            <CardHeader
              title={`${t("bank.agreement.current")} — ${t("corp.agreement.version", { version: effective.versionNo })}`}
              action={<StatusBadge family="agreementVersion" state={effective.status} />}
            />
            <div className="flex flex-col gap-5 p-4 sm:p-5">
              <DetailList
                items={[
                  { label: t("corp.agreement.segment"), value: t(`types.segment.${effective.segment}` as Parameters<typeof t>[0]) },
                  {
                    label: t("corp.agreement.validity"),
                    value: t("corp.agreement.validityRange", {
                      from: formatDateTime(effective.effectiveFrom, locale, deps.timeZone),
                      until: formatDateTime(effective.effectiveUntil, locale, deps.timeZone),
                    }),
                  },
                  { label: t("bank.agreement.proposedBy", { name: effective.proposedBy }), value: effective.approvedBy ? t("bank.agreement.approvedBy", { name: effective.approvedBy }) : "—" },
                  { label: t("corp.approvals.detail.digest"), value: <Code className="text-xs">{effective.termsHash}</Code> },
                ]}
              />
              <TermsView terms={effective.terms} accounts={overview.accounts} evidence={effective.signatureEvidence} />
              {canSuspend && status === "ACTIVE" && overview.agreement ? (
                <div className="border-t border-border pt-4">
                  <SuspendControl corporateId={id} version={overview.agreement.version} />
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title={t("bank.agreement.history")} />
          {overview.versions.length === 0 ? (
            <EmptyState title={t("corp.agreement.noHistory")} />
          ) : (
            <ul className="divide-y divide-border" data-testid="revision-history">
              {overview.versions.map((version) => (
                <li key={version.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <span className="min-w-0">
                    <Link href={`/bank/agreement-versions/${version.id}`} className="font-semibold text-accent hover:underline">
                      {t("corp.agreement.version", { version: version.versionNo })}
                    </Link>
                    <span className="block text-sm text-muted">
                      {formatDateTime(version.effectiveFrom, locale, deps.timeZone)} → {formatDateTime(version.effectiveUntil, locale, deps.timeZone)}
                    </span>
                    <span className="block text-sm text-muted">
                      {t("bank.agreement.proposedBy", { name: version.proposedBy })}
                      {version.approvedBy ? ` · ${t("bank.agreement.approvedBy", { name: version.approvedBy })}` : ""}
                    </span>
                    <bdi className="block text-sm">{version.changeReason}</bdi>
                  </span>
                  <StatusBadge family="agreementVersion" state={version.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
