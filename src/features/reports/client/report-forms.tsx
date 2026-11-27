"use client";

/** Report request form (RPT-01). The server decides scope, range and projection. */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { Checkbox, Field, FormActions, Input, Select, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";

export function ReportRequestForm({ accounts, today, canDeposits, locale }: { accounts: Array<{ id: string; label: string }>; today: string; canDeposits: boolean; locale: "en" | "ar" }) {
  const t = useTranslations("reports");
  const common = useTranslations("common");
  const command = useCommand();
  const [type, setType] = useState<"STATEMENT" | "DEPOSIT_SUMMARY">("STATEMENT");
  const [format, setFormat] = useState<"CSV" | "PDF">("CSV");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(accounts.slice(0, 1).map((account) => account.id)));
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [language, setLanguage] = useState<"en" | "ar">(locale);
  const effectiveFormat = type === "DEPOSIT_SUMMARY" ? "CSV" : format;
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="report-request-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (selected.size === 0) return;
        await command.run("/reports", { body: { type, format: effectiveFormat, accountIds: [...selected], fromDate, toDate, locale: language } });
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field id="report-type" label={t("type")} required>
          <Select {...describe("report-type", {})} value={type} onChange={(event) => setType(event.target.value as "STATEMENT" | "DEPOSIT_SUMMARY")}>
            <option value="STATEMENT">{t("types.STATEMENT")}</option>
            {canDeposits ? <option value="DEPOSIT_SUMMARY">{t("types.DEPOSIT_SUMMARY")}</option> : null}
          </Select>
        </Field>
        <Field id="report-format" label={t("format")} required hint={type === "DEPOSIT_SUMMARY" ? t("csvOnly") : undefined}>
          <Select {...describe("report-format", { hint: type === "DEPOSIT_SUMMARY" })} value={effectiveFormat} disabled={type === "DEPOSIT_SUMMARY"} onChange={(event) => setFormat(event.target.value as "CSV" | "PDF")}>
            <option value="CSV">{t("formats.CSV")}</option>
            <option value="PDF">{t("formats.PDF")}</option>
          </Select>
        </Field>
        <Field id="report-language" label={t("language")} required>
          <Select {...describe("report-language", {})} value={language} onChange={(event) => setLanguage(event.target.value as "en" | "ar")}>
            <option value="en">{t("languages.en")}</option>
            <option value="ar">{t("languages.ar")}</option>
          </Select>
        </Field>
        <Field id="report-from" label={t("from")} required>
          <Input {...describe("report-from", {})} type="date" value={fromDate} max={today} required dir="ltr" onChange={(event) => setFromDate(event.target.value)} />
        </Field>
        <Field id="report-to" label={t("to")} required>
          <Input {...describe("report-to", {})} type="date" value={toDate} max={today} required dir="ltr" onChange={(event) => setToDate(event.target.value)} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">{t("accounts")}</legend>
        {accounts.map((account) => (
          <Checkbox
            key={account.id}
            id={`report-account-${account.id}`}
            label={<bdi>{account.label}</bdi>}
            checked={selected.has(account.id)}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(account.id);
              else next.delete(account.id);
              setSelected(next);
            }}
          />
        ))}
        {selected.size === 0 ? <p role="alert" className="text-sm font-medium text-danger">{t("chooseAccount")}</p> : null}
      </fieldset>
      {type === "STATEMENT" ? <Callout tone="info">{t("payrollNote")}</Callout> : null}
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={selected.size === 0 || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="report-request">
          {command.pending ? common("actions.working") : t("request")}
        </Button>
      </FormActions>
    </form>
  );
}
