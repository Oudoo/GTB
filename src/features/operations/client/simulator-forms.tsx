"use client";

/** Sandbox simulator controls. Every one of them is a fixture switch, audited on the server. */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { AmountInput, Field, Input, Select, describe } from "@/components/ui/form";
import { Button } from "@/components/ui/primitives";
import { MoneyError, parseUserAmount } from "@/contracts/money";

function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const t = useTranslations("ops.sim");
  return (
    <Field id={id} label={t("reason")} required className="min-w-[14rem] flex-1">
      <Input {...describe(id, {})} value={value} maxLength={200} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

export function ClockForm() {
  const t = useTranslations("ops.sim");
  const common = useTranslations("common");
  const command = useCommand();
  const [minutes, setMinutes] = useState("60");
  const [reason, setReason] = useState("");
  const value = Number.parseInt(minutes, 10);
  const valid = /^\d{1,5}$/.test(minutes) && value >= 1 && value <= 86_400 && reason.trim().length >= 3;
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const result = await command.run("/bank/simulator/clock", { body: { advanceMinutes: value, reason: reason.trim() } });
        if (result.ok) setReason("");
      }}
    >
      <Field id="advance" label={t("advance")} required className="w-40">
        <Input {...describe("advance", {})} type="text" inputMode="numeric" dir="ltr" value={minutes} onChange={(event) => setMinutes(event.target.value.replace(/\D/g, "").slice(0, 5))} />
      </Field>
      <ReasonField id="clock-reason" value={reason} onChange={setReason} />
      <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} data-testid="advance-clock">
        {command.pending ? common("actions.working") : t("advanceAction")}
      </Button>
      <div className="basis-full"><ProblemAlert failure={command.failure} onCheck={command.checkServer} /></div>
    </form>
  );
}

export function AvailabilityToggle({ target, offline }: { target: "CORE" | "LYPAY" | "ACH"; offline: boolean }) {
  const t = useTranslations("ops.sim");
  const command = useCommand();
  return (
    <span className="flex flex-col items-end gap-2">
      <Button
        variant={offline ? "primary" : "danger"}
        disabled={command.pending || command.unknownOutcome}
        data-testid={`toggle-${target}`}
        onClick={() => command.run("/bank/simulator/availability", { body: { target, offline: !offline, reason: offline ? "Bring back online" : "Demonstrate an outage" } })}
      >
        {offline ? t("setOnline") : t("setOffline")}
      </Button>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
    </span>
  );
}

export function FaultForm() {
  const t = useTranslations("ops.sim");
  const common = useTranslations("common");
  const command = useCommand();
  const [reference, setReference] = useState("");
  const [fault, setFault] = useState("TIMEOUT_AFTER_BOOKING");
  const [reason, setReason] = useState("");
  const valid = /^AQ[0-9A-F]{32}A\d{1,2}$/.test(reference.trim().toUpperCase()) && reason.trim().length >= 3;
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const result = await command.run("/bank/simulator/faults", { body: { executionReference: reference.trim().toUpperCase(), fault, uses: 1, reason: reason.trim() } });
        if (result.ok) {
          setReference("");
          setReason("");
        }
      }}
    >
      <Field id="fault-reference" label={t("executionReference")} required className="min-w-[18rem] flex-1">
        <Input {...describe("fault-reference", {})} value={reference} dir="ltr" maxLength={64} autoComplete="off" onChange={(event) => setReference(event.target.value)} />
      </Field>
      <Field id="fault-kind" label={t("fault")} required>
        <Select {...describe("fault-kind", {})} value={fault} onChange={(event) => setFault(event.target.value)}>
          {(["TIMEOUT_AFTER_BOOKING", "TIMEOUT_BEFORE_PROCESSING", "REJECT"] as const).map((entry) => (
            <option key={entry} value={entry}>{t(`faultKind.${entry}`)}</option>
          ))}
        </Select>
      </Field>
      <ReasonField id="fault-reason" value={reason} onChange={setReason} />
      <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} data-testid="arm-fault">
        {command.pending ? common("actions.working") : t("arm")}
      </Button>
      <div className="basis-full"><ProblemAlert failure={command.failure} onCheck={command.checkServer} /></div>
    </form>
  );
}

export function OverlayForm({ defaultDate }: { defaultDate: string }) {
  const t = useTranslations("ops.sim");
  const recon = useTranslations("ops.recon");
  const common = useTranslations("common");
  const command = useCommand();
  const [date, setDate] = useState(defaultDate);
  const [reference, setReference] = useState("");
  const [kind, setKind] = useState<"HIDE" | "DUPLICATE" | "AMOUNT_OVERRIDE">("HIDE");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  let amountMinor: string | null = null;
  if (kind === "AMOUNT_OVERRIDE") {
    try {
      const minor = parseUserAmount(amount, "LYD");
      amountMinor = minor > 0n ? minor.toString() : null;
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
    }
  }
  const valid = Boolean(date) && reference.trim().length >= 4 && reason.trim().length >= 3 && (kind !== "AMOUNT_OVERRIDE" || amountMinor !== null);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const result = await command.run("/bank/simulator/recon-overlays", {
          body: { businessDate: date, executionReference: reference.trim().toUpperCase(), kind, ...(amountMinor ? { amountMinor } : {}), reason: reason.trim() },
        });
        if (result.ok) {
          setReference("");
          setReason("");
          setAmount("");
        }
      }}
    >
      <Field id="overlay-date" label={recon("businessDate")} required>
        <Input {...describe("overlay-date", {})} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </Field>
      <Field id="overlay-reference" label={t("executionReference")} required className="min-w-[18rem] flex-1">
        <Input {...describe("overlay-reference", {})} value={reference} dir="ltr" maxLength={64} autoComplete="off" onChange={(event) => setReference(event.target.value)} />
      </Field>
      <Field id="overlay-kind" label={t("fault")} required>
        <Select {...describe("overlay-kind", {})} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          {(["HIDE", "DUPLICATE", "AMOUNT_OVERRIDE"] as const).map((entry) => (
            <option key={entry} value={entry}>{t(`overlayKind.${entry}`)}</option>
          ))}
        </Select>
      </Field>
      {kind === "AMOUNT_OVERRIDE" ? (
        <Field id="overlay-amount" label={t("overlayAmount")} required className="w-44">
          <AmountInput {...describe("overlay-amount", {})} value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
      ) : null}
      <ReasonField id="overlay-reason" value={reason} onChange={setReason} />
      <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} data-testid="add-overlay">
        {command.pending ? common("actions.working") : t("addOverlay")}
      </Button>
      <div className="basis-full"><ProblemAlert failure={command.failure} onCheck={command.checkServer} /></div>
    </form>
  );
}

export function RemoveButton({ path }: { path: string }) {
  const t = useTranslations("ops.sim");
  const command = useCommand();
  return (
    <Button variant="ghost" disabled={command.pending || command.unknownOutcome} onClick={() => command.run(path, { body: {} })}>
      {t("remove")}
    </Button>
  );
}
