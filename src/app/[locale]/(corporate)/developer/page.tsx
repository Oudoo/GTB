import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, DataList, EmptyState, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { Forbidden, LoadError } from "@/features/common/states";
import { CredentialCreateForm, DisableWebhookButton, RevokeCredentialButton, WebhookCreateForm } from "@/features/developer/client/developer-forms";
import { formatDateTime } from "@/lib/format";
import { listDeliveries, listCredentials, listWebhooks, type CredentialView, type DeliveryView, type WebhookView } from "@/server/domain/developer/service";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function DeveloperPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "developer.read")) return <Forbidden />;
  const mayManage = can(ctx, "developer.manage");
  const [credentials, webhooks, linked] = await Promise.all([
    load(() => listCredentials(deps, ctx)),
    load(() => listWebhooks(deps, ctx)),
    deps.db.account.findMany({ where: { corporateId: ctx.corporateId as string, status: "ACTIVE" }, select: { id: true, name: true, nameAr: true, maskedNumber: true }, orderBy: { name: "asc" } }),
  ]);
  const logs = webhooks.ok ? await Promise.all(webhooks.data.slice(0, 5).map(async (webhook) => ({ webhook, deliveries: await load(() => listDeliveries(deps, ctx, webhook.id, 10)) }))) : [];
  const time = (iso: string | null) => (iso ? <time dateTime={iso}>{formatDateTime(iso, locale, deps.timeZone)}</time> : t("developer.credentials.never"));

  const credentialColumns: Column<CredentialView>[] = [
    { key: "name", header: t("developer.credentials.name"), primary: true, cell: (credential) => <bdi>{credential.name}</bdi> },
    { key: "prefix", header: t("developer.credentials.prefix"), cell: (credential) => <Code>aqsb_{credential.tokenPrefix}_…</Code> },
    { key: "scopes", header: t("developer.credentials.scopes"), cell: (credential) => <span className="flex flex-wrap gap-1">{credential.scopes.map((scope) => <Badge key={scope}>{scope}</Badge>)}</span> },
    { key: "accounts", header: t("developer.credentials.accounts"), cell: (credential) => credential.accounts.map((account) => account.maskedNumber).join(", ") || "—" },
    { key: "state", header: t("developer.credentials.state"), cell: (credential) => <span data-state={credential.state}><Badge tone={credential.state === "ACTIVE" ? "success" : "neutral"}>{t(`developer.credentials.states.${credential.state}`)}</Badge></span> },
    { key: "expires", header: t("developer.credentials.expires"), cell: (credential) => time(credential.expiresAt) },
    { key: "lastUsed", header: t("developer.credentials.lastUsed"), cell: (credential) => time(credential.lastUsedAt) },
  ];
  const webhookColumns: Column<WebhookView>[] = [
    { key: "url", header: t("developer.webhooks.url"), primary: true, cell: (webhook) => <Code>{webhook.url}</Code> },
    { key: "events", header: t("developer.webhooks.events"), cell: (webhook) => <span className="flex flex-wrap gap-1">{webhook.events.map((event) => <Badge key={event}>{event}</Badge>)}</span> },
    { key: "state", header: t("developer.webhooks.state"), cell: (webhook) => <Badge tone={webhook.active ? "success" : "neutral"}>{webhook.active ? t("developer.webhooks.active") : t("developer.webhooks.disabled")}</Badge> },
    { key: "deliveries", header: t("developer.webhooks.deliveries"), cell: (webhook) => t("developer.webhooks.deliveryCounts", webhook.deliveries) },
  ];
  const deliveryColumns: Column<DeliveryView>[] = [
    { key: "event", header: t("developer.webhooks.logEvent"), primary: true, cell: (delivery) => <Code>{delivery.eventType}</Code> },
    { key: "state", header: t("developer.webhooks.logState"), cell: (delivery) => <StatusBadge family="webhookDelivery" state={delivery.state} /> },
    { key: "attempts", header: t("developer.webhooks.logAttempts"), numeric: true, cell: (delivery) => delivery.attempts },
    { key: "code", header: t("developer.webhooks.logCode"), cell: (delivery) => (delivery.lastErrorCode ? <Code>{delivery.lastErrorCode}</Code> : delivery.lastStatusCode ? <Code>HTTP {delivery.lastStatusCode}</Code> : "—") },
  ];

  return (
    <>
      <PageHeader title={t("developer.title")} description={t("developer.description")} />
      <div className="flex flex-col gap-4">
        <Callout tone="sandbox" role="note">
          {t("common.sandbox.explain")}{" "}
          <a className="font-semibold underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer" data-testid="openapi-link">
            {t("developer.openapi")}
          </a>{" "}
          — {t("developer.openapiHelp")}
        </Callout>
        {!mayManage ? <Callout tone="info">{t("developer.readOnly")}</Callout> : null}

        <Card>
          <CardHeader title={t("developer.credentials.title")} description={t("developer.credentials.help")} />
          {credentials.ok ? (
            <div data-testid="credential-list">
              <DataList
                rows={credentials.data}
                columns={credentialColumns}
                rowKey={(credential) => credential.id}
                caption={t("developer.credentials.caption")}
                empty={<EmptyState title={t("developer.credentials.empty")} />}
                action={(credential) => (mayManage && credential.state === "ACTIVE" ? <RevokeCredentialButton credentialId={credential.id} label={t("developer.credentials.revoke")} /> : null)}
              />
            </div>
          ) : (
            <div className="p-4">
              <LoadError code={credentials.code} />
            </div>
          )}
        </Card>
        {mayManage ? (
          <Card>
            <CardHeader title={t("developer.credentials.createTitle")} />
            <div className="p-4 sm:p-5">
              <CredentialCreateForm accounts={linked.map((account) => ({ id: account.id, label: `${locale === "ar" ? account.nameAr : account.name} · ${account.maskedNumber}` }))} />
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title={t("developer.webhooks.title")} description={t("developer.webhooks.help")} />
          {webhooks.ok ? (
            <div data-testid="webhook-list">
              <DataList
                rows={webhooks.data}
                columns={webhookColumns}
                rowKey={(webhook) => webhook.id}
                caption={t("developer.webhooks.caption")}
                empty={<EmptyState title={t("developer.webhooks.empty")} />}
                action={(webhook) => (mayManage && webhook.active ? <DisableWebhookButton webhookId={webhook.id} version={webhook.version} label={t("developer.webhooks.disable")} /> : null)}
              />
            </div>
          ) : (
            <div className="p-4">
              <LoadError code={webhooks.code} />
            </div>
          )}
        </Card>
        {mayManage ? (
          <Card>
            <CardHeader title={t("developer.webhooks.createTitle")} />
            <div className="flex flex-col gap-4 p-4 sm:p-5">
              <WebhookCreateForm />
              <Callout tone="info">{t("developer.webhooks.deferred")}</Callout>
            </div>
          </Card>
        ) : null}
        {logs.map(({ webhook, deliveries }) => (
          <Card key={webhook.id}>
            <CardHeader title={t("developer.webhooks.log")} description={<Code>{webhook.url}</Code>} />
            {deliveries.ok ? (
              <DataList rows={deliveries.data} columns={deliveryColumns} rowKey={(delivery) => delivery.id} caption={t("developer.webhooks.log")} empty={<EmptyState title={t("developer.webhooks.logEmpty")} />} />
            ) : (
              <div className="p-4">
                <LoadError code={deliveries.code} />
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
