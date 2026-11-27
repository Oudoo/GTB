"use client";

/**
 * Employee master forms (PYR-01). Rendered only for payroll officers; the server enforces the
 * payroll-detail permission, the unique code, the version and the account-name check.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { Checkbox, Field, FormActions, Input, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";

type Saved = { accountMatchStatus: string; payable: boolean };

function MatchResult({ saved }: { saved: Saved | null }) {
  const t = useTranslations("payroll.employees");
  if (!saved) return null;
  const key = `matchHelp.${saved.accountMatchStatus}` as Parameters<typeof t>[0];
  return (
    <Callout tone={saved.payable ? "success" : "warning"} role="status" testId="employee-match">
      <span data-match={saved.accountMatchStatus}>{t.has(key) ? t(key) : t("saved")}</span>
    </Callout>
  );
}

export function EmployeeAddForm() {
  const t = useTranslations("payroll.employees");
  const common = useTranslations("common");
  const command = useCommand();
  const [employeeCode, setEmployeeCode] = useState("");
  const [name, setName] = useState("");
  const [accountReference, setAccountReference] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="employee-add-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaved(null);
        const result = await command.run<Saved>("/payroll/employees", { body: { employeeCode: employeeCode.trim(), name: name.trim(), accountScheme: "DEMO_DOMESTIC", accountReference: accountReference.trim().toUpperCase() } });
        if (result.ok) {
          setSaved(result.data);
          setEmployeeCode("");
          setName("");
          setAccountReference("");
        }
      }}
    >
      <p className="text-sm text-muted">{t("addHelp")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field id="employee-code" label={t("code")} required hint={t("codeHint")}>
          <Input {...describe("employee-code", { hint: true })} value={employeeCode} maxLength={32} required dir="ltr" autoCapitalize="characters" onChange={(event) => setEmployeeCode(event.target.value)} />
        </Field>
        <Field id="employee-name" label={t("name")} required>
          <Input {...describe("employee-name", {})} value={name} minLength={2} maxLength={160} required onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field id="employee-account" label={t("account")} required hint={t("accountHint")}>
          <Input {...describe("employee-account", { hint: true })} value={accountReference} maxLength={14} required dir="ltr" autoCapitalize="characters" onChange={(event) => setAccountReference(event.target.value)} />
        </Field>
      </div>
      <MatchResult saved={saved} />
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="employee-add">
          {command.pending ? common("actions.working") : t("add")}
        </Button>
      </FormActions>
    </form>
  );
}

export function EmployeeEditForm({ employee }: { employee: { id: string; employeeCode: string; name: string; accountReference: string; active: boolean; version: number } }) {
  const t = useTranslations("payroll.employees");
  const common = useTranslations("common");
  const command = useCommand();
  const [name, setName] = useState(employee.name);
  const [accountReference, setAccountReference] = useState(employee.accountReference);
  const [active, setActive] = useState(employee.active);
  const [saved, setSaved] = useState<Saved | null>(null);
  const save = async (body: Record<string, unknown>) => {
    setSaved(null);
    const result = await command.run<Saved>(`/payroll/employees/${employee.id}`, { method: "PATCH", body, ifMatch: employee.version });
    if (result.ok) setSaved(result.data);
  };
  const changes = {
    ...(name.trim() !== employee.name ? { name: name.trim() } : {}),
    ...(accountReference.trim().toUpperCase() !== employee.accountReference ? { accountReference: accountReference.trim().toUpperCase() } : {}),
    ...(active !== employee.active ? { active } : {}),
  };
  const id = `edit-${employee.id}`;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (Object.keys(changes).length > 0) await save(changes);
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${id}-name`} label={t("name")} required>
          <Input {...describe(`${id}-name`, {})} value={name} minLength={2} maxLength={160} required onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field id={`${id}-account`} label={t("account")} required>
          <Input {...describe(`${id}-account`, {})} value={accountReference} maxLength={14} required dir="ltr" onChange={(event) => setAccountReference(event.target.value)} />
        </Field>
      </div>
      <Checkbox id={`${id}-active`} label={t("activeLabel")} checked={active} onChange={(event) => setActive(event.target.checked)} />
      <MatchResult saved={saved} />
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={Object.keys(changes).length === 0 || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="employee-save">
          {command.pending ? common("actions.working") : t("save")}
        </Button>
        <Button variant="secondary" disabled={command.pending || command.unknownOutcome} onClick={() => save({ recheck: true })}>
          {t("recheck")}
        </Button>
      </FormActions>
    </form>
  );
}
