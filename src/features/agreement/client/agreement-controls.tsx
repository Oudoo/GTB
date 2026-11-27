"use client";

/**
 * Emergency stop and restore proposal for one corporate agreement (GOV-006).
 * Suspension is immediate and needs a reason plus the agreement version the person is looking
 * at (If-Match). Restoring is only a PROPOSAL: a different bank administrator must approve it.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { Field, Textarea, describe } from "@/components/ui/form";
import { Button } from "@/components/ui/primitives";

function ReasonForm({
  id,
  title,
  body,
  label,
  submitLabel,
  variant,
  testId,
  onSubmit,
  onClose,
  pending,
  blocked,
  children,
}: {
  id: string;
  title: string;
  body?: string;
  label: string;
  submitLabel: string;
  variant: "danger" | "primary";
  testId: string;
  onSubmit: (reason: string) => void;
  onClose: () => void;
  pending: boolean;
  blocked: boolean;
  children?: React.ReactNode;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState("");
  const valid = reason.trim().length >= 3 && reason.trim().length <= 500;
  const showError = reason.length > 0 && !valid;
  return (
    <form
      className="flex w-full flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(reason.trim());
      }}
    >
      <p className="font-semibold">{title}</p>
      {body ? <p className="text-sm text-muted">{body}</p> : null}
      <Field id={id} label={label} required error={showError ? t("errors.fields.reasonLength") : undefined}>
        <Textarea {...describe(id, { error: showError })} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </Field>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} disabled={!valid || pending || blocked} aria-busy={pending} data-testid={testId}>
          {pending ? t("common.actions.working") : submitLabel}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
      </div>
    </form>
  );
}

export function SuspendControl({ corporateId, version }: { corporateId: string; version: number }) {
  const t = useTranslations("bank.agreement");
  const command = useCommand();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="danger" onClick={() => setOpen(true)} data-testid="suspend-agreement">
        {t("suspend")}
      </Button>
    );
  }
  return (
    <ReasonForm
      id="suspend-reason"
      title={t("suspendTitle")}
      body={t("suspendBody")}
      label={t("suspendReason")}
      submitLabel={t("suspend")}
      variant="danger"
      testId="confirm-suspend"
      pending={command.pending}
      blocked={command.unknownOutcome}
      onClose={() => setOpen(false)}
      onSubmit={async (reason) => {
        const result = await command.run(`/bank/corporates/${corporateId}/suspend`, { body: { reason }, ifMatch: version });
        if (result.ok) setOpen(false);
      }}
    >
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
    </ReasonForm>
  );
}

export function RestoreControl({ corporateId }: { corporateId: string }) {
  const t = useTranslations("bank.agreement");
  const command = useCommand();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} data-testid="propose-restore">
        {t("restore")}
      </Button>
    );
  }
  return (
    <ReasonForm
      id="restore-reason"
      title={t("restore")}
      label={t("restoreReason")}
      submitLabel={t("restore")}
      variant="primary"
      testId="confirm-restore"
      pending={command.pending}
      blocked={command.unknownOutcome}
      onClose={() => setOpen(false)}
      onSubmit={async (reason) => {
        const result = await command.run(`/bank/corporates/${corporateId}/restore-proposals`, { body: { reason } });
        if (result.ok) setOpen(false);
      }}
    >
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
    </ReasonForm>
  );
}
