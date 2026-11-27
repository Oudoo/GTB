"use client";

/**
 * Propose a rail parameter change (LIM-01, GOV-003). Every value is a configurable sandbox
 * parameter. Leaving the ceiling empty proposes "not configured", which blocks the rail —
 * it is never treated as zero or as unlimited. The change takes effect only after a different
 * bank administrator approves it.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { AmountInput, Checkbox, Field, FormActions, Input, Select, Textarea, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";
import { MoneyError, formatMinor, parseUserAmount } from "@/contracts/money";
import { zonedInstant } from "@/lib/calendar";

type Rail = "LYPAY" | "ACH" | "INTERNAL" | "BRANCH";

export type RailFormCurrent = {
  rail: string;
  ceilingMinor: string | null;
  provenance: string;
  calendarId: string;
  openLocalTime: string | null;
  cutoffLocalTime: string | null;
  observesClosedDays: boolean;
  offlineStartLocalTime: string | null;
  offlineEndLocalTime: string | null;
  settlementDelaySeconds: number;
};

const RAILS: Rail[] = ["LYPAY", "ACH", "INTERNAL", "BRANCH"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function RailParameterForm({
  current,
  calendars,
  timeZone,
  defaultFrom,
}: {
  current: RailFormCurrent[];
  calendars: Array<{ id: string; name: string }>;
  timeZone: string;
  /** Bank local `YYYY-MM-DDTHH:MM`. */
  defaultFrom: string;
}) {
  const t = useTranslations();
  const command = useCommand();
  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState<Rail>("LYPAY");
  const basis = (code: Rail) => current.find((entry) => entry.rail === code);
  const initial = basis("LYPAY");
  const [ceiling, setCeiling] = useState(initial?.ceilingMinor != null ? formatMinor(BigInt(initial.ceilingMinor), "LYD") : "");
  const [provenance, setProvenance] = useState(initial?.provenance ?? "DEMO_UNCONFIRMED");
  const [calendarId, setCalendarId] = useState(initial?.calendarId ?? calendars[0]?.id ?? "");
  const [openTime, setOpenTime] = useState(initial?.openLocalTime ?? "");
  const [cutoff, setCutoff] = useState(initial?.cutoffLocalTime ?? "");
  const [closedDays, setClosedDays] = useState(initial?.observesClosedDays ?? false);
  const [offlineStart, setOfflineStart] = useState(initial?.offlineStartLocalTime ?? "");
  const [offlineEnd, setOfflineEnd] = useState(initial?.offlineEndLocalTime ?? "");
  const [delay, setDelay] = useState(String(initial?.settlementDelaySeconds ?? 0));
  const [from, setFrom] = useState(defaultFrom);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  function loadRail(code: Rail) {
    const entry = basis(code);
    setRail(code);
    setCeiling(entry?.ceilingMinor != null ? formatMinor(BigInt(entry.ceilingMinor), "LYD") : "");
    setProvenance(entry?.provenance ?? "DEMO_UNCONFIRMED");
    setCalendarId(entry?.calendarId ?? calendars[0]?.id ?? "");
    setOpenTime(entry?.openLocalTime ?? "");
    setCutoff(entry?.cutoffLocalTime ?? "");
    setClosedDays(entry?.observesClosedDays ?? false);
    setOfflineStart(entry?.offlineStartLocalTime ?? "");
    setOfflineEnd(entry?.offlineEndLocalTime ?? "");
    setDelay(String(entry?.settlementDelaySeconds ?? 0));
    setErrors({});
  }

  async function submit() {
    const next: Record<string, string> = {};
    let perItemMinor: string | null = null;
    if (ceiling.trim() !== "") {
      try {
        const minor = parseUserAmount(ceiling, "LYD");
        if (minor <= 0n) next["ceiling"] = t("errors.fields.amountPositive");
        else perItemMinor = minor.toString();
      } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        next["ceiling"] = t("errors.fields.amountFormat");
      }
    }
    const time = (key: string, value: string) => {
      if (value !== "" && !TIME.test(value)) next[key] = t("errors.fields.invalid");
      return value === "" ? null : value;
    };
    const openLocalTime = time("open", openTime);
    const cutoffLocalTime = time("cutoff", cutoff);
    const offlineStartLocalTime = time("offlineStart", offlineStart);
    const offlineEndLocalTime = time("offlineEnd", offlineEnd);
    if ((offlineStartLocalTime === null) !== (offlineEndLocalTime === null)) next["offlineEnd"] = t("errors.fields.required");
    if (openLocalTime && cutoffLocalTime && openLocalTime >= cutoffLocalTime) next["cutoff"] = t("errors.fields.invalid");
    const seconds = Number.parseInt(delay, 10);
    if (!/^\d{1,5}$/.test(delay) || seconds > 86_400) next["delay"] = t("errors.fields.invalid");
    const [fromDate, fromTime] = from.split("T");
    if (!fromDate || !fromTime) next["from"] = t("errors.fields.dateInvalid");
    if (reason.trim().length < 3) next["reason"] = t("errors.fields.reasonLength");
    if (!calendarId) next["calendar"] = t("errors.fields.required");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const result = await command.run("/bank/rail-parameter-proposals", {
      body: {
        rail,
        currency: "LYD",
        perItemMinor,
        provenance,
        calendarId,
        openLocalTime,
        cutoffLocalTime,
        observesClosedDays: closedDays,
        offlineStartLocalTime,
        offlineEndLocalTime,
        settlementDelaySeconds: seconds,
        effectiveFrom: zonedInstant(fromDate as string, fromTime as string, timeZone).toISOString(),
        changeReason: reason.trim(),
      },
    });
    if (result.ok) {
      setDone(true);
      setOpen(false);
      setReason("");
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-3">
        {done ? <Callout tone="success" role="status" testId="rail-proposed">{t("bank.editor.submitted")}</Callout> : null}
        <div>
          <Button onClick={() => { setDone(false); setOpen(true); }} data-testid="propose-rail">
            {t("bank.rails.propose")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="rail-form">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="rail" label={t("bank.rails.rail")} required>
          <Select {...describe("rail", {})} value={rail} onChange={(event) => loadRail(event.target.value as Rail)}>
            {RAILS.map((code) => (
              <option key={code} value={code}>{t(`types.rail.${code}`)}</option>
            ))}
          </Select>
        </Field>
        <Field id="ceiling" label={`${t("bank.rails.ceiling")} (LYD)`} hint={t("bank.rails.ceilingHint")} error={errors["ceiling"]}>
          <AmountInput {...describe("ceiling", { hint: true, error: Boolean(errors["ceiling"]) })} value={ceiling} onChange={(event) => setCeiling(event.target.value)} />
        </Field>
        <Field id="provenance" label={t("bank.editor.provenance")} required>
          <Select {...describe("provenance", {})} value={provenance} onChange={(event) => setProvenance(event.target.value)}>
            <option value="DEMO_UNCONFIRMED">{t("types.provenance.DEMO_UNCONFIRMED")}</option>
            <option value="BANK_CONFIRMED">{t("types.provenance.BANK_CONFIRMED")}</option>
          </Select>
        </Field>
        <Field id="calendar" label={t("bank.rails.calendar")} required error={errors["calendar"]}>
          <Select {...describe("calendar", { error: Boolean(errors["calendar"]) })} value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
            ))}
          </Select>
        </Field>
        <Field id="open" label={t("bank.rails.open")} error={errors["open"]}>
          <Input {...describe("open", { error: Boolean(errors["open"]) })} type="time" value={openTime} onChange={(event) => setOpenTime(event.target.value)} />
        </Field>
        <Field id="cutoff" label={t("bank.rails.cutoff")} error={errors["cutoff"]}>
          <Input {...describe("cutoff", { error: Boolean(errors["cutoff"]) })} type="time" value={cutoff} onChange={(event) => setCutoff(event.target.value)} />
        </Field>
        <Field id="offlineStart" label={t("bank.rails.offlineStart")} error={errors["offlineStart"]}>
          <Input {...describe("offlineStart", { error: Boolean(errors["offlineStart"]) })} type="time" value={offlineStart} onChange={(event) => setOfflineStart(event.target.value)} />
        </Field>
        <Field id="offlineEnd" label={t("bank.rails.offlineEnd")} error={errors["offlineEnd"]}>
          <Input {...describe("offlineEnd", { error: Boolean(errors["offlineEnd"]) })} type="time" value={offlineEnd} onChange={(event) => setOfflineEnd(event.target.value)} />
        </Field>
        <Field id="delay" label={t("bank.rails.settlementDelay")} error={errors["delay"]}>
          <Input {...describe("delay", { error: Boolean(errors["delay"]) })} type="text" inputMode="numeric" dir="ltr" value={delay} onChange={(event) => setDelay(event.target.value.replace(/\D/g, "").slice(0, 5))} />
        </Field>
        <Field id="from" label={`${t("bank.rails.effectiveFrom")} — ${t("common.labels.bankTime", { zone: timeZone })}`} required error={errors["from"]}>
          <Input {...describe("from", { error: Boolean(errors["from"]) })} type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
      </div>
      <Checkbox id="closed-days" checked={closedDays} onChange={(event) => setClosedDays(event.target.checked)} label={t("bank.rails.closedDays")} />
      <Field id="rail-reason" label={t("bank.rails.reason")} required error={errors["reason"]}>
        <Textarea {...describe("rail-reason", { error: Boolean(errors["reason"]) })} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button onClick={submit} disabled={command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="submit-rail">
          {command.pending ? t("common.actions.working") : t("bank.rails.submit")}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={command.pending}>
          {t("common.actions.cancel")}
        </Button>
      </FormActions>
    </div>
  );
}
