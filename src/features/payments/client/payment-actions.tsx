"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { CommandButton, ProblemAlert, useCommand } from "@/components/command";
import { Field, Textarea, describe } from "@/components/ui/form";
import { Button } from "@/components/ui/primitives";

/** State-aware actions for one payment. The server re-checks every one of them. */
export function PaymentActions({
  paymentId,
  version,
  actions,
}: {
  paymentId: string;
  version: number;
  actions: { submit: boolean; cancel: boolean; retryRelease: boolean };
}) {
  const t = useTranslations();
  const cancel = useCommand();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 500;

  if (!actions.submit && !actions.cancel && !actions.retryRelease) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="payment-actions">
      <div className="flex flex-wrap gap-2">
        {actions.submit ? (
          <CommandButton path={`/payments/${paymentId}/submit`} ifMatch={version} body={{}} testId="submit-draft">
            {t("corp.payments.detail.submitDraft")}
          </CommandButton>
        ) : null}
        {actions.retryRelease ? (
          <CommandButton path={`/payments/${paymentId}/retry-release`} ifMatch={version} testId="retry-release">
            {t("corp.payments.detail.retryRelease")}
          </CommandButton>
        ) : null}
        {actions.cancel && !cancelling ? (
          <Button variant="secondary" onClick={() => setCancelling(true)} data-testid="cancel-payment">
            {t("corp.payments.detail.cancel")}
          </Button>
        ) : null}
      </div>
      {cancelling ? (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!reasonValid) return;
            const result = await cancel.run(`/payments/${paymentId}/cancel`, { body: { reason: reason.trim() }, ifMatch: version });
            if (result.ok) setCancelling(false);
          }}
        >
          <p className="font-semibold">{t("corp.payments.detail.cancelConfirm")}</p>
          <Field id="cancel-reason" label={t("corp.payments.detail.cancelReason")} required error={reason.length > 0 && !reasonValid ? t("errors.fields.reasonLength") : undefined}>
            <Textarea {...describe("cancel-reason", { error: reason.length > 0 && !reasonValid })} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
          </Field>
          <ProblemAlert failure={cancel.failure} onCheck={cancel.checkServer} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={!reasonValid || cancel.pending || cancel.unknownOutcome} data-testid="confirm-cancel">
              {cancel.pending ? t("common.actions.working") : t("corp.payments.detail.cancel")}
            </Button>
            <Button variant="secondary" onClick={() => setCancelling(false)}>
              {t("common.actions.back")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
