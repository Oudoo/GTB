import { getTranslations } from "next-intl/server";
import { DOMAINS, MODULE_REGISTRY, isDeliveredInR1 } from "@/contracts/modules";
import { Badge, Card, Code, PageHeader } from "@/components/ui/primitives";
import { loadAgreementStatus } from "@/server/domain/agreements/policy";
import { load, requireCorporatePage } from "@/server/page";

/**
 * All 33 catalogue modules in their 12 domains. Release availability (what this sandbox
 * delivers) and agreement enablement (what the bank switched on) are shown SEPARATELY, and a
 * deferred module has no enable button and no fake screen (AGR-03, document 05).
 */
export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  const status = await load(() => loadAgreementStatus(deps.db, ctx.corporateId as string, deps.clock.now()));
  const enabled = new Set(status.ok && status.data.policy ? [...status.data.policy.modules.keys()] : []);

  return (
    <>
      <PageHeader title={t("corp.products.title")} description={t("corp.products.description")} />
      <div className="flex flex-col gap-5">
        {DOMAINS.map((domain) => (
          <section key={domain.no} aria-labelledby={`domain-${domain.no}`}>
            <h2 id={`domain-${domain.no}`} className="mb-2 text-lg">
              <bdi dir="ltr" className="text-muted">{domain.no}.</bdi> {locale === "ar" ? domain.nameAr : domain.name}
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {MODULE_REGISTRY.filter((definition) => definition.domainNo === domain.no).map((definition) => {
                const delivered = isDeliveredInR1(definition);
                return (
                  <Card key={definition.catalogueId} as="article" className="flex flex-col gap-2 p-4" data-module={definition.catalogueId} data-delivery={definition.deliveryStatus}>
                    <h3 className="font-semibold">
                      <Code>{definition.catalogueId}</Code> {locale === "ar" ? definition.nameAr : definition.name}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      <Badge tone={delivered ? "info" : "neutral"}>{t(`status.delivery.${definition.deliveryStatus}`)}</Badge>
                      {delivered ? (
                        <Badge tone={enabled.has(definition.catalogueId) ? "success" : "warning"}>
                          {enabled.has(definition.catalogueId) ? t("corp.products.enabled") : t("corp.products.notEnabled")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted">
                      {delivered
                        ? definition.deliveryStatus === "R1_CORE"
                          ? enabled.has(definition.catalogueId)
                            ? ""
                            : t("corp.agreement.moduleNotEnabled")
                          : t("corp.products.subsetNote")
                        : t("corp.products.deferredNote")}
                    </p>
                    <p className="mt-auto text-xs text-muted">
                      {definition.rails.length > 0 ? <>{t("corp.products.rails")}: <bdi>{definition.rails.join(", ")}</bdi> · </> : null}
                      {t("corp.products.limitBasis")}: <bdi>{definition.limitBasis}</bdi> · {t("corp.products.sourcePages", { pages: definition.sourcePages })}
                    </p>
                  </Card>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
