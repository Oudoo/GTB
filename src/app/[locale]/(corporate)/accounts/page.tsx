import { getTranslations } from "next-intl/server";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { BalanceCard } from "@/features/accounts/balance-card";
import { Forbidden, LoadError } from "@/features/common/states";
import { listAccounts } from "@/server/domain/accounts/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function AccountsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale, namespace: "corp.accounts" });
  if (!can(ctx, "accounts.read")) return <Forbidden />;
  const accounts = await load(() => listAccounts(deps, ctx));
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      {!accounts.ok ? (
        <LoadError code={accounts.code} />
      ) : accounts.data.length === 0 ? (
        <Card>
          <EmptyState title={t("empty")} description={t("emptyHint")} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.data.map((account) => (
            <BalanceCard key={account.id} account={account} timeZone={deps.timeZone} />
          ))}
        </div>
      )}
    </>
  );
}
