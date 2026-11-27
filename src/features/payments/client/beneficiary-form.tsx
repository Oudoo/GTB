"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { Checkbox, Field, FormActions, Input, describe } from "@/components/ui/form";
import { Button, Callout, Code } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { api, type ApiFailure } from "@/lib/api-client";

type Check = { status: "MATCHED" | "CLOSE_MATCH" | "MISMATCH" | "NOT_FOUND"; enteredName: string; returnedName: string | null; bankName: string | null; maskedReference: string };

/**
 * Add a beneficiary: enter name + sandbox account, run the name check, then save.
 * "Check failed" (no answer) is shown differently from "name mismatch", and neither the check
 * nor a failed check creates anything (PAY-01).
 */
export function BeneficiaryForm() {
  const t = useTranslations();
  const save = useCommand();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailure, setCheckFailure] = useState<ApiFailure | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const normalized = reference.trim().toUpperCase();

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next["name"] = t("errors.fields.required");
    if (!/^DEMO-LY-[0-9]{6}$/.test(normalized)) next["reference"] = t("corp.beneficiaries.format");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function runCheck() {
    if (!validate()) return;
    setChecking(true);
    setCheck(null);
    setCheckFailure(null);
    setAcknowledge(false);
    const result = await api<Check>("/beneficiaries/name-enquiry", { method: "POST", body: { scheme: "DEMO_DOMESTIC", accountReference: normalized, name: name.trim() } });
    setChecking(false);
    if (result.ok) setCheck(result.data);
    else setCheckFailure(result);
  }

  async function submit() {
    const result = await save.run("/beneficiaries", {
      body: { displayName: name.trim(), scheme: "DEMO_DOMESTIC", accountReference: normalized, ...(acknowledge ? { acknowledgeCloseMatch: true } : {}) },
    });
    if (result.ok) {
      setOpen(false);
      setName("");
      setReference("");
      setCheck(null);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} data-testid="add-beneficiary">
        {t("corp.beneficiaries.add")}
      </Button>
    );
  }

  const canSave = check !== null && (check.status === "MATCHED" || (check.status === "CLOSE_MATCH" && acknowledge));

  return (
    <div className="flex w-full flex-col gap-4 rounded-[10px] border border-border bg-surface p-4" data-testid="beneficiary-form">
      <Field id="ben-name" label={t("corp.beneficiaries.name")} required error={errors["name"]}>
        <Input {...describe("ben-name", { error: Boolean(errors["name"]) })} value={name} maxLength={160} onChange={(event) => { setName(event.target.value); setCheck(null); }} />
      </Field>
      <Field id="ben-reference" label={t("corp.beneficiaries.account")} required hint={t("corp.beneficiaries.format")} error={errors["reference"]}>
        <Input {...describe("ben-reference", { hint: true, error: Boolean(errors["reference"]) })} value={reference} dir="ltr" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="DEMO-LY-000000" onChange={(event) => { setReference(event.target.value); setCheck(null); }} />
      </Field>

      {checkFailure ? (
        checkFailure.code === "NAME_CHECK_UNAVAILABLE" || checkFailure.network ? (
          <Callout tone="warning" role="alert" testId="check-failed">{t("corp.beneficiaries.checkFailed")}</Callout>
        ) : (
          <ProblemAlert failure={checkFailure} />
        )
      ) : null}

      {check ? (
        <div className="rounded-lg border border-border bg-canvas p-3" data-testid="name-check-result" data-status={check.status}>
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {t("corp.beneficiaries.nameCheck")} <StatusBadge family="match" state={check.status} />
          </p>
          <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">{t("corp.beneficiaries.enteredName")}</dt>
              <dd><bdi>{check.enteredName}</bdi></dd>
            </div>
            <div>
              <dt className="text-muted">{t("corp.beneficiaries.returnedName")}</dt>
              <dd><bdi>{check.returnedName ?? "—"}</bdi></dd>
            </div>
            <div>
              <dt className="text-muted">{t("corp.beneficiaries.account")}</dt>
              <dd><Code>{check.maskedReference}</Code>{check.bankName ? ` · ${check.bankName}` : ""}</dd>
            </div>
          </dl>
          {check.status === "MISMATCH" || check.status === "NOT_FOUND" ? <p className="mt-2 text-sm font-medium text-danger">{t("corp.beneficiaries.mismatchHelp")}</p> : null}
          {check.status === "CLOSE_MATCH" ? (
            <div className="mt-2">
              <p className="text-sm">{t("corp.beneficiaries.closeHelp")}</p>
              <Checkbox id="ben-ack" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} label={t("corp.beneficiaries.acknowledge")} />
            </div>
          ) : null}
        </div>
      ) : null}

      <ProblemAlert failure={save.failure} onCheck={save.checkServer} />
      <FormActions>
        <Button variant="secondary" onClick={runCheck} disabled={checking} data-testid="check-name">
          {checking ? t("corp.beneficiaries.checking") : t("corp.beneficiaries.check")}
        </Button>
        <Button onClick={submit} disabled={!canSave || save.pending || save.unknownOutcome} data-testid="save-beneficiary">
          {save.pending ? t("common.actions.working") : t("corp.beneficiaries.save")}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t("common.actions.cancel")}
        </Button>
      </FormActions>
    </div>
  );
}
