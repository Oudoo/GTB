"use client";

/**
 * Developer forms (S9). A new token or signing secret is shown ONCE, from the response of the
 * request that created it; it is kept only in this component's memory and disappears on
 * navigation or reload. Nothing here is written to browser storage.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CommandButton, ProblemAlert, useCommand } from "@/components/command";
import { Checkbox, Field, FormActions, Input, describe } from "@/components/ui/form";
import { Button, Callout, Code } from "@/components/ui/primitives";

const SCOPES = ["accounts:read", "payments:read", "payments:write", "batches:read", "collections:read", "agreements:read", "webhooks:manage"] as const;
const EVENTS = ["payment.status_changed", "batch.finished", "deposit.posted", "limit.threshold_reached"] as const;

function toggle<T>(set: ReadonlySet<T>, value: T, on: boolean): Set<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

function ShownOnce({ title, help, value, testId }: { title: string; help: string; value: string; testId: string }) {
  return (
    <Callout tone="warning" role="status" title={title} testId={testId}>
      <p>{help}</p>
      <p className="mt-2 rounded-lg bg-surface p-2">
        <Code>{value}</Code>
      </p>
    </Callout>
  );
}

export function CredentialCreateForm({ accounts }: { accounts: Array<{ id: string; label: string }> }) {
  const t = useTranslations("developer.credentials");
  const common = useTranslations("common");
  const command = useCommand();
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [scopes, setScopes] = useState<ReadonlySet<string>>(new Set(["accounts:read"]));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [token, setToken] = useState<string | null>(null);
  const expiresInDays = Number.parseInt(days, 10);
  const valid = name.trim().length >= 3 && scopes.size > 0 && Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 90;
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="credential-create-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        setToken(null);
        const result = await command.run<{ token?: string }>("/developer/credentials", { body: { name: name.trim(), scopes: [...scopes], accountIds: [...selected], expiresInDays } });
        if (result.ok) {
          setToken(result.data.token ?? null);
          setName("");
        }
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="credential-name" label={t("name")} required>
          <Input {...describe("credential-name", {})} value={name} minLength={3} maxLength={80} required onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field id="credential-days" label={t("expiresIn")} required>
          <Input {...describe("credential-days", {})} type="number" inputMode="numeric" min={1} max={90} value={days} required dir="ltr" onChange={(event) => setDays(event.target.value)} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">{t("scopes")}</legend>
        {SCOPES.map((scope) => (
          <Checkbox key={scope} id={`scope-${scope}`} label={<span><Code>{scope}</Code> — {t(`scope.${scope}`)}</span>} checked={scopes.has(scope)} onChange={(event) => setScopes(toggle(scopes, scope, event.target.checked))} />
        ))}
        {scopes.size === 0 ? <p role="alert" className="text-sm font-medium text-danger">{t("chooseScope")}</p> : null}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">{t("accounts")}</legend>
        {accounts.map((account) => (
          <Checkbox key={account.id} id={`credential-account-${account.id}`} label={<bdi>{account.label}</bdi>} checked={selected.has(account.id)} onChange={(event) => setSelected(toggle(selected, account.id, event.target.checked))} />
        ))}
      </fieldset>
      {token ? <ShownOnce title={t("tokenTitle")} help={t("tokenHelp")} value={token} testId="new-token" /> : null}
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="credential-create">
          {command.pending ? common("actions.working") : t("create")}
        </Button>
      </FormActions>
    </form>
  );
}

export function WebhookCreateForm() {
  const t = useTranslations("developer.webhooks");
  const common = useTranslations("common");
  const command = useCommand();
  const [url, setUrl] = useState("https://");
  const [events, setEvents] = useState<ReadonlySet<string>>(new Set(["payment.status_changed"]));
  const [secret, setSecret] = useState<string | null>(null);
  const valid = url.trim().length >= 10 && events.size > 0;
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="webhook-create-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        setSecret(null);
        const result = await command.run<{ signingSecret?: string }>("/developer/webhooks", { body: { url: url.trim(), events: [...events] } });
        if (result.ok) {
          setSecret(result.data.signingSecret ?? null);
          setUrl("https://");
        }
      }}
    >
      <Field id="webhook-url" label={t("url")} required hint={t("urlHint")}>
        <Input {...describe("webhook-url", { hint: true })} type="url" inputMode="url" value={url} maxLength={2000} required dir="ltr" onChange={(event) => setUrl(event.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">{t("events")}</legend>
        {EVENTS.map((name) => (
          <Checkbox key={name} id={`event-${name}`} label={<span><Code>{name}</Code> — {t(`event.${name}`)}</span>} checked={events.has(name)} onChange={(event) => setEvents(toggle(events, name, event.target.checked))} />
        ))}
        {events.size === 0 ? <p role="alert" className="text-sm font-medium text-danger">{t("chooseEvent")}</p> : null}
      </fieldset>
      {secret ? <ShownOnce title={t("secretTitle")} help={t("secretHelp")} value={secret} testId="new-secret" /> : null}
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="webhook-create">
          {command.pending ? common("actions.working") : t("create")}
        </Button>
      </FormActions>
    </form>
  );
}

export function RevokeCredentialButton({ credentialId, label }: { credentialId: string; label: string }) {
  return (
    <CommandButton path={`/developer/credentials/${credentialId}/revoke`} variant="secondary" testId={`revoke-${credentialId}`}>
      {label}
    </CommandButton>
  );
}

export function DisableWebhookButton({ webhookId, version, label }: { webhookId: string; version: number; label: string }) {
  return (
    <CommandButton path={`/developer/webhooks/${webhookId}/disable`} ifMatch={version} variant="secondary" testId={`disable-${webhookId}`}>
      {label}
    </CommandButton>
  );
}
