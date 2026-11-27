import { getTranslations } from "next-intl/server";
import { Callout, PageHeader } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { PaymentWizard, type WizardAccount } from "@/features/payments/client/payment-wizard";
import { Link } from "@/i18n/navigation";
import { listAccounts } from "@/server/domain/accounts/service";
import { listBeneficiaries } from "@/server/domain/payments/beneficiaries";
import { getPaymentOptions } from "@/server/domain/payments/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function NewPaymentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "payments.create")) return <Forbidden />;

  const [options, accounts, beneficiaries] = await Promise.all([
    load(() => getPaymentOptions(deps, ctx)),
    load(() => listAccounts(deps, ctx)),
    load(() => listBeneficiaries(deps, ctx, { limit: 100 })),
  ]);
  const back = (
    <Link href="/payments" className="text-accent hover:underline">
      ← {t("corp.payments.title")}
    </Link>
  );
  if (!options.ok) return <LoadError code={options.code} />;
  if (!accounts.ok) return <LoadError code={accounts.code} />;
  if (!beneficiaries.ok) return <LoadError code={beneficiaries.code} />;

  if (options.data.agreementState !== "ACTIVE") {
    return (
      <>
        <PageHeader title={t("corp.payments.wizard.title")} back={back} />
        <Callout tone="warning" role="alert" title={t("corp.agreement.inactiveTitle")} testId="agreement-blocked">
          {t("errors.AGREEMENT_INACTIVE")}
        </Callout>
      </>
    );
  }

  const wizardAccounts: WizardAccount[] = accounts.data.map((account) => ({
    id: account.id,
    name: locale === "ar" ? account.nameAr : account.name,
    maskedNumber: account.maskedNumber,
    currency: account.currency,
    status: account.status,
    canDebit: account.rights.debit && (options.data.enabledTypes[account.id]?.length ?? 0) > 0,
    available: account.balance?.available ?? null,
  }));

  return (
    <>
      <PageHeader title={t("corp.payments.wizard.title")} back={back} />
      <PaymentWizard
        accounts={wizardAccounts}
        beneficiaries={beneficiaries.data.items
          .filter((entry) => entry.matchStatus === "MATCHED" || entry.matchStatus === "CLOSE_MATCH")
          .map((entry) => ({
            id: entry.id,
            displayName: entry.displayName,
            maskedReference: entry.maskedReference,
            bankName: entry.bankName,
            matchStatus: entry.matchStatus,
            matchedName: entry.matchedName,
            closeMatchAcknowledged: entry.closeMatchAcknowledged,
          }))}
        enabledTypes={options.data.enabledTypes}
        timeZone={deps.timeZone}
        today={options.data.today}
      />
    </>
  );
}
