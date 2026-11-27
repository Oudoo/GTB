import { useTranslations } from "next-intl";
import { Badge, type Tone } from "./primitives";

/**
 * Status vocabulary (document 05): green only for a confirmed final outcome, amber for
 * pending/action required, blue for informational, red for failure. Colour is always paired
 * with the status text.
 */
const TONES: Record<string, Tone> = {
  // final, confirmed
  SETTLED: "success",
  POSTED: "success",
  COMPLETED: "success",
  EFFECTIVE: "success",
  ACTIVE: "success",
  READY: "success",
  DELIVERED: "success",
  MATCHED: "success",
  VALID: "success",
  SUCCEEDED: "success",
  // waiting or needs attention
  PENDING_APPROVAL: "warning",
  PENDING: "warning",
  PENDING_MANAGER: "warning",
  PENDING_POSTING: "warning",
  ACCEPTED_PENDING_CLEARING: "warning",
  STATUS_UNKNOWN: "warning",
  PARTIALLY_COMPLETED: "warning",
  SUSPENDED: "warning",
  CLOSE_MATCH: "warning",
  INVITED: "warning",
  NOT_YET_EFFECTIVE: "warning",
  DUPLICATE: "warning",
  // in motion, informational
  APPROVED: "info",
  SCHEDULED: "info",
  QUEUED: "info",
  PROCESSING: "info",
  SUBMITTED: "info",
  VALIDATING: "info",
  RUNNING: "info",
  DRAFT: "neutral",
  // negative
  FAILED: "danger",
  REJECTED: "danger",
  RETURNED: "danger",
  MISMATCH: "danger",
  NOT_FOUND: "danger",
  INVALID: "danger",
  DEAD: "danger",
  FROZEN: "danger",
  // closed without effect
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  SUPERSEDED: "neutral",
  WITHDRAWN: "neutral",
  CLOSED: "neutral",
  NONE: "neutral",
  UNCHECKED: "neutral",
};

export type StatusFamily =
  | "payment"
  | "batch"
  | "row"
  | "validation"
  | "approval"
  | "agreement"
  | "agreementVersion"
  | "governance"
  | "deposit"
  | "membership"
  | "account"
  | "report"
  | "job"
  | "webhookDelivery"
  | "match";

export function StatusBadge({ family, state }: { family: StatusFamily; state: string }) {
  const t = useTranslations("status");
  const key = `${family}.${state}` as Parameters<typeof t>[0];
  return (
    <span data-testid="status" data-state={state}>
      <Badge tone={TONES[state] ?? "neutral"}>{t.has(key) ? t(key) : state}</Badge>
    </span>
  );
}

export function statusTone(state: string): Tone {
  return TONES[state] ?? "neutral";
}
