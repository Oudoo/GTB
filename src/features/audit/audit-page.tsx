import { getTranslations } from "next-intl/server";
import { Field, Input, Select, describe } from "@/components/ui/form";
import { Badge, Button, Card, Code, DataList, EmptyState, LinkButton, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { auditQuerySchema, listAuditEvents, type AuditEventView, type AuditQuery } from "@/server/domain/audit/service";
import { can, load, type WorkspacePage } from "@/server/page";

const GROUPS = ["payment", "approval", "beneficiary", "agreement", "rail", "session"] as const;
const MINOR_KEY = /(^|\.)([A-Za-z]*Minor)$/;
const DIGITS = /^(0|[1-9][0-9]{0,15})$/;

type RawParams = Record<string, string | string[] | undefined>;

function flatten(value: unknown, prefix: string, out: Array<[string, string]>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    out.push([prefix, value.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item))).join(", ")]);
    return;
  }
  if (typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  out.push([prefix, String(value)]);
}

/** Where the record an event refers to can be opened by this reader, if anywhere. */
function targetHref(event: AuditEventView, bank: boolean): string | null {
  if (!event.target.id) return null;
  if (!bank && event.target.type === "payment") return `/payments/${event.target.id}`;
  if (bank && event.target.type === "agreementVersion") return `/bank/agreement-versions/${event.target.id}`;
  return null;
}

/**
 * Audit trail search shared by the corporate and bank workspaces. Filters are plain GET
 * parameters handled on the server: scope comes from the session, never from the query.
 */
export async function AuditTrail({ page, basePath, searchParams }: { page: WorkspacePage; basePath: string; searchParams: RawParams }) {
  const { deps, ctx, locale } = page;
  const t = await getTranslations({ locale });
  const bank = ctx.workspace === "BANK";
  if (!can(ctx, bank ? "bank.audit.read" : "audit.read")) return <Forbidden />;

  const single = Object.fromEntries(
    Object.entries(searchParams)
      .map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
      .filter(([, value]) => typeof value === "string" && value !== ""),
  );
  const parsed = auditQuerySchema.safeParse(single);
  // An unusable filter is ignored rather than widening or failing the page.
  const query: AuditQuery = parsed.success ? parsed.data : {};
  const result = await load(() => listAuditEvents(deps, ctx, { ...query, limit: 50 }));
  if (!result.ok) return <LoadError code={result.code} />;
  const { items, nextCursor } = result.data;

  const label = (prefix: string, key: string) => {
    const full = `audit.${prefix}.${key}` as Parameters<typeof t>[0];
    return t.has(full) ? t(full) : null;
  };
  const actionText = (action: string) => label("actions", action) ?? action;
  const actorText = (event: AuditEventView) => {
    if (event.actor.kind === "SERVICE") return label("service", event.actor.name ?? "") ?? t("audit.actor.SERVICE");
    if (event.actor.kind === "BANK") return t("audit.actor.BANK");
    return event.actor.name ?? t(`audit.actor.${event.actor.kind}`);
  };

  const columns: Column<AuditEventView>[] = [
    {
      key: "what",
      header: t("audit.what"),
      primary: true,
      cell: (event) => (
        <span data-action={event.action}>
          {actionText(event.action)}
          {event.sensitiveRead ? <Badge tone="warning" className="ms-2">{t("audit.sensitive")}</Badge> : null}
        </span>
      ),
    },
    { key: "when", header: t("audit.when"), cell: (event) => <time dateTime={event.at}>{formatDateTime(event.at, locale, deps.timeZone)}</time> },
    {
      key: "who",
      header: t("audit.who"),
      cell: (event) => (
        <>
          <bdi>{actorText(event)}</bdi>
          {bank && event.corporate ? <span className="block text-sm text-muted"><bdi>{locale === "ar" ? event.corporate.nameAr : event.corporate.name}</bdi></span> : null}
        </>
      ),
    },
    {
      key: "target",
      header: t("audit.target"),
      cell: (event) => {
        const href = targetHref(event, bank);
        const name = label("targets", event.target.type) ?? event.target.type;
        const reference = event.target.label ? <Code>{event.target.label}</Code> : null;
        return (
          <span data-target={event.target.id ?? ""}>
            {name} {href && reference ? <Link href={href} className="text-accent hover:underline">{reference}</Link> : reference}
            {event.proposalRevision !== null ? <span className="block text-sm text-muted">{t("audit.revision", { revision: event.proposalRevision })}</span> : null}
          </span>
        );
      },
    },
    {
      key: "changes",
      header: t("audit.changes"),
      cell: (event) => {
        const pairs: Array<[string, string]> = [];
        flatten(event.changes, "", pairs);
        if (pairs.length === 0 && !event.reason) return <span className="text-muted">—</span>;
        return (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-start text-sm">
            {event.reason ? (
              <>
                <dt className="text-muted">{t("common.labels.reason")}</dt>
                <dd><bdi>{event.reason}</bdi></dd>
              </>
            ) : null}
            {pairs.slice(0, 8).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted">{label("fields", key) ?? <Code className="text-xs">{key}</Code>}</dt>
                <dd className="min-w-0 break-words" data-field={key}>
                  {MINOR_KEY.test(key) && DIGITS.test(value) && key !== "perItemMinor" ? <Money value={{ currency: "LYD", minor: value }} /> : <Code className="text-xs">{value}</Code>}
                </dd>
              </div>
            ))}
          </dl>
        );
      },
    },
    {
      key: "result",
      header: t("audit.result"),
      cell: (event) => (
        <span data-result={event.result}>
          <Badge tone={event.result === "SUCCESS" ? "neutral" : event.result === "DENIED" ? "warning" : "danger"}>{t(`audit.results.${event.result}`)}</Badge>
          {event.correlationId ? <Code className="mt-1 block text-[0.7rem] text-muted">{event.correlationId}</Code> : null}
        </span>
      ),
    },
  ];

  const carry = new URLSearchParams();
  for (const key of ["q", "action", "result", "fromDate", "toDate", "corporateId"] as const) {
    const value = query[key];
    if (value) carry.set(key, value);
  }
  const older = new URLSearchParams(carry);
  if (nextCursor) older.set("cursor", nextCursor);

  return (
    <>
      <PageHeader title={t("audit.title")} description={bank ? t("audit.bankDescription") : t("audit.description")} />
      <div className="flex flex-col gap-5">
        <Card className="p-4 sm:p-5">
          {/* A plain GET form: works without client script and is never cached for offline use. */}
          <form method="get" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="audit-filters">
            <Field id="q" label={t("audit.search")} hint={t("audit.searchHint")} className="sm:col-span-2 lg:col-span-2">
              <Input {...describe("q", { hint: true })} name="q" defaultValue={query.q ?? ""} maxLength={80} dir="ltr" autoComplete="off" />
            </Field>
            <Field id="action" label={t("audit.actionFilter")}>
              <Select {...describe("action", {})} name="action" defaultValue={query.action ?? ""}>
                <option value="">{t("audit.anyAction")}</option>
                {GROUPS.map((group) => (
                  <option key={group} value={`${group}.`}>{t(`audit.groups.${group}`)}</option>
                ))}
              </Select>
            </Field>
            <Field id="fromDate" label={t("audit.fromDate")}>
              <Input {...describe("fromDate", {})} name="fromDate" type="date" defaultValue={query.fromDate ?? ""} />
            </Field>
            <Field id="toDate" label={t("audit.toDate")}>
              <Input {...describe("toDate", {})} name="toDate" type="date" defaultValue={query.toDate ?? ""} />
            </Field>
            <Field id="result" label={t("audit.resultFilter")}>
              <Select {...describe("result", {})} name="result" defaultValue={query.result ?? ""}>
                <option value="">{t("audit.anyResult")}</option>
                {(["SUCCESS", "DENIED", "FAILED"] as const).map((entry) => (
                  <option key={entry} value={entry}>{t(`audit.results.${entry}`)}</option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
              <Button type="submit" data-testid="audit-search">{t("audit.apply")}</Button>
              <LinkButton variant="secondary" href={basePath}>{t("audit.reset")}</LinkButton>
            </div>
          </form>
        </Card>

        <Card data-testid="audit-events" data-count={items.length}>
          <DataList rows={items} columns={columns} rowKey={(event) => event.id} caption={t("audit.title")} empty={<EmptyState title={t("audit.empty")} />} />
        </Card>

        {nextCursor ? (
          <div>
            <LinkButton variant="secondary" href={`${basePath}?${older.toString()}`} data-testid="audit-older">
              {t("audit.older")}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </>
  );
}
