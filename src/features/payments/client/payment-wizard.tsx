"use client";

/**
 * Five-step payment wizard (document 05): source → recipient → details → review → submit.
 *
 * - The amount is parsed to exact minor units in the browser only for early feedback; the
 *   server parses and validates again. Nothing here decides fee, limits or approvals.
 * - The review step shows the server's ADVISORY preview and says it is checked again before
 *   execution. The final control is "Submit for approval", never "Pay now".
 * - Entered values live in component memory only. They are not autosaved to browser storage
 *   (PWA-04); leaving the page discards them.
 */
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { AmountInput, Checkbox, Field, FormActions, Input, Select, describe } from "@/components/ui/form";
import { Badge, Button, Callout, Card, Code, DetailList, LinkButton, Money } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { MoneyError, parseUserAmount } from "@/contracts/money";
import type { SinglePaymentType } from "@/contracts/payments";
import { useRouter } from "@/i18n/navigation";
import { api, type ApiFailure } from "@/lib/api-client";
import { zonedInstant } from "@/lib/calendar";
import { formatDateTime, type MoneyLike } from "@/lib/format";
import { markBusy } from "@/pwa/busy-guard";

export type WizardAccount = {
  id: string;
  name: string;
  maskedNumber: string;
  currency: string;
  status: string;
  canDebit: boolean;
  available: MoneyLike | null;
};

export type WizardBeneficiary = {
  id: string;
  displayName: string;
  maskedReference: string;
  bankName: string | null;
  matchStatus: string;
  matchedName: string | null;
  closeMatchAcknowledged: boolean;
};

type Preview = {
  fee: MoneyLike | null;
  totalDebit: MoneyLike | null;
  available: MoneyLike | null;
  projectedAvailable: MoneyLike | null;
  coreAsOf: string | null;
  requiredCheckers: number | null;
  agreement: { versionNo: number };
  constraints: Array<{ code: string; scope: string; period: string; metric: string; limit: string | null; remaining: string | null; passes: boolean }>;
  execution: { executeAt: string; businessDate: string; rolled: boolean; reason: string | null; timeZone: string } | null;
  passes: boolean;
  failures: Array<{ code: string }>;
};

const STEPS = ["source", "recipient", "details", "review", "submit"] as const;

export function PaymentWizard({
  accounts,
  beneficiaries,
  enabledTypes,
  timeZone,
  today,
}: {
  accounts: WizardAccount[];
  beneficiaries: WizardBeneficiary[];
  /** Transaction types the effective agreement enables, per source account id. */
  enabledTypes: Record<string, SinglePaymentType[]>;
  timeZone: string;
  /** Current bank business date (YYYY-MM-DD) for the date picker minimum. */
  today: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const command = useCommand();

  const [step, setStep] = useState(0);
  const [sourceId, setSourceId] = useState(accounts.find((account) => account.canDebit && account.status === "ACTIVE")?.id ?? "");
  const [recipientKind, setRecipientKind] = useState<"BENEFICIARY" | "OWN_ACCOUNT">("BENEFICIARY");
  const [beneficiaryId, setBeneficiaryId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [chosenMethod, setMethod] = useState<SinglePaymentType>("INSTANT_ACCOUNT_CREDIT");
  const [amountText, setAmountText] = useState("");
  const [purpose, setPurpose] = useState("");
  const [clientReference, setClientReference] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [acknowledge, setAcknowledge] = useState(false);
  const [acceptRolled, setAcceptRolled] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFailure, setPreviewFailure] = useState<ApiFailure | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // An unsaved form blocks a forced app update/reload (PWA-07).
  useEffect(() => markBusy("payment-wizard"), []);

  const source = accounts.find((account) => account.id === sourceId);
  const beneficiary = beneficiaries.find((entry) => entry.id === beneficiaryId);
  const destination = accounts.find((account) => account.id === destinationId);
  const types = useMemo(() => enabledTypes[sourceId] ?? [], [enabledTypes, sourceId]);
  const externalTypes = types.filter((type) => type !== "OWN_ACCOUNT_TRANSFER");
  const ownAllowed = types.includes("OWN_ACCOUNT_TRANSFER");
  // The chosen method only applies while the selected account's agreement enables it;
  // otherwise the first enabled external method is used (derived, never synced in an effect).
  const method: SinglePaymentType =
    externalTypes.length > 0 && !(externalTypes as SinglePaymentType[]).includes(chosenMethod) ? (externalTypes[0] as SinglePaymentType) : chosenMethod;
  const transactionType: SinglePaymentType = recipientKind === "OWN_ACCOUNT" ? "OWN_ACCOUNT_TRANSFER" : method;

  function buildInput() {
    const currency = source?.currency ?? "LYD";
    const minor = parseUserAmount(amountText, currency === "USD" || currency === "EUR" ? currency : "LYD");
    return {
      moduleId: transactionType === "INSTANT_ACCOUNT_CREDIT" ? "1.1" : transactionType === "ACH_CREDIT" ? "1.2" : "1.5",
      transactionType,
      sourceAccountId: sourceId,
      ...(recipientKind === "OWN_ACCOUNT" ? { destinationAccountId: destinationId } : { beneficiaryId }),
      amount: { currency, minor: minor.toString() },
      purpose: purpose.trim(),
      ...(clientReference.trim() ? { clientReference: clientReference.trim() } : {}),
      execution: when === "later" ? { mode: "SCHEDULED", executeAt: zonedInstant(date, time, timeZone).toISOString() } : { mode: "IMMEDIATE" },
      ...(acknowledge ? { acknowledgeCloseMatch: true } : {}),
      ...(acceptRolled ? { acceptRolledExecution: true } : {}),
    };
  }

  function validate(current: number): boolean {
    const next: Record<string, string> = {};
    if (current === 0 && !source) next["source"] = t("errors.fields.required");
    if (current === 1) {
      if (recipientKind === "BENEFICIARY") {
        if (!beneficiary) next["beneficiary"] = t("errors.fields.required");
        else if (beneficiary.matchStatus === "CLOSE_MATCH" && !beneficiary.closeMatchAcknowledged && !acknowledge) {
          next["acknowledge"] = t("errors.fields.required");
        }
      } else if (!destination) next["destination"] = t("errors.fields.required");
    }
    if (current === 2) {
      try {
        const minor = parseUserAmount(amountText, "LYD");
        if (minor <= 0n) next["amount"] = t("errors.fields.amountPositive");
      } catch (error) {
        next["amount"] = error instanceof MoneyError && error.code === "TOO_MANY_DECIMALS" ? t("errors.fields.amountDecimals") : t("errors.fields.amountFormat");
      }
      if (purpose.trim().length < 3) next["purpose"] = t("errors.fields.tooShort");
      if (purpose.trim().length > 140) next["purpose"] = t("errors.fields.tooLong");
      if (when === "later" && (!date || !/^\d{2}:\d{2}$/.test(time))) next["date"] = t("errors.fields.dateInvalid");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function loadPreview() {
    setPreviewing(true);
    setPreviewFailure(null);
    const result = await api<Preview>("/payments/preview", { method: "POST", body: buildInput() });
    setPreviewing(false);
    if (result.ok) setPreview(result.data);
    else {
      setPreview(null);
      setPreviewFailure(result);
    }
  }

  async function goNext() {
    if (!validate(step)) return;
    if (step === 2) await loadPreview();
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
    window.scrollTo({ top: 0 });
  }

  function goBack() {
    // Going back invalidates the estimate: it is recomputed on the way forward.
    if (step <= 3) {
      setPreview(null);
      setAcceptRolled(false);
    }
    setStep((current) => Math.max(current - 1, 0));
  }

  async function submit() {
    const created = await command.run<{ id: string; version: number }>("/payments", { body: buildInput() }, { refresh: false });
    if (!created.ok) return;
    const submitted = await api<{ id: string }>(`/payments/${created.data.id}/submit`, {
      method: "POST",
      idempotencyKey: `submit-${created.data.id}`,
      ifMatch: created.data.version,
      body: { ...(acceptRolled ? { acceptRolledExecution: true } : {}), ...(acknowledge ? { acknowledgeCloseMatch: true } : {}) },
    });
    // Either way the draft exists on the server: continue on its persistent detail page.
    router.push(`/payments/${created.data.id}${submitted.ok ? "" : "?submit=failed"}`);
    router.refresh();
  }

  if (accounts.filter((account) => account.canDebit).length === 0) {
    return (
      <Card className="p-5">
        <Callout tone="info" title={t("corp.payments.wizard.sourceEmpty")}>
          {t("corp.payments.wizard.sourceEmptyHint")}
        </Callout>
      </Card>
    );
  }

  const stepLabel = t(`corp.payments.wizard.steps.${STEPS[step] as (typeof STEPS)[number]}` as Parameters<typeof t>[0]);
  const blockingRolled = Boolean(preview?.execution?.rolled) && !acceptRolled;
  const onlyRolledBlocks = preview ? preview.failures.every((failure) => failure.code === "EXECUTION_WINDOW_CLOSED") : false;
  const canSubmit = Boolean(preview) && (preview?.passes || (onlyRolledBlocks && acceptRolled)) && !blockingRolled;

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
      <ol className="flex items-center gap-1 text-xs font-semibold" aria-label={t("corp.payments.wizard.title")}>
        {STEPS.map((key, index) => (
          <li key={key} aria-current={index === step ? "step" : undefined} className={`flex-1 rounded-full py-1 text-center ${index === step ? "bg-accent text-white" : index < step ? "bg-accent-soft text-accent" : "bg-border/60 text-muted"}`}>
            <span className="hidden sm:inline">{t(`corp.payments.wizard.steps.${key}` as Parameters<typeof t>[0])}</span>
            <span className="sm:hidden">{index + 1}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted" aria-live="polite" data-testid="wizard-step">
        {t("corp.payments.wizard.stepOf", { current: step + 1, total: STEPS.length })} · {stepLabel}
      </p>

      <Card className="flex flex-col gap-5 p-4 sm:p-6">
        {step === 0 ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-lg font-semibold">{t("corp.payments.wizard.sourceTitle")}</legend>
            {accounts.map((account) => {
              const usable = account.canDebit && account.status === "ACTIVE";
              return (
                <label
                  key={account.id}
                  className={`flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border p-3 ${sourceId === account.id ? "border-accent bg-accent-soft" : "border-border"} ${usable ? "" : "cursor-not-allowed opacity-60"}`}
                >
                  <input type="radio" name="source" value={account.id} checked={sourceId === account.id} disabled={!usable} onChange={() => setSourceId(account.id)} className="mt-1 size-5 accent-[var(--color-accent)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{account.name}</span>
                    <span className="block text-sm text-muted">
                      <Code>{account.maskedNumber}</Code> · {account.currency}
                    </span>
                    {account.status !== "ACTIVE" ? <span className="text-sm text-danger">{t("corp.payments.wizard.frozen")}</span> : null}
                  </span>
                  <span className="text-end text-sm">
                    <span className="block text-muted">{t("corp.payments.wizard.available")}</span>
                    {account.available ? <Money value={account.available} className="font-semibold" /> : <span className="text-warning">{t("common.labels.notAvailable")}</span>}
                  </span>
                </label>
              );
            })}
            {errors["source"] ? <p role="alert" className="text-sm font-medium text-danger">{errors["source"]}</p> : null}
          </fieldset>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">{t("corp.payments.wizard.recipientTitle")}</h2>
            <div role="radiogroup" aria-label={t("corp.payments.wizard.recipientTitle")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(["BENEFICIARY", "OWN_ACCOUNT"] as const).map((kind) => {
                const disabled = kind === "OWN_ACCOUNT" ? !ownAllowed : externalTypes.length === 0;
                return (
                  <label key={kind} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${recipientKind === kind ? "border-accent bg-accent-soft" : "border-border"} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
                    <input type="radio" name="recipientKind" checked={recipientKind === kind} disabled={disabled} onChange={() => setRecipientKind(kind)} className="size-5 accent-[var(--color-accent)]" />
                    <span className="font-semibold">{kind === "BENEFICIARY" ? t("corp.payments.wizard.recipientBeneficiary") : t("corp.payments.wizard.recipientOwn")}</span>
                  </label>
                );
              })}
            </div>

            {recipientKind === "BENEFICIARY" ? (
              beneficiaries.length === 0 ? (
                <Callout tone="info" title={t("corp.payments.wizard.noBeneficiaries")}>
                  <LinkButton href="/beneficiaries" variant="secondary" className="mt-2">
                    {t("corp.payments.wizard.addBeneficiary")}
                  </LinkButton>
                </Callout>
              ) : (
                <>
                  <Field id="beneficiary" label={t("corp.payments.wizard.chooseBeneficiary")} required error={errors["beneficiary"]}>
                    <Select {...describe("beneficiary", { error: Boolean(errors["beneficiary"]) })} value={beneficiaryId} onChange={(event) => { setBeneficiaryId(event.target.value); setAcknowledge(false); }}>
                      <option value="">—</option>
                      {beneficiaries.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.displayName} · {entry.maskedReference}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {beneficiary ? (
                    <div className="rounded-lg border border-border bg-canvas p-3" data-testid="recipient-check">
                      <p className="font-semibold">{beneficiary.displayName}</p>
                      <p className="text-sm text-muted">
                        <Code>{beneficiary.maskedReference}</Code>
                        {beneficiary.bankName ? ` · ${beneficiary.bankName}` : ""}
                      </p>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                        {t("corp.payments.wizard.nameCheck")}: <StatusBadge family="match" state={beneficiary.matchStatus} />
                      </p>
                      {beneficiary.matchStatus === "CLOSE_MATCH" && !beneficiary.closeMatchAcknowledged ? (
                        <div className="mt-2">
                          <p className="text-sm">{t("corp.payments.wizard.closeMatch", { name: beneficiary.matchedName ?? "" })}</p>
                          <Checkbox id="acknowledge" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} label={t("corp.payments.wizard.acknowledgeCloseMatch")} />
                          {errors["acknowledge"] ? <p role="alert" className="text-sm font-medium text-danger">{errors["acknowledge"]}</p> : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )
            ) : (
              <Field id="destination" label={t("corp.payments.wizard.chooseOwn")} required error={errors["destination"]}>
                <Select {...describe("destination", { error: Boolean(errors["destination"]) })} value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>
                  <option value="">—</option>
                  {accounts
                    .filter((account) => account.id !== sourceId && account.status === "ACTIVE" && account.currency === source?.currency)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name} · {account.maskedNumber}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">{t("corp.payments.wizard.detailsTitle")}</h2>
            {recipientKind === "BENEFICIARY" ? (
              <Field id="method" label={t("corp.payments.wizard.method")} hint={t(`types.railHelp.${method === "ACH_CREDIT" ? "ACH" : "LYPAY"}` as Parameters<typeof t>[0])}>
                <Select {...describe("method", { hint: true })} value={method} onChange={(event) => setMethod(event.target.value as SinglePaymentType)}>
                  {externalTypes.map((type) => (
                    <option key={type} value={type}>
                      {t(`types.transactionType.${type}` as Parameters<typeof t>[0])}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field id="amount" label={`${t("common.labels.amount")} (${source?.currency ?? "LYD"})`} required hint={t("corp.payments.wizard.amountHint")} error={errors["amount"]}>
              <AmountInput {...describe("amount", { hint: true, error: Boolean(errors["amount"]) })} name="amount" value={amountText} onChange={(event) => setAmountText(event.target.value)} placeholder="0.000" />
            </Field>
            <Field id="purpose" label={t("corp.payments.wizard.purpose")} required hint={t("corp.payments.wizard.purposeHint")} error={errors["purpose"]}>
              <Input {...describe("purpose", { hint: true, error: Boolean(errors["purpose"]) })} name="purpose" value={purpose} maxLength={140} onChange={(event) => setPurpose(event.target.value)} />
            </Field>
            <Field id="clientReference" label={`${t("corp.payments.wizard.clientReference")} (${t("common.labels.optional")})`}>
              <Input {...describe("clientReference", {})} name="clientReference" value={clientReference} maxLength={64} dir="ltr" onChange={(event) => setClientReference(event.target.value)} />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-semibold">{t("corp.payments.wizard.when")}</legend>
              {(["now", "later"] as const).map((option) => (
                <label key={option} className="flex min-h-11 cursor-pointer items-center gap-3">
                  <input type="radio" name="when" checked={when === option} onChange={() => setWhen(option)} className="size-5 accent-[var(--color-accent)]" />
                  <span>{option === "now" ? t("corp.payments.wizard.whenNow") : t("corp.payments.wizard.whenLater")}</span>
                </label>
              ))}
              {when === "later" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field id="date" label={t("corp.payments.wizard.date")} hint={t("corp.payments.wizard.horizon")} error={errors["date"]}>
                    <Input {...describe("date", { hint: true, error: Boolean(errors["date"]) })} type="date" min={today} value={date} onChange={(event) => setDate(event.target.value)} />
                  </Field>
                  <Field id="time" label={`${t("corp.payments.wizard.time")} · ${timeZone}`}>
                    <Input {...describe("time", {})} type="time" value={time} onChange={(event) => setTime(event.target.value)} />
                  </Field>
                </div>
              ) : null}
            </fieldset>
          </div>
        ) : null}

        {step >= 3 ? (
          <div className="flex flex-col gap-4" data-testid="payment-review">
            <h2 className="text-lg font-semibold">{step === 3 ? t("corp.payments.wizard.reviewTitle") : t("corp.payments.wizard.submit")}</h2>
            {previewing ? <p className="text-muted" role="status">{t("common.states.loading")}</p> : null}
            <ProblemAlert failure={previewFailure} />
            {preview ? (
              <>
                <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-canvas p-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.money.principal")}</p>
                    <p className="text-xl font-semibold" data-testid="preview-principal">
                      <Money value={{ currency: source?.currency ?? "LYD", minor: buildInput().amount.minor }} />
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.fee")}</p>
                    <p className="text-xl font-semibold" data-testid="preview-fee">{preview.fee ? <Money value={preview.fee} /> : t("common.labels.notAvailable")}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.totalDebit")}</p>
                    <p className="text-xl font-semibold" data-testid="preview-total">{preview.totalDebit ? <Money value={preview.totalDebit} /> : t("common.labels.notAvailable")}</p>
                  </div>
                </div>
                <p className="text-sm font-semibold text-info" data-testid="estimate-note">{t("common.money.estimate")}</p>

                <DetailList
                  items={[
                    { label: t("corp.payments.source"), value: <>{source?.name} · <Code>{source?.maskedNumber}</Code></> },
                    {
                      label: t("corp.payments.recipient"),
                      value: recipientKind === "OWN_ACCOUNT" ? <>{destination?.name} · <Code>{destination?.maskedNumber}</Code></> : <>{beneficiary?.displayName} · <Code>{beneficiary?.maskedReference}</Code></>,
                    },
                    { label: t("common.labels.type"), value: t(`types.transactionType.${transactionType}` as Parameters<typeof t>[0]) },
                    { label: t("common.labels.purpose"), value: <bdi>{purpose}</bdi> },
                    {
                      label: t("corp.payments.wizard.estimatedAfter"),
                      value: preview.projectedAvailable ? <Money value={preview.projectedAvailable} /> : <span className="text-warning">{t("corp.payments.wizard.fundsUnknown")}</span>,
                    },
                    {
                      label: t("corp.payments.executeAt"),
                      value: preview.execution ? `${formatDateTime(preview.execution.executeAt, locale, timeZone)} · ${t("common.labels.bankTime", { zone: timeZone })}` : t("common.labels.notAvailable"),
                    },
                    {
                      label: t("corp.payments.detail.approvals"),
                      value: preview.requiredCheckers !== null ? t("corp.payments.wizard.checkersRequired", { count: preview.requiredCheckers }) : t("errors.APPROVAL_POLICY_UNAVAILABLE"),
                    },
                    { label: t("corp.agreement.title"), value: t("corp.payments.wizard.agreementVersion", { version: preview.agreement.versionNo }) },
                  ]}
                />

                <section aria-labelledby="checks-title">
                  <h3 id="checks-title" className="mb-2 text-sm font-semibold">{t("corp.payments.wizard.checks")}</h3>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {preview.constraints.map((constraint, index) => (
                      <li key={index} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-passes={constraint.passes}>
                        <span>
                          {t(`types.limitLevel.${constraint.scope}` as Parameters<typeof t>[0])} · {t(`types.period.${constraint.period}` as Parameters<typeof t>[0])}
                          <span className="block text-xs text-muted">
                            {constraint.limit === null ? (
                              t("corp.payments.wizard.notConfigured")
                            ) : constraint.remaining !== null && constraint.period !== "ITEM" ? (
                              <>
                                {t("corp.limits.remaining")}: <Money value={{ currency: "LYD", minor: constraint.remaining.startsWith("-") ? "0" : constraint.remaining }} />
                              </>
                            ) : (
                              <>
                                {t("corp.limits.limit")}: <Money value={{ currency: "LYD", minor: constraint.limit }} />
                              </>
                            )}
                          </span>
                        </span>
                        <Badge tone={constraint.passes ? "success" : "danger"}>{constraint.passes ? t("corp.payments.wizard.checkPasses") : t("corp.payments.wizard.checkFails")}</Badge>
                      </li>
                    ))}
                  </ul>
                </section>

                {preview.failures.filter((failure) => failure.code !== "EXECUTION_WINDOW_CLOSED").length > 0 ? (
                  <Callout tone="danger" role="alert" title={t("corp.payments.wizard.cannotSubmit")} testId="preview-blocked">
                    <ul className="list-disc ps-5">
                      {[...new Set(preview.failures.map((failure) => failure.code))]
                        .filter((code) => code !== "EXECUTION_WINDOW_CLOSED")
                        .map((code) => (
                          <li key={code} data-code={code}>{t.has(`errors.${code}` as Parameters<typeof t>[0]) ? t(`errors.${code}` as Parameters<typeof t>[0]) : code}</li>
                        ))}
                    </ul>
                  </Callout>
                ) : null}

                {preview.execution?.rolled ? (
                  <Callout tone="warning" title={t("corp.payments.wizard.rolledTitle")} testId="rolled-notice">
                    <p>
                      {t("corp.payments.wizard.rolledBody", {
                        reason: preview.execution.reason ? t(`types.windowReason.${preview.execution.reason}` as Parameters<typeof t>[0]) : "",
                        when: formatDateTime(preview.execution.executeAt, locale, timeZone),
                        date: preview.execution.businessDate,
                      })}
                    </p>
                    <Checkbox id="acceptRolled" checked={acceptRolled} onChange={(event) => setAcceptRolled(event.target.checked)} label={t("corp.payments.wizard.acceptRolled")} />
                  </Callout>
                ) : null}

                {step === 4 ? (
                  <Callout tone="info" role="note">
                    {t("corp.payments.wizard.submitNote")}
                  </Callout>
                ) : null}
              </>
            ) : null}
            <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
            {command.unknownOutcome ? <Callout tone="warning" role="status">{t("common.offline.resultChecking")}</Callout> : null}
          </div>
        ) : null}

        <FormActions>
          {step > 0 ? (
            <Button variant="secondary" onClick={goBack} disabled={command.pending}>
              {t("common.actions.back")}
            </Button>
          ) : (
            <LinkButton href="/payments" variant="secondary">
              {t("common.actions.cancel")}
            </LinkButton>
          )}
          {step < 3 ? (
            <Button onClick={goNext} data-testid="wizard-next">
              {t("common.actions.next")}
            </Button>
          ) : step === 3 ? (
            <Button onClick={() => setStep(4)} disabled={!canSubmit} data-testid="wizard-next">
              {t("common.actions.next")}
            </Button>
          ) : (
            <Button onClick={submit} disabled={!canSubmit || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="submit-for-approval">
              {command.pending ? t("common.actions.working") : t("corp.payments.wizard.submit")}
            </Button>
          )}
        </FormActions>
      </Card>
    </div>
  );
}
