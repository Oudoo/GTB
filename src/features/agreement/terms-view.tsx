import { getLocale, getTranslations } from "next-intl/server";
import type { AgreementTerms } from "@/contracts/agreement";
import { getModule } from "@/contracts/modules";
import { Badge, Callout, Code, Money } from "@/components/ui/primitives";

type AccountInfo = { id: string; name: string; nameAr: string; maskedNumber: string };
type Evidence = { signerReference?: string; evidenceReference?: string; acceptedAt?: string; simulated?: boolean };

/**
 * Read-only rendering of one immutable set of agreement terms: enabled services, accounts,
 * fees, limits (each in its own unit, with provenance) and the bank's approval floors.
 */
export async function TermsView({ terms, accounts, evidence }: { terms: AgreementTerms; accounts: AccountInfo[]; evidence?: unknown }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const accountLabel = (id: string) => {
    const account = accounts.find((entry) => entry.id === id);
    return account ? `${locale === "ar" ? account.nameAr : account.name} (${account.maskedNumber})` : id;
  };
  const lyd = (minor: string) => ({ currency: "LYD", minor });
  const signers = Array.isArray(evidence) ? (evidence as Evidence[]) : [];

  return (
    <div className="flex flex-col gap-5" data-testid="terms-view">
      {signers.length > 0 ? (
        <section aria-labelledby="signatories-title">
          <h3 id="signatories-title" className="mb-2 font-semibold">{t("corp.agreement.signatories")}</h3>
          <Callout tone="sandbox" role="note">{t("corp.agreement.simulatedEvidence")}</Callout>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {signers.map((signer, index) => (
              <li key={index}>
                <bdi>{signer.signerReference}</bdi> · {t("corp.agreement.evidenceReference")}: <Code>{signer.evidenceReference}</Code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="corporate-limits-title">
        <h3 id="corporate-limits-title" className="mb-2 font-semibold">{t("corp.agreement.corporateLimits")}</h3>
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {terms.corporateLimits.map((limit) => (
            <li key={limit.period}>
              {t(`types.period.${limit.period}`)}: <Money value={lyd(limit.minor)} className="font-semibold" />{" "}
              <Badge tone={limit.provenance === "BANK_CONFIRMED" ? "success" : "sandbox"}>{t(`types.provenance.${limit.provenance}`)}</Badge>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-muted">
          {t("corp.agreement.userEnvelope")}: <Money value={lyd(terms.userLimitEnvelope.perItemMinor)} /> {t("types.period.ITEM")} · <Money value={lyd(terms.userLimitEnvelope.dailyMinor)} /> {t("types.period.DAY")}
        </p>
      </section>

      <section aria-labelledby="modules-title">
        <h3 id="modules-title" className="mb-2 font-semibold">{t("corp.agreement.modules")}</h3>
        <ul className="flex flex-col gap-3">
          {terms.moduleTerms.map((moduleTerms) => {
            const definition = getModule(moduleTerms.moduleId);
            return (
              <li key={moduleTerms.moduleId} className="rounded-lg border border-border p-3" data-module={moduleTerms.moduleId}>
                <p className="font-semibold">
                  <Code>{moduleTerms.moduleId}</Code> {locale === "ar" ? definition?.nameAr : definition?.name}
                </p>
                {moduleTerms.transactionTypes.length > 0 ? (
                  <p className="mt-1 text-sm">
                    <span className="text-muted">{t("corp.agreement.types")}: </span>
                    {moduleTerms.transactionTypes.map((type) => t(`types.transactionType.${type}`)).join(" · ")}
                  </p>
                ) : null}
                {moduleTerms.debitAccountIds.length > 0 ? (
                  <p className="text-sm">
                    <span className="text-muted">{t("corp.agreement.debitAccounts")}: </span>
                    <bdi>{moduleTerms.debitAccountIds.map(accountLabel).join(" · ")}</bdi>
                  </p>
                ) : null}
                {moduleTerms.creditAccountIds.length > 0 ? (
                  <p className="text-sm">
                    <span className="text-muted">{t("corp.agreement.creditAccounts")}: </span>
                    <bdi>{moduleTerms.creditAccountIds.map(accountLabel).join(" · ")}</bdi>
                  </p>
                ) : null}
                {moduleTerms.rowCap ? <p className="text-sm">{t("corp.agreement.rowCap", { count: moduleTerms.rowCap })}</p> : null}
                {moduleTerms.feeRules.length > 0 ? (
                  <div className="mt-2 text-sm">
                    <span className="text-muted">{t("corp.agreement.fees")}: </span>
                    <ul className="inline-flex flex-wrap gap-x-4">
                      {moduleTerms.feeRules.map((fee) => (
                        <li key={fee.transactionType}>
                          {t(`types.transactionType.${fee.transactionType}`)} — <Money value={lyd(fee.minor)} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {moduleTerms.limits.length > 0 ? (
                  <div className="mt-2 text-sm">
                    <span className="text-muted">{t("corp.agreement.limits")}: </span>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {moduleTerms.limits.map((limit, index) => (
                        <li key={index}>
                          {limit.scope === "TYPE" && limit.transactionType ? `${t(`types.transactionType.${limit.transactionType}`)} · ` : ""}
                          {t(`types.period.${limit.period}`)}:{" "}
                          {limit.metric === "AMOUNT" ? <Money value={lyd(limit.minor)} className="font-semibold" /> : <span className="font-semibold">{t("corp.limits.itemsLimit", { count: limit.count })}</span>}{" "}
                          <Badge tone={limit.provenance === "BANK_CONFIRMED" ? "success" : "sandbox"}>{t(`types.provenance.${limit.provenance}`)}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {moduleTerms.approvalBands.length > 0 ? (
                  <div className="mt-2 text-sm">
                    <span className="text-muted">{t("corp.agreement.bands")}: </span>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {moduleTerms.approvalBands.map((band, index) => (
                        <li key={index}>
                          {t(`types.transactionType.${band.transactionType}`)} ·{" "}
                          <Money value={lyd(band.minMinor)} />
                          {band.maxExclusiveMinor !== null ? <> – &lt; <Money value={lyd(band.maxExclusiveMinor)} /></> : " +"}
                          {" → "}
                          <span className="font-semibold">{t("corp.agreement.bandCheckers", { count: band.checkerCount })}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {terms.depositPolicy ? (
        <section aria-labelledby="deposit-policy-title">
          <h3 id="deposit-policy-title" className="mb-2 font-semibold">{t("corp.agreement.depositPolicy")}</h3>
          <p className="text-sm">
            {t("corp.agreement.managerThreshold")} <Money value={lyd(terms.depositPolicy.managerThresholdMinor)} /> ·{" "}
            {t("corp.agreement.perDepositCap")} <Money value={lyd(terms.depositPolicy.perDepositCapMinor)} />
          </p>
        </section>
      ) : null}
    </div>
  );
}
