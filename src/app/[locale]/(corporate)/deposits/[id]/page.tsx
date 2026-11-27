import { getTranslations } from "next-intl/server";
import { Code, PageHeader } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { DepositDetailView } from "@/features/collections/deposit-views";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { getDeposit } from "@/server/domain/collections/deposits";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function DepositPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireCorporatePage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "deposits.read")) return <Forbidden />;
  const result = await load(() => getDeposit(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {t("collections.deposits.detailTitle")} <Code>{result.data.intakeReference}</Code>
            </span>
            <StatusBadge family="deposit" state={result.data.state} />
          </span>
        }
        back={
          <Link href="/deposits" className="text-accent hover:underline">
            ← {t("collections.deposits.title")}
          </Link>
        }
      />
      <DepositDetailView deposit={result.data} locale={locale} timeZone={deps.timeZone} />
    </>
  );
}
