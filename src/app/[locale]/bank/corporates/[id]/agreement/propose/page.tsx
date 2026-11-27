import { getTranslations } from "next-intl/server";
import { Callout, PageHeader } from "@/components/ui/primitives";
import { AgreementEditor } from "@/features/agreement/client/agreement-editor";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { addDays, businessDateOf, localTimeOf } from "@/lib/calendar";
import { getAgreementTemplate, getBankAgreementOverview } from "@/server/domain/agreements/service";
import { can, load, requireBankPage } from "@/server/page";

export default async function ProposeAgreementPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, session, locale } = await requireBankPage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.agreement.propose")) return <Forbidden />;
  const [overviewResult, templateResult] = await Promise.all([
    load(() => getBankAgreementOverview(deps, ctx, id)),
    load(() => getAgreementTemplate(deps, ctx, id)),
  ]);
  if (!overviewResult.ok) return <LoadError code={overviewResult.code} />;
  if (!templateResult.ok) return <LoadError code={templateResult.code} />;
  const overview = overviewResult.data;
  const corporateName = locale === "ar" ? overview.corporate.legalNameAr : overview.corporate.legalName;
  const pending = overview.versions.some((version) => version.status === "PENDING_APPROVAL");
  // A revision starts from the terms it replaces; the first one starts from the demo template.
  const basis = overview.versions.find((version) => version.status === "EFFECTIVE" || version.status === "APPROVED") ?? null;

  const now = deps.clock.now();
  const today = businessDateOf(now, deps.timeZone);
  const back = (
    <Link href={`/bank/corporates/${id}/agreement`} className="text-accent hover:underline">
      ← <bdi>{t("bank.agreement.title", { corporate: corporateName })}</bdi>
    </Link>
  );

  return (
    <>
      <PageHeader title={t("bank.editor.title")} description={t("bank.editor.description")} back={back} />
      {pending ? (
        <Callout tone="warning" role="status" title={t("bank.agreement.pendingTitle")} testId="pending-blocks-proposal" />
      ) : overview.agreement?.status === "CLOSED" ? (
        <Callout tone="neutral" role="status" title={t("status.agreement.CLOSED")} />
      ) : (
        <AgreementEditor
          corporateId={id}
          segment={overview.corporate.segment as "LARGE" | "MEDIUM" | "SMALL"}
          initialTerms={basis?.terms ?? templateResult.data}
          accounts={overview.accounts
            .filter((account) => account.status !== "CLOSED")
            .map((account) => ({ id: account.id, label: `${locale === "ar" ? account.nameAr : account.name} (${account.maskedNumber})` }))}
          timeZone={deps.timeZone}
          defaultFrom={`${today}T${localTimeOf(now, deps.timeZone)}`}
          defaultUntil={`${addDays(today, 365)}T00:00`}
          signerDefault={session.person.name}
        />
      )}
    </>
  );
}
