"use client";

/**
 * Client controls for bulk and payroll batches (BAT-01..04). Each one calls the published API
 * operation; the server re-checks permissions, ownership, versions, limits and the digest.
 * Nothing here is cached or queued: a lost connection is reported and checked, never replayed.
 */
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CommandButton, ProblemAlert, useCommand } from "@/components/command";
import { Checkbox, Field, FormActions, Input, Select, Textarea, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";

type Kind = "BULK" | "PAYROLL";

/** Re-read server state while a batch is being validated or paid. */
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) router.refresh();
    }, everyMs);
    return () => window.clearInterval(timer);
  }, [router, everyMs]);
  return null;
}

export function BatchUploadForm({ kind, accounts, basePath }: { kind: Kind; accounts: Array<{ id: string; label: string }>; basePath: string }) {
  const t = useTranslations("batches.upload");
  const router = useRouter();
  const command = useCommand();
  const [sourceAccountId, setSourceAccountId] = useState(accounts[0]?.id ?? "");
  const [rail, setRail] = useState<"LYPAY" | "ACH">(kind === "PAYROLL" ? "ACH" : "LYPAY");
  const [mode, setMode] = useState<"IMMEDIATE" | "SCHEDULED">("IMMEDIATE");
  const [executeAt, setExecuteAt] = useState("");
  const [correction, setCorrection] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [missingFile, setMissingFile] = useState(false);
  const template = kind === "PAYROLL" ? "payroll" : "bulk";
  const scheduleValid = mode === "IMMEDIATE" || (executeAt !== "" && !Number.isNaN(new Date(executeAt).getTime()));

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="batch-upload-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!file) {
          setMissingFile(true);
          return;
        }
        if (!scheduleValid) return;
        const form = new FormData();
        form.set("kind", kind);
        form.set("sourceAccountId", sourceAccountId);
        form.set("templateVersion", "1");
        form.set("rail", rail);
        form.set("executionMode", mode);
        if (mode === "SCHEDULED") form.set("executeAt", new Date(executeAt).toISOString());
        if (kind === "PAYROLL" && correction) form.set("correction", "true");
        form.set("file", file);
        const result = await command.run<{ id: string }>("/batches/uploads", { form }, { refresh: false });
        if (result.ok) router.push(`${basePath}/${result.data.id}`);
      }}
    >
      <Field id="batch-source" label={t("sourceAccount")} required>
        <Select {...describe("batch-source", {})} value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)} required>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </Select>
      </Field>
      {kind === "BULK" ? (
        <Field id="batch-rail" label={t("rail")} required>
          <Select {...describe("batch-rail", {})} value={rail} onChange={(event) => setRail(event.target.value as "LYPAY" | "ACH")}>
            <option value="LYPAY">{t("railLYPAY")}</option>
            <option value="ACH">{t("railACH")}</option>
          </Select>
        </Field>
      ) : null}
      <Field id="batch-mode" label={t("when")} required>
        <Select {...describe("batch-mode", {})} value={mode} onChange={(event) => setMode(event.target.value as "IMMEDIATE" | "SCHEDULED")}>
          <option value="IMMEDIATE">{t("now")}</option>
          <option value="SCHEDULED">{t("scheduled")}</option>
        </Select>
      </Field>
      {mode === "SCHEDULED" ? (
        <Field id="batch-execute-at" label={t("executeAt")} required hint={t("executeAtHint")}>
          <Input {...describe("batch-execute-at", { hint: true })} type="datetime-local" value={executeAt} onChange={(event) => setExecuteAt(event.target.value)} required dir="ltr" />
        </Field>
      ) : null}
      {kind === "PAYROLL" ? <Checkbox id="batch-correction" label={<span>{t("correction")} <span className="block text-sm text-muted">{t("correctionHint")}</span></span>} checked={correction} onChange={(event) => setCorrection(event.target.checked)} /> : null}
      <Field id="batch-file" label={t("file")} required hint={t("fileHint")} error={missingFile && !file ? t("chooseFile") : undefined}>
        <input
          {...describe("batch-file", { hint: true, error: missingFile && !file })}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="block min-h-11 w-full rounded-lg border border-border-strong bg-surface text-base file:me-3 file:min-h-11 file:border-0 file:bg-canvas file:px-4 file:font-semibold"
          data-testid="batch-file"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setMissingFile(false);
          }}
        />
      </Field>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span className="font-semibold">{t("template")}:</span>
        <a className="text-accent underline" href={`/api/v1/templates/${template}?format=csv`} download>
          {t("templateCsv")}
        </a>
        <a className="text-accent underline" href={`/api/v1/templates/${template}?format=xlsx`} download>
          {t("templateXlsx")}
        </a>
      </p>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={command.pending || command.unknownOutcome || accounts.length === 0} aria-busy={command.pending} data-testid="batch-upload-submit">
          {command.pending ? t("uploading") : t("submit")}
        </Button>
      </FormActions>
    </form>
  );
}

/**
 * Explicit confirmation of the rows to pay. The count shown is recomputed by the server, which
 * also recomputes the total, the fees and the digest that approvals bind to.
 */
export function AcceptRowsForm({
  batchId,
  version,
  validationVersion,
  rows,
  notValid,
  revising,
}: {
  batchId: string;
  version: number;
  validationVersion: number;
  rows: Array<{ id: string; line: number; label: string; warning: boolean }>;
  notValid: number;
  revising: boolean;
}) {
  const t = useTranslations("batches.accept");
  const common = useTranslations("common");
  const command = useCommand();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [confirmInvalid, setConfirmInvalid] = useState(false);
  const [ackWarnings, setAckWarnings] = useState(false);
  const selected = rows.filter((row) => !excluded.has(row.id));
  const needsAck = selected.some((row) => row.warning);
  const ready = selected.length > 0 && (notValid === 0 || confirmInvalid) && (!needsAck || ackWarnings);

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="accept-rows-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready) return;
        await command.run(`/batches/${batchId}/accept-rows`, {
          body: { validationVersion, excludedRowIds: [...excluded], confirmExcludeInvalid: confirmInvalid, acknowledgeWarnings: ackWarnings },
          ifMatch: version,
        });
      }}
    >
      <p className="text-sm text-muted">{t("help")}</p>
      {revising ? (
        <Callout tone="warning" role="note">
          {t("reviseWarning")}
        </Callout>
      ) : null}
      <details className="rounded-lg border border-border">
        <summary className="min-h-11 cursor-pointer px-3 py-2.5 font-semibold">{t("exclude")}</summary>
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto border-t border-border p-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Checkbox
                id={`exclude-${row.id}`}
                label={
                  <span>
                    <span className="sr-only">{t("excludeRow", { line: row.line })}: </span>
                    <bdi>{row.label}</bdi>
                  </span>
                }
                checked={excluded.has(row.id)}
                onChange={(event) => {
                  const next = new Set(excluded);
                  if (event.target.checked) next.add(row.id);
                  else next.delete(row.id);
                  setExcluded(next);
                }}
              />
            </li>
          ))}
        </ul>
      </details>
      <p className="font-semibold" data-testid="accept-selected" data-count={selected.length}>
        {t("selected", { count: selected.length })}
      </p>
      {notValid > 0 ? <Checkbox id="accept-confirm-invalid" label={t("confirmInvalid", { count: notValid })} checked={confirmInvalid} onChange={(event) => setConfirmInvalid(event.target.checked)} data-testid="confirm-exclude-invalid" /> : null}
      {needsAck ? <Checkbox id="accept-ack-warnings" label={t("ackWarnings")} checked={ackWarnings} onChange={(event) => setAckWarnings(event.target.checked)} data-testid="acknowledge-warnings" /> : null}
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!ready || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="accept-rows">
          {command.pending ? common("actions.working") : t("confirm")}
        </Button>
      </FormActions>
    </form>
  );
}

/** Submit, cancel, failed-row retry and blocked-release retry for one batch. */
export function BatchActions({
  batchId,
  version,
  basePath,
  actions,
}: {
  batchId: string;
  version: number;
  basePath: string;
  actions: { submit: boolean; cancel: boolean; retry: boolean; retryRelease: boolean };
}) {
  const t = useTranslations("batches.actions");
  const errors = useTranslations("errors.fields");
  const common = useTranslations("common");
  const router = useRouter();
  const submit = useCommand();
  const cancel = useCommand();
  const [acceptRolled, setAcceptRolled] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 500;
  // The server names the next available time when the requested one cannot be used.
  const rolled = submit.failure?.code === "EXECUTION_WINDOW_CLOSED" ? ((submit.failure.problem?.violations?.[0] ?? {}) as { nextExecuteAt?: string }) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="batch-actions">
      {actions.submit ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t("submitHelp")}</p>
          {rolled ? (
            <Checkbox
              id="batch-accept-rolled"
              label={t("acceptRolled", { when: rolled.nextExecuteAt ? new Date(rolled.nextExecuteAt).toLocaleString() : "—" })}
              checked={acceptRolled}
              onChange={(event) => setAcceptRolled(event.target.checked)}
            />
          ) : null}
          <div>
            <Button
              disabled={submit.pending || submit.unknownOutcome}
              aria-busy={submit.pending}
              data-testid="submit-batch"
              onClick={async () => {
                await submit.run(`/batches/${batchId}/submit`, { body: acceptRolled ? { acceptRolledExecution: true } : {}, ifMatch: version });
              }}
            >
              {submit.pending ? common("actions.working") : t("submit")}
            </Button>
          </div>
          <ProblemAlert failure={submit.failure} onCheck={submit.checkServer} />
        </div>
      ) : null}
      {actions.retry ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{t("retryHelp")}</p>
          <CommandButton path={`/batches/${batchId}/retry`} body={{}} testId="retry-failed" onSuccess={(data) => router.push(`${basePath}/${(data as { id: string }).id}`)}>
            {t("retry")}
          </CommandButton>
        </div>
      ) : null}
      {actions.retryRelease ? (
        <CommandButton path={`/batches/${batchId}/retry-release`} ifMatch={version} testId="retry-release">
          {t("retryRelease")}
        </CommandButton>
      ) : null}
      {actions.cancel && !cancelling ? (
        <div>
          <Button variant="secondary" onClick={() => setCancelling(true)} data-testid="cancel-batch">
            {t("cancel")}
          </Button>
        </div>
      ) : null}
      {actions.cancel && cancelling ? (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!reasonValid) return;
            const result = await cancel.run(`/batches/${batchId}/cancel`, { body: { reason: reason.trim() }, ifMatch: version });
            if (result.ok) setCancelling(false);
          }}
        >
          <Field id="batch-cancel-reason" label={t("cancelReason")} required error={reason.length > 0 && !reasonValid ? errors("reasonLength") : undefined}>
            <Textarea {...describe("batch-cancel-reason", { error: reason.length > 0 && !reasonValid })} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <ProblemAlert failure={cancel.failure} onCheck={cancel.checkServer} />
          <FormActions>
            <Button type="submit" variant="danger" disabled={!reasonValid || cancel.pending || cancel.unknownOutcome} aria-busy={cancel.pending} data-testid="confirm-cancel-batch">
              {cancel.pending ? common("actions.working") : t("confirmCancel")}
            </Button>
            <Button variant="secondary" onClick={() => setCancelling(false)}>
              {t("keep")}
            </Button>
          </FormActions>
        </form>
      ) : null}
    </div>
  );
}
