"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { Field, Input, Select, Textarea, describe } from "@/components/ui/form";
import { Button } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";

const DISPOSITIONS = ["INVESTIGATING", "EXPLAINED", "ESCALATED", "CORRECTED_AT_SOURCE"] as const;

export function StartRunForm({ defaultDate, maxDate }: { defaultDate: string; maxDate: string }) {
  const t = useTranslations("ops.recon");
  const common = useTranslations("common");
  const router = useRouter();
  const command = useCommand();
  const [date, setDate] = useState(defaultDate);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await command.run<{ run: { id: string } }>("/bank/reconciliation-runs", { body: { businessDate: date } }, { refresh: false });
        if (result.ok) {
          router.push(`/bank/reconciliation/${result.data.run.id}`);
          router.refresh();
        }
      }}
    >
      <Field id="recon-date" label={t("businessDate")} required>
        <Input {...describe("recon-date", {})} type="date" value={date} max={maxDate} required onChange={(event) => setDate(event.target.value)} />
      </Field>
      <Button type="submit" disabled={!date || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="start-recon">
        {command.pending ? common("actions.working") : t("startRun")}
      </Button>
      <div className="basis-full">
        <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      </div>
    </form>
  );
}

export function ResolutionForm({ breakId }: { breakId: string }) {
  const t = useTranslations("ops.recon");
  const detail = useTranslations("ops.detail");
  const errors = useTranslations("errors.fields");
  const common = useTranslations("common");
  const command = useCommand();
  const [open, setOpen] = useState(false);
  const [disposition, setDisposition] = useState<(typeof DISPOSITIONS)[number]>("INVESTIGATING");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const valid = reason.trim().length >= 3 && reason.trim().length <= 500;
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="open-resolution">
        {t("record")}
      </Button>
    );
  }
  return (
    <form
      className="flex w-full flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const result = await command.run(`/bank/reconciliation-breaks/${breakId}/resolution`, {
          body: { disposition, reason: reason.trim(), ...(evidence.trim() ? { evidenceReference: evidence.trim() } : {}) },
        });
        if (result.ok) {
          setOpen(false);
          setReason("");
          setEvidence("");
        }
      }}
    >
      <p className="text-sm text-muted">{t("resolutionNote")}</p>
      <Field id={`disposition-${breakId}`} label={t("disposition")} required>
        <Select {...describe(`disposition-${breakId}`, {})} value={disposition} onChange={(event) => setDisposition(event.target.value as (typeof DISPOSITIONS)[number])}>
          {DISPOSITIONS.map((entry) => (
            <option key={entry} value={entry}>{t(`dispositions.${entry}`)}</option>
          ))}
        </Select>
      </Field>
      <Field id={`reason-${breakId}`} label={detail("reason")} required error={reason.length > 0 && !valid ? errors("reasonLength") : undefined}>
        <Textarea {...describe(`reason-${breakId}`, { error: reason.length > 0 && !valid })} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <Field id={`evidence-${breakId}`} label={detail("evidence")}>
        <Input {...describe(`evidence-${breakId}`, {})} value={evidence} maxLength={64} dir="ltr" onChange={(event) => setEvidence(event.target.value)} />
      </Field>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} data-testid="save-resolution">
          {command.pending ? common("actions.working") : t("record")}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>{common("actions.cancel")}</Button>
      </div>
    </form>
  );
}
