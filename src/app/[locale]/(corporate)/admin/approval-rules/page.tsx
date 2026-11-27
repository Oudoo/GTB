import { getTranslations } from "next-intl/server";
import { Callout, Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/features/common/states";
import { can, requireCorporatePage } from "@/server/page";

/** Corporate-side approval rules are a documented gap of this release: shown as unavailable, not hidden. */
export default async function ApprovalRulesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "admin.users.read")) return <Forbidden />;
  return (
    <>
      <PageHeader title={t("admin.rules.title")} />
      <Card>
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <Callout tone="warning" title={t("admin.rules.unavailable")} testId="unavailable">
            {t("admin.rules.body")}
          </Callout>
          {can(ctx, "agreement.read") ? (
            <div>
              <LinkButton href="/agreement" variant="secondary">
                {t("admin.rules.viewAgreement")}
              </LinkButton>
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}
