import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, DetailList, LinkButton, PageHeader } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { TermsDiff } from "@/features/agreement/terms-diff";
import { TermsView } from "@/features/agreement/terms-view";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { getAgreementVersionReview, getBankAgreementOverview } from "@/server/domain/agreements/service";
import { can, load, requireBankPage } from "@/server/page";

/**
 * One immutable revision with the field-level diff against the revision it would replace.
 * This is what the bank checker reads before deciding the governance proposal (GOV-002).
 */
export default async function AgreementVersionPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireBankPage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.corporates.read")) return <Forbidden />;
  const result = await load(() => getAgreementVersionReview(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const { version, changes, previousVersionNo, corporateId } = result.data;
  const overview = await load(() => getBankAgreementOverview(deps, ctx, corporateId));
  if (!overview.ok) return <LoadError code={overview.code} />;
  const corporateName = locale === "ar" ? overview.data.corporate.legalNameAr : overview.data.corporate.legalName;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi>{`${corporateName} — ${t("corp.agreement.version", { version: version.versionNo })}`}</bdi>
            <StatusBadge family="agreementVersion" state={version.status} />
          </span>
        }
        back={
          <Link href={`/bank/corporates/${corporateId}/agreement`} className="text-accent hover:underline">
            ← <bdi>{t("bank.agreement.title", { corporate: corporateName })}</bdi>
          </Link>
        }
        actions={
          version.status === "PENDING_APPROVAL" && version.approvalRequestId ? (
            <LinkButton href={`/bank/approvals/${version.approvalRequestId}`} data-testid="open-approval">
              {t("corp.approvals.detail.title")}
            </LinkButton>
          ) : null
        }
      />
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5">
        <Card>
          <div className="p-4 sm:p-5">
            <DetailList
              items={[
                {
                  label: t("corp.agreement.validity"),
                  wide: true,
                  value: t("corp.agreement.validityRange", {
                    from: formatDateTime(version.effectiveFrom, locale, deps.timeZone),
                    until: formatDateTime(version.effectiveUntil, locale, deps.timeZone),
                  }),
                },
                { label: t("common.labels.createdBy"), value: version.proposedBy, testId: "version-maker" },
                { label: t("common.actions.approve"), value: version.approvedBy ?? "—", testId: "version-approver" },
                { label: t("common.labels.reason"), value: <bdi>{version.changeReason}</bdi>, wide: true },
                ...(version.decisionReason ? [{ label: t("common.actions.reject"), value: <bdi>{version.decisionReason}</bdi>, wide: true }] : []),
                { label: t("corp.approvals.detail.digest"), value: <Code className="text-xs">{version.termsHash}</Code>, wide: true },
              ]}
            />
          </div>
        </Card>

        <Card data-testid="terms-diff">
          <CardHeader
            title={previousVersionNo === null ? t("bank.diff.titleFirst") : t("bank.diff.title", { version: previousVersionNo })}
            action={<Badge tone={changes.length > 0 ? "info" : "neutral"}>{t("bank.diff.count", { count: changes.length })}</Badge>}
          />
          {changes.length === 0 ? (
            <div className="p-4 sm:p-5">
              <Callout tone="neutral" role="note">{t("bank.diff.none")}</Callout>
            </div>
          ) : (
            <TermsDiff changes={changes} accounts={overview.data.accounts} />
          )}
        </Card>

        <Card>
          <CardHeader title={t("bank.diff.fullTerms")} />
          <div className="p-4 sm:p-5">
            <TermsView terms={version.terms} accounts={overview.data.accounts} evidence={version.signatureEvidence} />
          </div>
        </Card>
      </div>
    </>
  );
}
