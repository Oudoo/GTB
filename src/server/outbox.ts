/**
 * Transactional outbox (EVT-01). An event row is written in the SAME transaction as the state
 * change it describes; the worker later turns it into signed webhook deliveries and in-app
 * notifications. A subscriber failure can therefore never roll back or lose a settlement.
 *
 * Payloads are safe aggregates only: ids, references, states, totals and counts. They never
 * contain employee names, account numbers of payroll rows or per-row salary amounts.
 */
import type { DbOrTx, Prisma } from "@/server/db/client";
import { enqueueJob } from "@/server/jobs/queue";

export const OUTBOX_EVENT_TYPES = ["payment.status_changed", "batch.finished", "deposit.posted", "limit.threshold_reached"] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export const JOB_OUTBOX_PUBLISH = "outbox.publish";

export async function emitEvent(
  tx: DbOrTx,
  event: {
    bankId: string;
    corporateId: string | null;
    type: OutboxEventType;
    /** `{ resourceId, state, ...safeAggregate }` */
    data: Prisma.InputJsonObject;
    /** Stable per business fact, so a retried transaction cannot emit it twice. */
    dedupKey: string;
    correlationId?: string | null;
    occurredAt?: Date;
  },
): Promise<void> {
  await tx.outboxEvent.createMany({
    data: [
      {
        bankId: event.bankId,
        corporateId: event.corporateId,
        type: event.type,
        payload: event.data,
        dedupKey: event.dedupKey,
        correlationId: event.correlationId ?? null,
        ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      },
    ],
    skipDuplicates: true,
  });
  await enqueueJob(tx, { type: JOB_OUTBOX_PUBLISH, payload: {}, dedupKey: "outbox-publish", bankId: event.bankId });
}
