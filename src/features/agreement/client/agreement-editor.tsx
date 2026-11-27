"use client";

/**
 * Bank console editor for a FULL agreement revision (AGR-01/02, GOV-002).
 *
 * It edits the same contract object the API accepts and validates it with the shared schema
 * and policy validator before sending; the server validates again and is the authority.
 * Deferred modules are listed but cannot be enabled. Nothing is stored in the browser.
 */
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { AmountInput, Checkbox, Field, FormActions, Input, Select, Textarea, describe } from "@/components/ui/form";
import { Badge, Button, Callout, Card, CardHeader, Code } from "@/components/ui/primitives";
import { agreementProposalSchema, validateAgreementTerms, type AgreementTerms, type ModuleLimit, type ModuleTerms } from "@/contracts/agreement";
import { MODULE_REGISTRY, isDeliveredInR1, type TransactionTypeCode } from "@/contracts/modules";
import { MoneyError, formatMinor, parseUserAmount } from "@/contracts/money";
import { useRouter } from "@/i18n/navigation";
import { zonedInstant } from "@/lib/calendar";
import { markBusy } from "@/pwa/busy-guard";

type EditorAccount = { id: string; label: string };
type LimitKind = "TYPE_ITEM" | "TYPE_DAY" | "TYPE_MONTH" | "MODULE_DAY" | "MODULE_MONTH" | "MODULE_BATCH";

const toText = (minor: string) => formatMinor(BigInt(minor), "LYD");

function toMinor(text: string): string | null {
  try {
    const value = parseUserAmount(text, "LYD");
    return value < 0n ? null : value.toString();
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function limitKindOf(limit: ModuleLimit): LimitKind {
  if (limit.metric === "ITEMS") return "MODULE_BATCH";
  return `${limit.scope}_${limit.period}` as LimitKind;
}

/** Amount field bound to a minor-unit string. Shows what was typed until it parses. */
function MinorField({ id, label, value, onChange, hint }: { id: string; label: string; value: string; onChange: (minor: string) => void; hint?: string }) {
  const [text, setText] = useState(toText(value));
  const [invalid, setInvalid] = useState(false);
  // Follow an outside change of the value (e.g. a limit kind switch) without reformatting what
  // the person is typing: the text is replaced only when it no longer means the same amount.
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    if (toMinor(text) !== value) {
      setText(toText(value));
      setInvalid(false);
    }
  }
  return (
    <Field id={id} label={`${label} (LYD)`} hint={hint} error={invalid ? "0.000" : undefined}>
      <AmountInput
        {...describe(id, { hint: Boolean(hint), error: invalid })}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const minor = toMinor(event.target.value);
          setInvalid(minor === null);
          if (minor !== null) onChange(minor);
        }}
      />
    </Field>
  );
}

export function AgreementEditor({
  corporateId,
  segment,
  initialTerms,
  accounts,
  timeZone,
  defaultFrom,
  defaultUntil,
  signerDefault,
}: {
  corporateId: string;
  segment: AgreementTerms["segment"];
  initialTerms: AgreementTerms;
  accounts: EditorAccount[];
  timeZone: string;
  /** Local bank date/time strings `YYYY-MM-DDTHH:MM`. */
  defaultFrom: string;
  defaultUntil: string;
  signerDefault: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const command = useCommand();
  const [terms, setTerms] = useState<AgreementTerms>(initialTerms);
  const [from, setFrom] = useState(defaultFrom);
  const [until, setUntil] = useState(defaultUntil);
  const [signer, setSigner] = useState(signerDefault);
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => markBusy("agreement-editor"), []);

  const accountIds = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);
  const moduleOf = (moduleId: string) => terms.moduleTerms.find((entry) => entry.moduleId === moduleId);

  function patchModule(moduleId: string, update: (current: ModuleTerms) => ModuleTerms) {
    setTerms((current) => ({ ...current, moduleTerms: current.moduleTerms.map((entry) => (entry.moduleId === moduleId ? update(entry) : entry)) }));
  }

  function toggleModule(moduleId: string, enabled: boolean) {
    setTerms((current) => {
      if (!enabled) return { ...current, moduleTerms: current.moduleTerms.filter((entry) => entry.moduleId !== moduleId) };
      const fromTemplate = initialTerms.moduleTerms.find((entry) => entry.moduleId === moduleId);
      const added: ModuleTerms = fromTemplate ?? { moduleId, transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] };
      return { ...current, moduleTerms: [...current.moduleTerms, added].sort((a, b) => Number(a.moduleId) - Number(b.moduleId)) };
    });
  }

  function toggleType(moduleId: string, type: TransactionTypeCode, enabled: boolean) {
    patchModule(moduleId, (current) => {
      const types = enabled ? [...new Set([...current.transactionTypes, type])] : current.transactionTypes.filter((entry) => entry !== type);
      const outgoing = !type.startsWith("BRANCH_");
      return {
        ...current,
        transactionTypes: types,
        feeRules: enabled
          ? outgoing && !current.feeRules.some((fee) => fee.transactionType === type)
            ? [...current.feeRules, { transactionType: type, currency: "LYD", minor: "0" }]
            : current.feeRules
          : current.feeRules.filter((fee) => fee.transactionType !== type),
        approvalBands: enabled
          ? outgoing && !current.approvalBands.some((band) => band.transactionType === type)
            ? [...current.approvalBands, { transactionType: type, currency: "LYD", minMinor: "0", maxExclusiveMinor: null, checkerCount: 1 }]
            : current.approvalBands
          : current.approvalBands.filter((band) => band.transactionType !== type),
        limits: enabled ? current.limits : current.limits.filter((limit) => limit.transactionType !== type),
      };
    });
  }

  function toggleAccount(moduleId: string, field: "debitAccountIds" | "creditAccountIds", accountId: string, enabled: boolean) {
    patchModule(moduleId, (current) => ({
      ...current,
      [field]: enabled ? [...new Set([...current[field], accountId])] : current[field].filter((entry) => entry !== accountId),
    }));
  }

  async function submit() {
    const local: string[] = [];
    const [fromDate, fromTime] = from.split("T");
    const [untilDate, untilTime] = until.split("T");
    if (!fromDate || !fromTime || !untilDate || !untilTime) local.push(t("errors.fields.dateInvalid"));
    if (signer.trim().length < 2 || evidence.trim().length < 2) local.push(`${t("bank.editor.signature")}: ${t("errors.fields.required")}`);
    if (reason.trim().length < 3) local.push(`${t("bank.editor.changeReason")}: ${t("errors.fields.reasonLength")}`);
    for (const issue of validateAgreementTerms(terms, accountIds)) local.push(`${issue.path}: ${issue.message}`);
    if (local.length > 0) {
      setIssues(local);
      return;
    }
    const proposal = {
      effectiveFrom: zonedInstant(fromDate as string, fromTime as string, timeZone).toISOString(),
      effectiveUntil: zonedInstant(untilDate as string, untilTime as string, timeZone).toISOString(),
      signatureEvidence: [
        {
          signerReference: signer.trim(),
          evidenceReference: evidence.trim(),
          evidenceSha256: await sha256Hex(`${signer.trim()}|${evidence.trim()}`),
          acceptedAt: new Date().toISOString(),
          simulated: true as const,
        },
      ],
      terms,
      changeReason: reason.trim(),
    };
    const parsed = agreementProposalSchema.safeParse(proposal);
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
      return;
    }
    setIssues([]);
    const result = await command.run<{ version: { approvalRequestId: string } }>(`/bank/corporates/${corporateId}/agreement-proposals`, { body: parsed.data }, { refresh: false });
    if (result.ok) {
      router.replace(`/bank/corporates/${corporateId}/agreement?proposed=1`);
      router.refresh();
    }
  }

  const limitKinds: LimitKind[] = ["TYPE_ITEM", "TYPE_DAY", "TYPE_MONTH", "MODULE_DAY", "MODULE_MONTH", "MODULE_BATCH"];

  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4" data-testid="agreement-editor">
      <Callout tone="sandbox" role="note">{t("bank.editor.templateNote", { segment: t(`types.segment.${segment}`) })}</Callout>

      <Card>
        <CardHeader title={t("bank.editor.validity")} description={t("common.labels.bankTime", { zone: timeZone })} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-5">
          <Field id="from" label={t("bank.editor.effectiveFrom")} required>
            <Input {...describe("from", {})} type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field id="until" label={t("bank.editor.effectiveUntil")} required>
            <Input {...describe("until", {})} type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("bank.editor.signature")} description={t("bank.editor.signatureNote")} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-5">
          <Field id="signer" label={t("bank.editor.signer")} required>
            <Input {...describe("signer", {})} value={signer} maxLength={120} onChange={(event) => setSigner(event.target.value)} />
          </Field>
          <Field id="evidence" label={t("bank.editor.evidenceReference")} required>
            <Input {...describe("evidence", {})} value={evidence} maxLength={120} dir="ltr" placeholder="SIM-SIGN-0001" onChange={(event) => setEvidence(event.target.value)} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("bank.editor.corporateLimits")} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-5">
          {(["DAY", "MONTH"] as const).map((period) => {
            const limit = terms.corporateLimits.find((entry) => entry.period === period);
            return (
              <MinorField
                key={period}
                id={`corp-${period}`}
                label={period === "DAY" ? t("bank.editor.daily") : t("bank.editor.monthly")}
                value={limit?.minor ?? "0"}
                onChange={(minor) =>
                  setTerms((current) => ({
                    ...current,
                    corporateLimits: [
                      ...current.corporateLimits.filter((entry) => entry.period !== period),
                      { metric: "AMOUNT", period, currency: "LYD", minor, provenance: limit?.provenance ?? "DEMO_UNCONFIRMED" },
                    ],
                  }))
                }
              />
            );
          })}
          <MinorField id="user-item" label={`${t("bank.editor.userEnvelope")} — ${t("bank.editor.perItem")}`} value={terms.userLimitEnvelope.perItemMinor}
            onChange={(minor) => setTerms((current) => ({ ...current, userLimitEnvelope: { ...current.userLimitEnvelope, perItemMinor: minor } }))} />
          <MinorField id="user-day" label={`${t("bank.editor.userEnvelope")} — ${t("bank.editor.daily")}`} value={terms.userLimitEnvelope.dailyMinor}
            onChange={(minor) => setTerms((current) => ({ ...current, userLimitEnvelope: { ...current.userLimitEnvelope, dailyMinor: minor } }))} />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("bank.editor.modules")} />
        <ul className="divide-y divide-border">
          {MODULE_REGISTRY.map((definition) => {
            const delivered = isDeliveredInR1(definition);
            const current = moduleOf(definition.catalogueId);
            const name = locale === "ar" ? definition.nameAr : definition.name;
            return (
              <li key={definition.catalogueId} className="p-4 sm:p-5" data-module={definition.catalogueId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {delivered ? (
                    <Checkbox
                      id={`mod-${definition.catalogueId}`}
                      checked={Boolean(current)}
                      onChange={(event) => toggleModule(definition.catalogueId, event.target.checked)}
                      label={<span className="font-semibold"><Code>{definition.catalogueId}</Code> {name}</span>}
                    />
                  ) : (
                    <p className="py-2 text-muted">
                      <Code>{definition.catalogueId}</Code> {name}
                    </p>
                  )}
                  <Badge tone={delivered ? "info" : "neutral"}>{delivered ? t(`status.delivery.${definition.deliveryStatus}`) : t("bank.editor.unavailable")}</Badge>
                </div>

                {current && delivered ? (
                  <div className="mt-3 flex flex-col gap-4 ps-2 sm:ps-8">
                    {definition.r1TransactionTypes.length > 0 ? (
                      <fieldset>
                        <legend className="text-sm font-semibold">{t("bank.editor.types")}</legend>
                        <div className="flex flex-wrap gap-x-6">
                          {definition.r1TransactionTypes.map((type) => (
                            <Checkbox key={type} id={`type-${definition.catalogueId}-${type}`} checked={current.transactionTypes.includes(type)}
                              onChange={(event) => toggleType(definition.catalogueId, type, event.target.checked)} label={t(`types.transactionType.${type}`)} />
                          ))}
                        </div>
                      </fieldset>
                    ) : null}

                    {definition.r1TransactionTypes.some((type) => !type.startsWith("BRANCH_")) ? (
                      <fieldset>
                        <legend className="text-sm font-semibold">{t("bank.editor.debitAccounts")}</legend>
                        <div className="flex flex-wrap gap-x-6">
                          {accounts.map((account) => (
                            <Checkbox key={account.id} id={`debit-${definition.catalogueId}-${account.id}`} checked={current.debitAccountIds.includes(account.id)}
                              onChange={(event) => toggleAccount(definition.catalogueId, "debitAccountIds", account.id, event.target.checked)} label={<bdi>{account.label}</bdi>} />
                          ))}
                        </div>
                      </fieldset>
                    ) : null}
                    {definition.catalogueId === "1.5" || definition.catalogueId === "3.2" ? (
                      <fieldset>
                        <legend className="text-sm font-semibold">{t("bank.editor.creditAccounts")}</legend>
                        <div className="flex flex-wrap gap-x-6">
                          {accounts.map((account) => (
                            <Checkbox key={account.id} id={`credit-${definition.catalogueId}-${account.id}`} checked={current.creditAccountIds.includes(account.id)}
                              onChange={(event) => toggleAccount(definition.catalogueId, "creditAccountIds", account.id, event.target.checked)} label={<bdi>{account.label}</bdi>} />
                          ))}
                        </div>
                      </fieldset>
                    ) : null}

                    {current.feeRules.length > 0 ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {current.feeRules.map((fee) => (
                          <MinorField key={fee.transactionType} id={`fee-${definition.catalogueId}-${fee.transactionType}`}
                            label={`${t("bank.editor.fee")} — ${t(`types.transactionType.${fee.transactionType}`)}`} value={fee.minor}
                            onChange={(minor) => patchModule(definition.catalogueId, (entry) => ({ ...entry, feeRules: entry.feeRules.map((rule) => (rule.transactionType === fee.transactionType ? { ...rule, minor } : rule)) }))} />
                        ))}
                      </div>
                    ) : null}

                    {definition.catalogueId === "2.1" || definition.catalogueId === "2.2" ? (
                      <Field id={`rowcap-${definition.catalogueId}`} label={t("bank.editor.rowCap")} className="max-w-xs">
                        <Input {...describe(`rowcap-${definition.catalogueId}`, {})} type="text" inputMode="numeric" value={String(current.rowCap ?? "")}
                          onChange={(event) => {
                            const digits = event.target.value.replace(/\D/g, "").slice(0, 4);
                            patchModule(definition.catalogueId, (entry) => {
                              const next = { ...entry };
                              if (digits) next.rowCap = Number.parseInt(digits, 10);
                              else delete next.rowCap;
                              return next;
                            });
                          }} />
                      </Field>
                    ) : null}

                    {current.transactionTypes.length > 0 ? (
                      <div>
                        <p className="text-sm font-semibold">{t("bank.editor.limits")}</p>
                        <ul className="mt-2 flex flex-col gap-3">
                          {current.limits.map((limit, index) => {
                            const setLimit = (next: ModuleLimit) => patchModule(definition.catalogueId, (entry) => ({ ...entry, limits: entry.limits.map((item, i) => (i === index ? next : item)) }));
                            const kind = limitKindOf(limit);
                            return (
                              <li key={index} className="grid grid-cols-1 items-end gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1.4fr_1.2fr_1fr_auto]">
                                <Field id={`lk-${definition.catalogueId}-${index}`} label={t("common.labels.type")}>
                                  <Select {...describe(`lk-${definition.catalogueId}-${index}`, {})} value={kind}
                                    onChange={(event) => {
                                      const selected = event.target.value as LimitKind;
                                      const type = limit.transactionType ?? current.transactionTypes[0];
                                      if (selected === "MODULE_BATCH") setLimit({ scope: "MODULE", metric: "ITEMS", period: "BATCH", count: 100, provenance: limit.provenance });
                                      else {
                                        const [scope, period] = selected.split("_") as ["TYPE" | "MODULE", "ITEM" | "DAY" | "MONTH"];
                                        setLimit({ scope, ...(scope === "TYPE" && type ? { transactionType: type } : {}), metric: "AMOUNT", period, currency: "LYD", minor: limit.metric === "AMOUNT" ? limit.minor : "0", provenance: limit.provenance });
                                      }
                                    }}>
                                    {limitKinds.map((entry) => (
                                      <option key={entry} value={entry}>{t(`bank.editor.limitKind.${entry}`)}</option>
                                    ))}
                                  </Select>
                                </Field>
                                {limit.scope === "TYPE" ? (
                                  <Field id={`lt-${definition.catalogueId}-${index}`} label={t("bank.editor.types")}>
                                    <Select {...describe(`lt-${definition.catalogueId}-${index}`, {})} value={limit.transactionType ?? ""}
                                      onChange={(event) => setLimit({ ...limit, transactionType: event.target.value as TransactionTypeCode })}>
                                      {current.transactionTypes.map((type) => (
                                        <option key={type} value={type}>{t(`types.transactionType.${type}`)}</option>
                                      ))}
                                    </Select>
                                  </Field>
                                ) : <span className="hidden sm:block" />}
                                {limit.metric === "AMOUNT" ? (
                                  <MinorField id={`lv-${definition.catalogueId}-${index}`} label={t("bank.editor.value")} value={limit.minor} onChange={(minor) => setLimit({ ...limit, minor })} />
                                ) : (
                                  <Field id={`lv-${definition.catalogueId}-${index}`} label={t("bank.editor.value")}>
                                    <Input {...describe(`lv-${definition.catalogueId}-${index}`, {})} type="text" inputMode="numeric" value={String(limit.count)}
                                      onChange={(event) => setLimit({ ...limit, count: Math.max(1, Math.min(1000, Number.parseInt(event.target.value.replace(/\D/g, "") || "1", 10))) })} />
                                  </Field>
                                )}
                                <Button variant="ghost" onClick={() => patchModule(definition.catalogueId, (entry) => ({ ...entry, limits: entry.limits.filter((_item, i) => i !== index) }))}>
                                  {t("bank.editor.remove")}
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                        <Button variant="secondary" className="mt-2"
                          onClick={() => patchModule(definition.catalogueId, (entry) => ({ ...entry, limits: [...entry.limits, { scope: "MODULE", metric: "AMOUNT", period: "DAY", currency: "LYD", minor: "0", provenance: "DEMO_UNCONFIRMED" }] }))}>
                          {t("bank.editor.addLimit")}
                        </Button>
                      </div>
                    ) : null}

                    {current.approvalBands.length > 0 ? (
                      <div>
                        <p className="text-sm font-semibold">{t("bank.editor.bands")}</p>
                        <ul className="mt-2 flex flex-col gap-3">
                          {current.approvalBands.map((band, index) => {
                            const setBand = (next: typeof band) => patchModule(definition.catalogueId, (entry) => ({ ...entry, approvalBands: entry.approvalBands.map((item, i) => (i === index ? next : item)) }));
                            return (
                              <li key={index} className="grid grid-cols-1 items-end gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1.2fr_1fr_1fr_0.6fr_auto]">
                                <Field id={`bt-${definition.catalogueId}-${index}`} label={t("bank.editor.types")}>
                                  <Select {...describe(`bt-${definition.catalogueId}-${index}`, {})} value={band.transactionType} onChange={(event) => setBand({ ...band, transactionType: event.target.value as TransactionTypeCode })}>
                                    {current.transactionTypes.filter((type) => !type.startsWith("BRANCH_")).map((type) => (
                                      <option key={type} value={type}>{t(`types.transactionType.${type}`)}</option>
                                    ))}
                                  </Select>
                                </Field>
                                <MinorField id={`bf-${definition.catalogueId}-${index}`} label={t("bank.editor.bandFrom")} value={band.minMinor} onChange={(minor) => setBand({ ...band, minMinor: minor })} />
                                <Field id={`bu-${definition.catalogueId}-${index}`} label={`${t("bank.editor.bandTo")} (LYD)`}>
                                  <AmountInput {...describe(`bu-${definition.catalogueId}-${index}`, {})} defaultValue={band.maxExclusiveMinor === null ? "" : toText(band.maxExclusiveMinor)}
                                    onChange={(event) => {
                                      const text = event.target.value.trim();
                                      if (text === "") setBand({ ...band, maxExclusiveMinor: null });
                                      else {
                                        const minor = toMinor(text);
                                        if (minor !== null) setBand({ ...band, maxExclusiveMinor: minor });
                                      }
                                    }} />
                                </Field>
                                <Field id={`bc-${definition.catalogueId}-${index}`} label={t("bank.editor.checkers")}>
                                  <Select {...describe(`bc-${definition.catalogueId}-${index}`, {})} value={String(band.checkerCount)} onChange={(event) => setBand({ ...band, checkerCount: Number.parseInt(event.target.value, 10) })}>
                                    {[1, 2, 3].map((count) => (
                                      <option key={count} value={count}>{count}</option>
                                    ))}
                                  </Select>
                                </Field>
                                <Button variant="ghost" onClick={() => patchModule(definition.catalogueId, (entry) => ({ ...entry, approvalBands: entry.approvalBands.filter((_item, i) => i !== index) }))}>
                                  {t("bank.editor.remove")}
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                        <Button variant="secondary" className="mt-2"
                          onClick={() => {
                            const type = current.transactionTypes.find((entry) => !entry.startsWith("BRANCH_"));
                            if (!type) return;
                            patchModule(definition.catalogueId, (entry) => ({ ...entry, approvalBands: [...entry.approvalBands, { transactionType: type, currency: "LYD", minMinor: "0", maxExclusiveMinor: null, checkerCount: 1 }] }));
                          }}>
                          {t("bank.editor.addBand")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      {terms.depositPolicy ? (
        <Card>
          <CardHeader title={t("bank.editor.depositPolicy")} />
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3 sm:p-5">
            <MinorField id="dep-cap" label={t("bank.editor.perDepositCap")} value={terms.depositPolicy.perDepositCapMinor}
              onChange={(minor) => setTerms((current) => (current.depositPolicy ? { ...current, depositPolicy: { ...current.depositPolicy, perDepositCapMinor: minor } } : current))} />
            <MinorField id="dep-manager" label={t("bank.editor.managerThreshold")} value={terms.depositPolicy.managerThresholdMinor}
              onChange={(minor) => setTerms((current) => (current.depositPolicy ? { ...current, depositPolicy: { ...current.depositPolicy, managerThresholdMinor: minor } } : current))} />
            <MinorField id="dep-review" label={t("bank.editor.cashReview")} value={terms.depositPolicy.cashReviewThresholdMinor}
              onChange={(minor) => setTerms((current) => (current.depositPolicy ? { ...current, depositPolicy: { ...current.depositPolicy, cashReviewThresholdMinor: minor } } : current))} />
          </div>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-4 p-4 sm:p-5">
        <Field id="change-reason" label={t("bank.editor.changeReason")} required>
          <Textarea {...describe("change-reason", {})} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
        {issues.length > 0 ? (
          <Callout tone="danger" role="alert" title={t("bank.editor.issues")} testId="editor-issues">
            <ul className="list-disc ps-5">
              {issues.slice(0, 12).map((issue, index) => (
                <li key={index}><bdi>{issue}</bdi></li>
              ))}
            </ul>
          </Callout>
        ) : null}
        <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
        <FormActions>
          <Button onClick={submit} disabled={command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="propose-agreement">
            {command.pending ? t("common.actions.working") : t("bank.editor.submit")}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/bank/corporates/${corporateId}/agreement`)} disabled={command.pending}>
            {t("bank.editor.discard")}
          </Button>
        </FormActions>
      </Card>
    </div>
  );
}
