import { getLocale, getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/ui/status";
import { Callout, Card, Code, Money } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import type { AccountView } from "@/server/domain/accounts/service";

/**
 * One account with booked, available and held amounts shown separately and an as-of time.
 * If the core did not answer there is NO figure at all — never a zero (document 05).
 */
export async function BalanceCard({ account, timeZone, link = true }: { account: AccountView; timeZone: string; link?: boolean }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const name = locale === "ar" ? account.nameAr : account.name;
  return (
    <Card as="article" className="flex flex-col gap-3 p-4" data-testid={`account-${account.kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">
            {link ? (
              <Link href={`/accounts/${account.id}`} className="hover:underline">
                {name}
              </Link>
            ) : (
              name
            )}
          </h3>
          <p className="text-sm text-muted">
            <Code>{account.maskedNumber}</Code> · {t(`types.accountKind.${account.kind}` as Parameters<typeof t>[0])}
          </p>
        </div>
        {account.status !== "ACTIVE" ? <StatusBadge family="account" state={account.status} /> : null}
      </div>
      {account.balance ? (
        <>
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.available")}</p>
            <p className="text-2xl font-semibold" data-testid="available">
              <Money value={account.balance.available} />
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted">{t("common.labels.booked")}</dt>
              <dd data-testid="booked">
                <Money value={account.balance.booked} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t("common.labels.holds")}</dt>
              <dd data-testid="holds">
                <Money value={account.balance.holds} />
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted">
            {t("common.labels.asOf", { time: formatDateTime(account.balance.asOf, locale, timeZone) })} · {t("common.labels.bankTime", { zone: timeZone })}
          </p>
        </>
      ) : (
        <Callout tone="warning" role="status" testId="balance-unavailable">
          {t("common.states.coreUnavailable")}
        </Callout>
      )}
    </Card>
  );
}
