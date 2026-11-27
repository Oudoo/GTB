import { getTranslations } from "next-intl/server";
import { Callout, Card, CardHeader, EmptyState, LinkButton, Money, PageHeader } from "@/components/ui/primitives";
import { BalanceCard } from "@/features/accounts/balance-card";
import { ApprovalSummaryLine } from "@/features/approvals/approval-summary";
import { LoadError } from "@/features/common/states";
import { PaymentList } from "@/features/payments/payment-list";
import { Link } from "@/i18n/navigation";
import { getDashboard } from "@/server/domain/dashboard/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const page = await requireCorporatePage((await params).locale);
  const { deps, ctx, session, locale } = page;
  const t = await getTranslations({ locale });
  const result = await load(() => getDashboard(deps, ctx));
  const name = locale === "ar" ? (session.person.nameAr ?? session.person.name) : session.person.name;

  return (
    <>
      <PageHeader
        title={t("corp.dashboard.greeting", { name })}
        actions={
          can(ctx, "payments.create") ? (
            <LinkButton href="/payments/new" data-testid="new-payment">
              {t("corp.dashboard.newPayment")}
            </LinkButton>
          ) : undefined
        }
      />
      {!result.ok ? (
        <LoadError code={result.code} />
      ) : (
        <div className="flex flex-col gap-5">
          {result.data.agreementState !== "ACTIVE" ? (
            <Callout tone="warning" role="status" testId="agreement-warning">
              {result.data.agreementState === "SUSPENDED" ? t("corp.dashboard.agreementSuspended") : t("corp.dashboard.agreementInactive")}
            </Callout>
          ) : null}

          {result.data.accounts !== null ? (
            <section aria-labelledby="cash-title">
              <h2 id="cash-title" className="mb-3 text-lg">
                {t("corp.dashboard.cash")}
              </h2>
              {result.data.accounts.length === 0 ? (
                <Card>
                  <EmptyState title={t("corp.dashboard.cashEmpty")} description={t("corp.accounts.emptyHint")} />
                </Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {result.data.accounts.map((account) => (
                    <BalanceCard key={account.id} account={account} timeZone={deps.timeZone} />
                  ))}
                </div>
              )}
            </section>
          ) : null}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader
                title={t("corp.dashboard.pendingApprovals")}
                action={
                  <Link href="/approvals" className="text-sm font-semibold text-accent hover:underline">
                    {t("corp.dashboard.reviewQueue")}
                  </Link>
                }
              />
              {result.data.approvals && result.data.approvals.actionable.length > 0 ? (
                <ul className="divide-y divide-border">
                  {result.data.approvals.actionable.map((approval) => (
                    <li key={approval.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                      <div className="min-w-0">
                        <ApprovalSummaryLine approval={approval} />
                      </div>
                      <div className="flex items-center gap-3">
                        {approval.amount ? <Money value={approval.amount} className="font-semibold" /> : null}
                        <LinkButton href={`/approvals/${approval.id}`} variant="secondary">
                          {t("corp.approvals.review")}
                        </LinkButton>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title={t("corp.dashboard.noPending")} />
              )}
            </Card>

            {result.data.attention !== null ? (
              <Card>
                <CardHeader title={t("corp.dashboard.attention")} />
                <PaymentList payments={result.data.attention} timeZone={deps.timeZone} empty={<EmptyState title={t("corp.dashboard.noAttention")} />} />
              </Card>
            ) : null}
          </div>

          {result.data.scheduled !== null ? (
            <Card>
              <CardHeader title={t("corp.dashboard.upcoming")} />
              <PaymentList payments={result.data.scheduled} timeZone={deps.timeZone} empty={<EmptyState title={t("corp.dashboard.noUpcoming")} />} />
            </Card>
          ) : null}

          {result.data.recent !== null ? (
            <Card>
              <CardHeader
                title={t("corp.dashboard.recent")}
                action={
                  <Link href="/payments" className="text-sm font-semibold text-accent hover:underline">
                    {t("corp.dashboard.viewAll")}
                  </Link>
                }
              />
              <PaymentList payments={result.data.recent} timeZone={deps.timeZone} empty={<EmptyState title={t("corp.dashboard.noRecent")} />} />
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
