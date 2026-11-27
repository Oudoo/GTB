import { getTranslations } from "next-intl/server";
import { Callout, Card, CardHeader, Code, EmptyState, PageHeader } from "@/components/ui/primitives";
import { DepositList } from "@/features/collections/deposit-views";
import { Forbidden, LoadError } from "@/features/common/states";
import { TellerCaptureForm } from "@/features/teller/client/teller-forms";
import { listBranchDeposits, listTellerCorporates } from "@/server/domain/collections/deposits";
import { can, load, requireBankPage } from "@/server/page";

export default async function TellerPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.teller.capture")) return <Forbidden />;
  if (ctx.branchId === null) return <Callout tone="warning">{t("teller.noBranch")}</Callout>;
  const [corporates, recent, branch] = await Promise.all([
    load(() => listTellerCorporates(deps, ctx)),
    load(() => listBranchDeposits(deps, ctx, { limit: 15 })),
    deps.db.branch.findFirst({ where: { id: ctx.branchId, bankId: ctx.bankId }, select: { code: true, name: true, nameAr: true } }),
  ]);
  return (
    <>
      <PageHeader
        title={t("teller.title")}
        description={
          <span>
            {t("teller.description")}{" "}
            {branch ? (
              <span className="mt-1 block font-semibold text-ink" data-testid="teller-branch">
                {t("teller.branch")}: <Code>{branch.code}</Code> {locale === "ar" ? branch.nameAr : branch.name}
              </span>
            ) : null}
          </span>
        }
      />
      <div className="flex flex-col gap-4">
        <Card>
          <div className="p-4 sm:p-5">{corporates.ok ? <TellerCaptureForm corporates={corporates.data} branchId={ctx.branchId} locale={locale} /> : <LoadError code={corporates.code} />}</div>
        </Card>
        <Card>
          <CardHeader title={t("teller.recent")} />
          {recent.ok ? (
            <div data-testid="branch-deposits">
              <DepositList deposits={recent.data.items} locale={locale} timeZone={deps.timeZone} hrefBase="/bank/deposits" audience="BANK" empty={<EmptyState title={t("teller.recentEmpty")} />} />
            </div>
          ) : (
            <div className="p-4">
              <LoadError code={recent.code} />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
