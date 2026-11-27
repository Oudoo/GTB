"use client";

/**
 * Actions on one execution (OPS-01). Inquiry only ASKS the core about the original reference.
 * A repair is a proposal: a different person decides it, and the server re-checks every rule.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { Field, FormActions, Input, Select, Textarea, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";

type Detail = { lastInquiryResult: string | null };
type Action = "RESUBMIT_SAME_REFERENCE" | "MARK_FAILED_UNPOSTED";

export function InquireButton({ executionId }: { executionId: string }) {
  const t = useTranslations("ops.detail");
  const common = useTranslations("common");
  const command = useCommand();
  const [outcome, setOutcome] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t("inquireHelp")}</p>
      <div>
        <Button
          disabled={command.pending || command.unknownOutcome}
          aria-busy={command.pending}
          data-testid="inquire"
          onClick={async () => {
            const result = await command.run<Detail>(`/bank/operations/executions/${executionId}/inquire`, { body: {} });
            if (result.ok) setOutcome(result.data.lastInquiryResult ?? "NOT_UNKNOWN");
          }}
        >
          {command.pending ? common("actions.working") : t("inquire")}
        </Button>
      </div>
      {outcome ? (
        <Callout tone={outcome === "BOOKED" ? "success" : outcome === "UNAVAILABLE" ? "warning" : "info"} role="status" testId="inquiry-outcome">
          <span data-outcome={outcome}>{t(`inquiryOutcome.${outcome}` as Parameters<typeof t>[0])}</span>
        </Callout>
      ) : null}
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
    </div>
  );
}

export function RepairForm({ executionId }: { executionId: string }) {
  const t = useTranslations("ops.detail");
  const errors = useTranslations("errors.fields");
  const common = useTranslations("common");
  const command = useCommand();
  const [action, setAction] = useState<Action>("MARK_FAILED_UNPOSTED");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const valid = reason.trim().length >= 3 && reason.trim().length <= 500;
  const showError = reason.length > 0 && !valid;
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="repair-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const result = await command.run(`/bank/operations/executions/${executionId}/repair-proposals`, {
          body: { action, reason: reason.trim(), ...(evidence.trim() ? { evidenceReference: evidence.trim() } : {}) },
        });
        if (result.ok) {
          setReason("");
          setEvidence("");
        }
      }}
    >
      <p className="text-sm text-muted">{t("repairHelp")}</p>
      <Field id="repair-action" label={t("action")} required hint={t(`actionHelp.${action}`)}>
        <Select {...describe("repair-action", { hint: true })} value={action} onChange={(event) => setAction(event.target.value as Action)}>
          <option value="MARK_FAILED_UNPOSTED">{t("actions.MARK_FAILED_UNPOSTED")}</option>
          <option value="RESUBMIT_SAME_REFERENCE">{t("actions.RESUBMIT_SAME_REFERENCE")}</option>
        </Select>
      </Field>
      <Field id="repair-reason" label={t("reason")} required error={showError ? errors("reasonLength") : undefined}>
        <Textarea {...describe("repair-reason", { error: showError })} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <Field id="repair-evidence" label={t("evidence")}>
        <Input {...describe("repair-evidence", {})} value={evidence} maxLength={64} dir="ltr" onChange={(event) => setEvidence(event.target.value)} />
      </Field>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="propose-repair">
          {command.pending ? common("actions.working") : t("propose")}
        </Button>
      </FormActions>
    </form>
  );
}
