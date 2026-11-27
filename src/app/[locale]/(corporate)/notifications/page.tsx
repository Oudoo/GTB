import { getTranslations } from "next-intl/server";
import { CommandButton } from "@/components/command";
import { Badge, Card, CardHeader, Code, EmptyState, LinkButton, Money, PageHeader } from "@/components/ui/primitives";
import { LoadError } from "@/features/common/states";
import { formatDateTime } from "@/lib/format";
import { listAlertRules, listNotifications } from "@/server/domain/alerts/service";
import { can, load, requireCorporatePage } from "@/server/page";

type Loose = ((key: string, values?: Record<string, string | number>) => string) & { has: (key: string) => boolean };

/** The caller's own alerts. Parameters are redacted server-side; nothing here names an employee. */
export default async function NotificationsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ show?: string; cursor?: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  const loose = t as unknown as Loose;
  const query = await searchParams;
  const unreadOnly = query.show === "unread";
  const result = await load(() => listNotifications(deps, ctx, { unread: unreadOnly ? "true" : "false", ...(query.cursor ? { cursor: query.cursor } : {}), limit: 25 }));
  const rules = can(ctx, "alerts.read") ? await load(() => listAlertRules(deps, ctx)) : null;
  const text = (kind: string, values: Record<string, string | number | boolean | null>) => {
    const key = `alerts.kinds.${kind}`;
    const safe = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "string" || typeof value === "number")) as Record<string, string | number>;
    return loose.has(key) ? loose(key, safe) : t("alerts.kinds.other");
  };
  return (
    <>
      <PageHeader
        title={t("alerts.title")}
        description={t("alerts.description")}
        actions={
          <LinkButton href={unreadOnly ? "/notifications" : "/notifications?show=unread"} variant="secondary">
            {unreadOnly ? t("alerts.showAll") : t("alerts.showUnread")}
          </LinkButton>
        }
      />
      <div className="flex flex-col gap-4">
        <Card>
          {!result.ok ? (
            <div className="p-4">
              <LoadError code={result.code} />
            </div>
          ) : result.data.items.length === 0 ? (
            <EmptyState title={t("alerts.empty")} />
          ) : (
            <>
              <p className="border-b border-border px-4 py-3 text-sm text-muted sm:px-5" data-testid="unread-count" data-count={result.data.unreadCount}>
                {t("alerts.unreadCount", { count: result.data.unreadCount })}
              </p>
              <ul className="divide-y divide-border" data-testid="notification-list">
                {result.data.items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-5" data-kind={item.kind} data-read={item.read}>
                    <div className="min-w-0 flex-1">
                      <p className={item.read ? "" : "font-semibold"}>
                        {!item.read ? <Badge tone="info" className="me-2">{t("alerts.new")}</Badge> : null}
                        <bdi>{text(item.kind, item.params)}</bdi>
                      </p>
                      <p className="mt-1 text-sm text-muted">
                        <time dateTime={item.createdAt}>{formatDateTime(item.createdAt, locale, deps.timeZone)}</time>
                      </p>
                    </div>
                    <span className="flex flex-wrap items-center gap-2">
                      {item.linkPath ? (
                        <LinkButton href={item.linkPath} variant="secondary">
                          {t("alerts.open")}
                        </LinkButton>
                      ) : null}
                      {!item.read ? (
                        <CommandButton path={`/notifications/${item.id}/read`} variant="ghost" testId="mark-read">
                          {t("alerts.markRead")}
                        </CommandButton>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {result.data.nextCursor ? (
                <div className="border-t border-border p-4 text-center">
                  <LinkButton href={`/notifications?${unreadOnly ? "show=unread&" : ""}cursor=${result.data.nextCursor}`} variant="secondary">
                    {t("common.actions.loadMore")}
                  </LinkButton>
                </div>
              ) : null}
            </>
          )}
        </Card>
        {rules ? (
          <Card>
            <CardHeader title={t("alerts.rules.title")} description={t("alerts.rules.help")} />
            {rules.ok && rules.data.length > 0 ? (
              <ul className="divide-y divide-border" data-testid="alert-rules">
                {rules.data.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <span>
                      {rule.kind === "LOW_BALANCE" && rule.threshold ? (
                        <>
                          {t.rich("alerts.rules.lowBalance", { amount: () => <Money value={rule.threshold as NonNullable<typeof rule.threshold>} /> })}
                          {rule.account ? (
                            <span className="block text-sm text-muted">
                              {locale === "ar" ? rule.account.nameAr : rule.account.name} · <Code>{rule.account.maskedNumber}</Code>
                            </span>
                          ) : null}
                        </>
                      ) : (
                        t("alerts.rules.limitUsage", { percent: rule.thresholdPercent ?? 0 })
                      )}
                    </span>
                    <Badge tone={rule.active ? "success" : "neutral"}>{rule.active ? t("alerts.rules.active") : t("alerts.rules.inactive")}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t("alerts.rules.empty")} />
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
