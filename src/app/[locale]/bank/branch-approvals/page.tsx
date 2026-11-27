import { getTranslations } from "next-intl/server";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { DepositList } from "@/features/collections/deposit-views";
import { Forbidden, LoadError } from "@/features/common/states";
import { listBranchDeposits } from "@/server/domain/collections/deposits";
import { can, load, requireBankPage } from "@/server/page";

/** Manager queue: deposits of the manager's own branch that wait for a decision. */
export default async function BranchApprovalsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.deposits.read")) return <Forbidden />;
  const result = await load(() => listBranchDeposits(deps, ctx, { state: "PENDING_MANAGER", limit: 100 }));
  return (
    <>
      <PageHeader title={t("teller.queueTitle")} description={t("teller.queueDescription")} />
      <Card>
        {result.ok ? (
          <div data-testid="branch-queue">
            <DepositList deposits={result.data.items} locale={locale} timeZone={deps.timeZone} hrefBase="/bank/deposits" audience="BANK" empty={<EmptyState title={t("teller.queueEmpty")} />} />
          </div>
        ) : (
          <div className="p-4">
            <LoadError code={result.code} />
          </div>
        )}
      </Card>
    </>
  );
}
