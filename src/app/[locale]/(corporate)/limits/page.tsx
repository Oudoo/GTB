import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, DataList, EmptyState, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { getLimitsUsage, type RailRow, type UsageRow } from "@/server/domain/agreements/usage";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function LimitsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "limits.read")) return <Forbidden />;
  const usage = await load(() => getLimitsUsage(deps, ctx));
  if (!usage.ok) return <LoadError code={usage.code} />;

  const scope = (row: UsageRow) => {
    if (row.level === "USER") return t("types.limitLevelUpper.USER");
    if (row.level === "CORPORATE") return t("types.limitLevelUpper.CORPORATE");
    const parts = [row.moduleId, row.transactionType ? t(`types.transactionType.${row.transactionType}` as Parameters<typeof t>[0]) : null].filter(Boolean);
    return parts.join(" · ");
  };
  const columns: Column<UsageRow>[] = [
    {
      key: "scope",
      header: t("corp.limits.scope"),
      primary: true,
      cell: (row) => (
        <span>
          <bdi>{scope(row)}</bdi>
          <span className="block text-xs text-muted">
            {t(`types.limitLevelUpper.${row.level}`)} · {t(`types.metric.${row.metric}`)} {t(`types.period.${row.period}`)}
          </span>
        </span>
      ),
    },
    {
      key: "limit",
      header: t("corp.limits.limit"),
      numeric: true,
      cell: (row) =>
        row.limit ? <Money value={row.limit} /> : row.itemLimit !== null ? t("corp.limits.itemsLimit", { count: row.itemLimit }) : <span className="text-warning">{t("corp.limits.noAllowance")}</span>,
    },
    {
      key: "consumed",
      header: t("corp.limits.consumed"),
      numeric: true,
      cell: (row) => <span data-usage={`${row.level}:${row.moduleId ?? ""}:${row.period}`}>{row.consumed ? <Money value={row.consumed} /> : "—"}</span>,
    },
    {
      key: "reserved",
      header: t("corp.limits.reserved"),
      numeric: true,
      cell: (row) => <span data-reserved={`${row.level}:${row.moduleId ?? ""}:${row.period}`}>{row.reserved ? <Money value={row.reserved} /> : "—"}</span>,
    },
    { key: "remaining", header: t("corp.limits.remaining"), numeric: true, cell: (row) => (row.remaining ? <Money value={row.remaining} className="font-semibold" /> : "—") },
    {
      key: "provenance",
      header: t("common.labels.status"),
      cell: (row) => (row.provenance ? <Badge tone={row.provenance === "BANK_CONFIRMED" ? "success" : "sandbox"}>{t(`types.provenance.${row.provenance}`)}</Badge> : "—"),
    },
  ];
  const railColumns: Column<RailRow>[] = [
    { key: "rail", header: t("common.labels.rail"), primary: true, cell: (row) => t(`types.rail.${row.rail}` as Parameters<typeof t>[0]) },
    {
      key: "ceiling",
      header: t("corp.limits.ceiling"),
      numeric: true,
      cell: (row) => (row.ceiling ? <Money value={row.ceiling} /> : <span className="font-semibold text-danger">{t("corp.limits.railBlocked")}</span>),
    },
    { key: "window", header: t("corp.limits.period"), cell: (row) => (row.cutoffLocalTime ? <bdi>{t("corp.limits.cutoff", { time: row.cutoffLocalTime })}</bdi> : t("corp.limits.allDay")) },
    {
      key: "provenance",
      header: t("common.labels.status"),
      cell: (row) => (row.provenance ? <Badge tone={row.provenance === "BANK_CONFIRMED" ? "success" : "sandbox"}>{t(`types.provenance.${row.provenance}`)}</Badge> : "—"),
    },
  ];

  return (
    <>
      <PageHeader title={t("corp.limits.title")} description={t("corp.limits.description")} />
      <div className="flex flex-col gap-5">
        {usage.data.state !== "ACTIVE" ? <Callout tone="warning" role="status">{t("corp.limits.noAgreement")}</Callout> : null}
        <Card>
          <CardHeader
            title={t("corp.limits.title")}
            description={t("corp.limits.windows", { day: usage.data.windows.day, month: usage.data.windows.month, zone: usage.data.businessTimeZone })}
          />
          <DataList
            rows={usage.data.rows}
            columns={columns}
            rowKey={(row) => `${row.level}-${row.moduleId}-${row.transactionType}-${row.metric}-${row.period}`}
            caption={t("corp.limits.title")}
            empty={<EmptyState title={t("corp.limits.noAgreement")} />}
          />
        </Card>
        <Card>
          <CardHeader title={t("corp.limits.rails")} description={t("common.sandbox.unconfirmed")} />
          <DataList rows={usage.data.rails} columns={railColumns} rowKey={(row) => row.rail} caption={t("corp.limits.rails")} empty={null} />
        </Card>
      </div>
    </>
  );
}
