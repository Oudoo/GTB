/**
 * In-app alerts (ALT-01). A notification belongs to one recipient and carries redacted
 * parameters only. Alert rules are evaluated by the worker; the event key of a notification is
 * unique per rule and window, so two workers or a retried job produce exactly one alert.
 */
import { DomainError, notFound } from "@/contracts/errors";
import { minorToJson, type MoneyJson } from "@/contracts/money";
import { businessDateOf, localDateToDbDate, monthStart } from "@/lib/calendar";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { requireCorporate, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { permissionsForRoles } from "@/server/auth/permissions";
import { inTx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { loadAgreementStatus } from "@/server/domain/agreements/policy";
import { notify } from "@/server/notifications/notify";
import { emitEvent } from "@/server/outbox";
import type { AlertRule, Notification } from "@/generated/prisma/client";

export type NotificationView = { id: string; kind: string; params: Record<string, string | number | boolean | null>; linkPath: string | null; read: boolean; createdAt: string };

const view = (row: Notification): NotificationView => ({ id: row.id, kind: row.kind, params: (row.params ?? {}) as NotificationView["params"], linkPath: row.linkPath, read: row.readAt !== null, createdAt: row.createdAt.toISOString() });

/** Own alerts in the current workspace. A person never reads another person's alerts. */
export async function listNotifications(deps: Deps, ctx: AuthContext, query: { unread?: "true" | "false" | undefined; cursor?: string | undefined; limit?: number | undefined } = {}): Promise<{ items: NotificationView[]; nextCursor: string | null; unreadCount: number }> {
  const person = requirePerson(ctx);
  const scope = { recipientPersonId: person.personId, bankId: ctx.bankId, corporateId: ctx.corporateId };
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const rows = await deps.db.notification.findMany({ where: { ...scope, ...(query.unread === "true" ? { readAt: null } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
  const page = rows.slice(0, limit);
  return { items: page.map(view), nextCursor: rows.length > limit ? (page[page.length - 1] as Notification).id : null, unreadCount: await deps.db.notification.count({ where: { ...scope, readAt: null } }) };
}

export async function getNotification(deps: Deps, ctx: AuthContext, notificationId: string): Promise<NotificationView> {
  const person = requirePerson(ctx);
  const row = await deps.db.notification.findFirst({ where: { id: notificationId, recipientPersonId: person.personId } });
  if (!row) throw notFound();
  return view(row);
}

export async function markNotificationRead(deps: Deps, ctx: AuthContext, notificationId: string): Promise<void> {
  const person = requirePerson(ctx);
  const updated = await deps.db.notification.updateMany({ where: { id: notificationId, recipientPersonId: person.personId }, data: { readAt: deps.clock.now() } });
  if (updated.count !== 1) throw notFound();
}

export type AlertRuleView = { id: string; kind: AlertRule["kind"]; account: { id: string; name: string; nameAr: string; maskedNumber: string } | null; threshold: MoneyJson | null; thresholdPercent: number | null; usagePeriod: string | null; active: boolean };

export async function listAlertRules(deps: Deps, ctx: AuthContext): Promise<AlertRuleView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "alerts.read");
  const rules = await deps.db.alertRule.findMany({ where: { corporateId: corporateCtx.corporateId }, orderBy: { createdAt: "asc" } });
  const accounts = await deps.db.account.findMany({ where: { id: { in: rules.map((rule) => rule.accountId).filter((id): id is string => id !== null) } }, select: { id: true, name: true, nameAr: true, maskedNumber: true } });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return rules
    .filter((rule) => rule.accountId === null || corporateCtx.grants.get(rule.accountId)?.read === true)
    .map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      account: rule.accountId ? (accountById.get(rule.accountId) ?? null) : null,
      threshold: rule.thresholdMinor !== null && rule.currency ? minorToJson(rule.thresholdMinor, rule.currency) : null,
      thresholdPercent: rule.thresholdBps !== null ? rule.thresholdBps / 100 : null,
      usagePeriod: rule.usagePeriod,
      active: rule.active,
    }));
}

/** Members who may see alerts for this rule: the alert permission and, for an account rule, read access to it. */
async function recipientsOf(deps: Deps, rule: AlertRule): Promise<string[]> {
  const members = await deps.db.membership.findMany({ where: { corporateId: rule.corporateId, status: "ACTIVE", person: { status: "ACTIVE" } }, include: { grants: true } });
  return [
    ...new Set(
      members
        .filter((member) => permissionsForRoles(member.roles).has("alerts.read") && (rule.accountId === null || member.grants.some((grant) => grant.accountId === rule.accountId && grant.canRead)))
        .map((member) => member.personId),
    ),
  ];
}

/**
 * Evaluate every active rule once. Returns how many rules are currently in breach and were
 * notified in THIS call for the first time in their window.
 */
export async function evaluateAlertRules(deps: Deps): Promise<number> {
  const rules = await deps.db.alertRule.findMany({ where: { active: true }, orderBy: { createdAt: "asc" }, take: 500 });
  const now = deps.clock.now();
  const today = businessDateOf(now, deps.timeZone);
  let raised = 0;
  for (const rule of rules) {
    try {
      let eventKey: string | null = null;
      let kind = "";
      let params: Record<string, string | number> = {};
      let linkPath = "/accounts";
      if (rule.kind === "LOW_BALANCE" && rule.accountId && rule.thresholdMinor !== null) {
        const account = await deps.db.account.findUnique({ where: { id: rule.accountId }, include: { corporate: { include: { bank: { select: { code: true } } } } } });
        if (!account || account.status !== "ACTIVE") continue;
        const balance = await deps.core.getBalance({ bankCode: account.corporate.bank.code, correlationId: `alert_${rule.id}` }, account.coreAccountRef);
        if (balance.availableMinor >= rule.thresholdMinor) continue;
        // One alert per rule and business day while the balance stays below the threshold.
        eventKey = `alert:${rule.id}:${today}`;
        kind = "alert.lowBalance";
        params = { account: account.maskedNumber };
      } else if (rule.kind === "LIMIT_USAGE" && rule.thresholdBps !== null && rule.usageScopeKey && rule.usagePeriod) {
        const status = await loadAgreementStatus(deps.db, rule.corporateId, now);
        const period = rule.usagePeriod === "MONTH" ? "MONTH" : "DAY";
        const limit = status.policy?.rules.find((entry) => entry.scope === "CORPORATE" && entry.metric === "AMOUNT" && entry.period === period)?.valueMinor ?? null;
        if (rule.usageScopeKey !== "CORPORATE" || limit === null || limit <= 0n) continue;
        const windowStart = period === "MONTH" ? monthStart(today) : today;
        const counter = await deps.db.usageCounter.findFirst({ where: { corporateId: rule.corporateId, scopeKey: "CORPORATE", period, windowStart: localDateToDbDate(windowStart) } });
        const used = (counter?.consumedMinor ?? 0n) + (counter?.reservedMinor ?? 0n);
        if (used * 10_000n < limit * BigInt(rule.thresholdBps)) continue;
        eventKey = `alert:${rule.id}:${period}:${windowStart}`;
        kind = "alert.limitUsage";
        params = { percent: rule.thresholdBps / 100, period };
        linkPath = "/limits";
      }
      if (!eventKey) continue;
      const key = eventKey;
      const recipients = await recipientsOf(deps, rule);
      const first = await inTx(
        deps.db,
        async (tx) => {
          // The unique (recipient, eventKey) pair makes a second evaluation a no-op.
          const before = await tx.notification.count({ where: { eventKey: key } });
          await notify(tx, { bankId: rule.bankId, corporateId: rule.corporateId, recipientPersonIds: recipients, eventKey: key, kind, params, linkPath });
          if (rule.kind === "LIMIT_USAGE") await emitEvent(tx, { bankId: rule.bankId, corporateId: rule.corporateId, type: "limit.threshold_reached", data: { resourceId: rule.id, state: "REACHED", ...params }, dedupKey: key, occurredAt: now });
          return before === 0 && recipients.length > 0;
        },
        { skipIdempotency: true },
      );
      if (first) raised += 1;
    } catch (error) {
      // No balance available right now: the rule is evaluated again on the next sweep.
      if (error instanceof CoreUnavailableError || (error instanceof DomainError && error.code === "ADAPTER_UNAVAILABLE")) continue;
      throw error;
    }
  }
  return raised;
}
