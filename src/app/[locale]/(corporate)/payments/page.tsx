import { getTranslations } from "next-intl/server";
import { Field, Input, Select, describe } from "@/components/ui/form";
import { Button, Callout, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { PaymentList } from "@/features/payments/payment-list";
import { listAccounts } from "@/server/domain/accounts/service";
import { listPayments } from "@/server/domain/payments/service";
import { can, load, requireCorporatePage } from "@/server/page";

const STATES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "QUEUED", "PROCESSING", "SUBMITTED", "SETTLED", "STATUS_UNKNOWN", "FAILED", "RETURNED", "REJECTED", "CANCELLED", "EXPIRED"] as const;

type Search = { state?: string; accountId?: string; reference?: string; cursor?: string };

export default async function PaymentsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const search = await searchParams;
  const t = await getTranslations({ locale });
  if (!can(ctx, "payments.read")) return <Forbidden />;

  const state = STATES.find((entry) => entry === search.state);
  const accounts = await load(() => listAccounts(deps, ctx, { withBalances: false }));
  const payments = await load(() =>
    listPayments(deps, ctx, {
      ...(state ? { state } : {}),
      ...(search.accountId ? { accountId: search.accountId } : {}),
      ...(search.reference ? { reference: search.reference } : {}),
      ...(search.cursor ? { cursor: search.cursor } : {}),
      limit: 25,
    }),
  );
  const canCreate = can(ctx, "payments.create");
  const nextHref = (cursor: string) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...search, cursor })) if (value) query.set(key, value);
    return `/payments?${query.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={t("corp.payments.title")}
        description={t("corp.payments.description")}
        actions={
          canCreate ? (
            <LinkButton href="/payments/new" data-testid="new-payment">
              {t("corp.payments.new")}
            </LinkButton>
          ) : undefined
        }
      />
      {!canCreate ? (
        <div className="mb-4">
          <Callout tone="info">{t("corp.payments.noAccess")}</Callout>
        </div>
      ) : null}
      <Card>
        <form method="get" className="grid grid-cols-1 gap-3 border-b border-border px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          <Field id="state" label={t("corp.payments.filterState")}>
            <Select {...describe("state", {})} name="state" defaultValue={state ?? ""}>
              <option value="">{t("common.labels.all")}</option>
              {STATES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`status.payment.${entry}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="accountId" label={t("corp.payments.filterAccount")}>
            <Select {...describe("accountId", {})} name="accountId" defaultValue={search.accountId ?? ""}>
              <option value="">{t("common.labels.all")}</option>
              {accounts.ok
                ? accounts.data.map((account) => (
                    <option key={account.id} value={account.id}>
                      {locale === "ar" ? account.nameAr : account.name} · {account.maskedNumber}
                    </option>
                  ))
                : null}
            </Select>
          </Field>
          <Field id="reference" label={t("corp.payments.filterReference")}>
            <Input {...describe("reference", {})} name="reference" defaultValue={search.reference ?? ""} maxLength={64} dir="ltr" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary" className="w-full">
              {t("common.actions.filter")}
            </Button>
          </div>
        </form>
        {!payments.ok ? (
          <div className="p-4">
            <LoadError code={payments.code} />
          </div>
        ) : (
          <>
            <PaymentList
              payments={payments.data.items}
              timeZone={deps.timeZone}
              empty={<EmptyState title={t("corp.payments.empty")} description={canCreate ? t("corp.payments.emptyHint") : undefined} />}
            />
            {payments.data.nextCursor ? (
              <div className="border-t border-border p-4 text-center">
                <LinkButton href={nextHref(payments.data.nextCursor)} variant="secondary">
                  {t("common.actions.loadMore")}
                </LinkButton>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
