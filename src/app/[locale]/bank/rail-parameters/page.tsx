import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, DataList, DetailList, EmptyState, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { RailParameterForm } from "@/features/agreement/client/rail-parameter-form";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { businessDateOf, localTimeOf } from "@/lib/calendar";
import { formatDate, formatDateTime } from "@/lib/format";
import { listRailParameters, type RailParameterView } from "@/server/domain/agreements/rails";
import { can, load, requireBankPage } from "@/server/page";

const RAILS = ["LYPAY", "ACH", "INTERNAL", "BRANCH"] as const;

export default async function RailParametersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.rail.read")) return <Forbidden />;
  const result = await load(() => listRailParameters(deps, ctx));
  if (!result.ok) return <LoadError code={result.code} />;
  const { parameters, calendars } = result.data;
  const inForce = new Map(parameters.filter((parameter) => parameter.current).map((parameter) => [parameter.rail, parameter]));
  const now = deps.clock.now();
  const railName = (rail: string) => t(`types.rail.${rail}` as Parameters<typeof t>[0]);
  const provenanceBadge = (provenance: string) => (
    <Badge tone={provenance === "BANK_CONFIRMED" ? "success" : "sandbox"}>{t(`types.provenance.${provenance}` as Parameters<typeof t>[0])}</Badge>
  );

  const history: Column<RailParameterView>[] = [
    {
      key: "rail",
      header: t("bank.rails.rail"),
      primary: true,
      cell: (row) => (
        <>
          {railName(row.rail)} · {t("corp.agreement.version", { version: row.versionNo })}
        </>
      ),
    },
    {
      key: "ceiling",
      header: t("bank.rails.ceiling"),
      numeric: true,
      cell: (row) => (row.ceiling ? <Money value={row.ceiling} /> : <span className="text-warning">{t("bank.rails.notConfigured")}</span>),
    },
    { key: "from", header: t("bank.rails.effectiveFrom"), cell: (row) => formatDateTime(row.effectiveFrom, locale, deps.timeZone) },
    { key: "by", header: t("common.labels.createdBy"), cell: (row) => row.proposedBy },
    { key: "reason", header: t("common.labels.reason"), cell: (row) => <bdi>{row.changeReason}</bdi> },
    {
      key: "status",
      header: t("common.labels.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge family="governance" state={row.current ? "EFFECTIVE" : row.status} />
          {row.status === "PENDING_APPROVAL" && row.approvalRequestId ? (
            <Link href={`/bank/approvals/${row.approvalRequestId}`} className="text-sm font-semibold text-accent hover:underline">
              {t("common.actions.view")}
            </Link>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t("bank.rails.title")} description={t("bank.rails.description")} />
      <div className="flex flex-col gap-5">
        <Callout tone="sandbox" role="note">{t("common.sandbox.unconfirmed")}</Callout>

        <Card>
          <CardHeader title={t("bank.rails.current")} description={t("common.labels.bankTime", { zone: deps.timeZone })} />
          <ul className="divide-y divide-border" data-testid="rails-in-force">
            {RAILS.map((rail) => {
              const parameter = inForce.get(rail);
              return (
                <li key={rail} className="p-4 sm:p-5" data-rail={rail} data-configured={Boolean(parameter?.ceiling)}>
                  <p className="mb-3 flex flex-wrap items-center gap-2 font-semibold">
                    {railName(rail)}
                    {parameter ? provenanceBadge(parameter.provenance) : null}
                  </p>
                  {parameter ? (
                    <DetailList
                      items={[
                        {
                          label: t("bank.rails.ceiling"),
                          testId: `rail-ceiling-${rail}`,
                          value: parameter.ceiling ? <Money value={parameter.ceiling} className="font-semibold" /> : <span className="font-semibold text-warning">{t("bank.rails.notConfigured")}</span>,
                        },
                        { label: t("bank.rails.effectiveFrom"), value: formatDateTime(parameter.effectiveFrom, locale, deps.timeZone) },
                        { label: t("bank.rails.open"), value: <bdi dir="ltr">{parameter.openLocalTime ?? "—"}</bdi> },
                        { label: t("bank.rails.cutoff"), value: <bdi dir="ltr">{parameter.cutoffLocalTime ?? "—"}</bdi> },
                        { label: t("bank.rails.closedDays"), value: parameter.observesClosedDays ? t("common.actions.yes") : t("common.actions.no") },
                        {
                          label: `${t("bank.rails.offlineStart")} → ${t("bank.rails.offlineEnd")}`,
                          value: <bdi dir="ltr">{parameter.offlineStartLocalTime ? `${parameter.offlineStartLocalTime} – ${parameter.offlineEndLocalTime}` : "—"}</bdi>,
                        },
                        { label: t("bank.rails.settlementDelay"), value: <bdi dir="ltr">{parameter.settlementDelaySeconds}</bdi> },
                      ]}
                    />
                  ) : (
                    <p className="font-semibold text-warning">{t("bank.rails.notConfigured")}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <CardHeader title={t("bank.rails.calendarTitle")} />
          {calendars.length === 0 ? (
            <EmptyState title={t("common.states.empty")} />
          ) : (
            <ul className="divide-y divide-border">
              {calendars.map((calendar) => (
                <li key={calendar.id} className="p-4 sm:p-5">
                  <p className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
                    <bdi>{calendar.name}</bdi> {provenanceBadge(calendar.provenance)}
                  </p>
                  <p className="text-sm">
                    <span className="text-muted">{t("bank.rails.weekend")}: </span>
                    {calendar.weekendDays.map((day) => t(`bank.rails.weekday.${day}` as Parameters<typeof t>[0])).join(" · ") || "—"}
                  </p>
                  <p className="text-sm">
                    <span className="text-muted">{t("bank.rails.closedDates")}: </span>
                    {calendar.closedDays.length === 0
                      ? "—"
                      : calendar.closedDays.map((day) => `${formatDate(day.date, locale, deps.timeZone)} (${day.label})`).join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={t("bank.rails.propose")} />
          <div className="p-4 sm:p-5">
            {can(ctx, "bank.rail.propose") ? (
              <RailParameterForm
                current={RAILS.flatMap((rail) => {
                  const parameter = inForce.get(rail);
                  return parameter
                    ? [
                        {
                          rail,
                          ceilingMinor: parameter.ceiling?.minor ?? null,
                          provenance: parameter.provenance,
                          calendarId: parameter.calendarId,
                          openLocalTime: parameter.openLocalTime,
                          cutoffLocalTime: parameter.cutoffLocalTime,
                          observesClosedDays: parameter.observesClosedDays,
                          offlineStartLocalTime: parameter.offlineStartLocalTime,
                          offlineEndLocalTime: parameter.offlineEndLocalTime,
                          settlementDelaySeconds: parameter.settlementDelaySeconds,
                        },
                      ]
                    : [];
                })}
                calendars={calendars.map((calendar) => ({ id: calendar.id, name: calendar.name }))}
                timeZone={deps.timeZone}
                defaultFrom={`${businessDateOf(now, deps.timeZone)}T${localTimeOf(now, deps.timeZone)}`}
              />
            ) : (
              <Callout tone="neutral" role="note">{t("bank.rails.cannotPropose")}</Callout>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={t("bank.rails.history")} />
          <DataList rows={parameters} columns={history} rowKey={(row) => row.id} caption={t("bank.rails.history")} empty={<EmptyState title={t("common.states.empty")} />} />
        </Card>
      </div>
    </>
  );
}
