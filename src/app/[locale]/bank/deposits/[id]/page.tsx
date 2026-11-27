import { getTranslations } from "next-intl/server";
import { Callout, Card, CardHeader, Code, PageHeader } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { DecisionForm } from "@/features/approvals/client/decision-form";
import { DepositDetailView } from "@/features/collections/deposit-views";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { getDeposit } from "@/server/domain/collections/deposits";
import { can, load, requireBankPage } from "@/server/page";

export default async function BranchDepositPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireBankPage(localeParam);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.deposits.read")) return <Forbidden />;
  const result = await load(() => getDeposit(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const deposit = result.data;
  const approval = deposit.approval;
  const backHref = can(ctx, "bank.teller.capture") ? "/bank/teller" : "/bank/branch-approvals";
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {t("teller.detailTitle")} <Code>{deposit.intakeReference}</Code>
            </span>
            <StatusBadge family="deposit" state={deposit.state} />
          </span>
        }
        back={
          <Link href={backHref} className="text-accent hover:underline">
            ← {can(ctx, "bank.teller.capture") ? t("teller.title") : t("teller.queueTitle")}
          </Link>
        }
      />
      <DepositDetailView deposit={deposit} locale={locale} timeZone={deps.timeZone}>
        {approval && approval.state === "PENDING" ? (
          <Card>
            <CardHeader title={t("teller.decision")} />
            <div className="p-4 sm:p-5" data-testid="deposit-decision">
              {approval.canAct ? (
                <DecisionForm approvalId={approval.id} version={approval.version} targetRevision={approval.targetRevision} payloadHash={approval.payloadHash} remainingAfterApprove={Math.max(0, approval.requiredApprovals - approval.approvalsCount - 1)} />
              ) : (
                <Callout tone="info" testId="cannot-decide">
                  <span data-reason={approval.eligibility}>{approval.eligibility === "OWN_PROPOSAL" ? t("teller.ownIntake") : t("teller.notManager")}</span>
                </Callout>
              )}
            </div>
          </Card>
        ) : null}
      </DepositDetailView>
    </>
  );
}
