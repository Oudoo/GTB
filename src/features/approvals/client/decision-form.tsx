"use client";

/**
 * Approve / reject one proposal. The decision is bound to the revision, payload hash and
 * request version that were rendered: if any of them changed, the server answers 412 and the
 * reviewer is asked to load the latest version and review again (document 05). There is no
 * approve-all.
 */
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { Field, FormActions, Textarea, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";
import { markBusy } from "@/pwa/busy-guard";

export function DecisionForm({
  approvalId,
  version,
  targetRevision,
  payloadHash,
  remainingAfterApprove,
}: {
  approvalId: string;
  version: number;
  targetRevision: number;
  payloadHash: string;
  remainingAfterApprove: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const command = useCommand();
  const [mode, setMode] = useState<"idle" | "reject">("idle");
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 500;

  // An open review blocks a forced app update/reload (PWA-07).
  useEffect(() => markBusy("approval-review"), []);

  const stale = command.failure?.code === "VERSION_CONFLICT" || command.failure?.code === "REAPPROVAL_REQUIRED";
  const body = { proposalVersion: targetRevision, proposalHash: payloadHash };

  return (
    <div className="flex flex-col gap-3" data-testid="decision-form">
      <p className="text-sm">{t("corp.approvals.detail.approveConfirm")}</p>
      <p className="text-sm text-muted">{t("corp.approvals.detail.approveRemaining", { count: remainingAfterApprove })}</p>

      {stale ? (
        <Callout tone="warning" role="alert" title={t("corp.approvals.detail.staleTitle")} testId="stale-proposal">
          <p>{command.failure?.code === "REAPPROVAL_REQUIRED" ? t("errors.REAPPROVAL_REQUIRED") : t("corp.approvals.detail.staleBody")}</p>
          <Button variant="secondary" className="mt-3" onClick={() => { command.reset(); router.refresh(); }}>
            {t("corp.approvals.detail.reload")}
          </Button>
        </Callout>
      ) : (
        <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      )}
      {command.unknownOutcome ? <Callout tone="warning" role="status">{t("common.offline.resultChecking")}</Callout> : null}

      {mode === "reject" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!reasonValid) return;
            await command.run(`/approvals/${approvalId}/reject`, { body: { ...body, reason: reason.trim() }, ifMatch: version });
          }}
        >
          <Field id="reject-reason" label={t("corp.approvals.detail.rejectReason")} hint={t("corp.approvals.detail.rejectHint")} required error={reason.length > 0 && !reasonValid ? t("errors.fields.reasonLength") : undefined}>
            <Textarea {...describe("reject-reason", { hint: true, error: reason.length > 0 && !reasonValid })} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} autoFocus />
          </Field>
          <FormActions>
            <Button type="submit" variant="danger" disabled={!reasonValid || command.pending || command.unknownOutcome || stale} data-testid="confirm-reject">
              {command.pending ? t("common.actions.working") : t("corp.approvals.detail.reject")}
            </Button>
            <Button variant="secondary" onClick={() => setMode("idle")} disabled={command.pending}>
              {t("common.actions.back")}
            </Button>
          </FormActions>
        </form>
      ) : (
        <FormActions>
          <Button
            disabled={command.pending || command.unknownOutcome || stale}
            aria-busy={command.pending}
            data-testid="approve"
            onClick={() => command.run(`/approvals/${approvalId}/approve`, { body, ifMatch: version })}
          >
            {command.pending ? t("common.actions.working") : t("corp.approvals.detail.approve")}
          </Button>
          <Button variant="secondary" disabled={command.pending || stale} onClick={() => setMode("reject")} data-testid="reject">
            {t("corp.approvals.detail.reject")}
          </Button>
        </FormActions>
      )}
    </div>
  );
}
