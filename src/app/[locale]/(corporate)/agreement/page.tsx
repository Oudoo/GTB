import { getTranslations } from "next-intl/server";
import { Callout, Card, CardHeader, DetailList, EmptyState, PageHeader } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { TermsView } from "@/features/agreement/terms-view";
import { Forbidden, LoadError } from "@/features/common/states";
import { formatDateTime } from "@/lib/format";
import { getCorporateAgreement } from "@/server/domain/agreements/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function AgreementPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "agreement.read")) return <Forbidden />;
  const result = await load(() => getCorporateAgreement(deps, ctx));
  if (!result.ok) return <LoadError code={result.code} />;
  const overview = result.data;
  const effective = overview.versions.find((version) => version.id === overview.effectiveVersionId) ?? null;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {t("corp.agreement.title")}
            <span data-testid="agreement-state"><StatusBadge family="agreement" state={overview.state === "NO_AGREEMENT" ? "DRAFT" : overview.state} /></span>
          </span>
        }
        description={t("corp.agreement.description")}
      />
      <div className="flex flex-col gap-5">
        {overview.state === "SUSPENDED" ? (
          <Callout tone="warning" role="alert" title={t("corp.agreement.suspendedTitle")}>
            <bdi>{overview.agreement?.suspensionReason}</bdi>
          </Callout>
        ) : overview.state !== "ACTIVE" ? (
          <Callout tone="warning" role="alert" title={t("corp.agreement.inactiveTitle")} testId="agreement-inactive">
            {t("corp.agreement.inactiveBody")}
          </Callout>
        ) : null}

        {effective ? (
          <Card>
            <CardHeader title={t("corp.agreement.version", { version: effective.versionNo })} action={<StatusBadge family="agreementVersion" state={effective.status} />} />
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
                ]}
              />
              <TermsView terms={effective.terms} accounts={overview.accounts} evidence={effective.signatureEvidence} />
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title={t("corp.agreement.history")} />
          {overview.versions.length === 0 ? (
            <EmptyState title={t("corp.agreement.noHistory")} />
          ) : (
            <ul className="divide-y divide-border">
              {overview.versions.map((version) => (
                <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
                  <span>
                    <span className="font-semibold">{t("corp.agreement.version", { version: version.versionNo })}</span>
                    <span className="block text-sm text-muted">
                      {formatDateTime(version.effectiveFrom, locale, deps.timeZone)} → {formatDateTime(version.effectiveUntil, locale, deps.timeZone)}
                    </span>
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
