/**
 * In-app notifications (ALT-01). A notification is written in the SAME transaction as the
 * event it reports and carries a unique event key per recipient, so a retried job or a replayed
 * request can never produce a second copy. Parameters are redacted identifiers, states and
 * aggregate amounts only — never salary or employee detail.
 */
import type { DbOrTx, Prisma } from "@/server/db/client";

export type NotificationInput = {
  bankId: string;
  corporateId: string | null;
  recipientPersonIds: readonly string[];
  /** Stable per event, e.g. `batch:<id>:COMPLETED`. Unique together with the recipient. */
  eventKey: string;
  /** Message key under the `alerts.kinds` catalogue. */
  kind: string;
  params?: Record<string, string | number | boolean | null>;
  /** Locale-less application path the recipient is allowed to open. */
  linkPath?: string | null;
};

export async function notify(db: DbOrTx, input: NotificationInput): Promise<void> {
  const recipients = [...new Set(input.recipientPersonIds)];
  if (recipients.length === 0) return;
  await db.notification.createMany({
    data: recipients.map((recipientPersonId) => ({
      bankId: input.bankId,
      corporateId: input.corporateId,
      recipientPersonId,
      eventKey: input.eventKey,
      kind: input.kind,
      params: (input.params ?? {}) as Prisma.InputJsonValue,
      linkPath: input.linkPath ?? null,
    })),
    skipDuplicates: true,
  });
}

/** Active members of a corporate holding any of the given roles (for fan-out). */
export async function corporateRecipients(db: DbOrTx, corporateId: string, roles: readonly string[]): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: { corporateId, status: "ACTIVE", roles: { hasSome: roles as never[] } },
    select: { personId: true },
  });
  return [...new Set(rows.map((row) => row.personId))];
}
