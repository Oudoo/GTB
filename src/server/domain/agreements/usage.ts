/**
 * Limits and usage explanation (LIM-01/02, GOV-006): every applicable bucket with its unit,
 * business window, limit, consumed, reserved and remaining capacity, plus parameter provenance.
 */
import { minorToJson, type MoneyJson } from "@/contracts/money";
import { requireCorporate, requirePermission, type AuthContext } from "@/server/auth/context";
import { usageWindows } from "@/server/calendar";
import type { Deps } from "@/server/deps";
import { counterKey, scopeKeys } from "@/server/policy/evaluate";
import { loadUsage, type CounterRef } from "@/server/policy/reservations";
import { loadAgreementStatus, loadRailPolicy, type AgreementState } from "./policy";

export type UsageRow = {
  level: "TYPE" | "MODULE" | "CORPORATE" | "USER";
  moduleId: string | null;
  transactionType: string | null;
  metric: "AMOUNT" | "ITEMS";
  period: "ITEM" | "DAY" | "MONTH" | "BATCH";
  /** Business window start for DAY/MONTH rows. */
  windowStart: string | null;
  limit: MoneyJson | null;
  itemLimit: number | null;
  consumed: MoneyJson | null;
  reserved: MoneyJson | null;
  remaining: MoneyJson | null;
  provenance: "DEMO_UNCONFIRMED" | "BANK_CONFIRMED" | null;
};

export type RailRow = {
  rail: string;
  ceiling: MoneyJson | null;
  /** True when no ceiling is configured: the rail cannot be used (never "unlimited"). */
  blocked: boolean;
  provenance: "DEMO_UNCONFIRMED" | "BANK_CONFIRMED" | null;
  cutoffLocalTime: string | null;
  openLocalTime: string | null;
};

export async function getLimitsUsage(deps: Deps, ctx: AuthContext): Promise<{ state: AgreementState; businessTimeZone: string; windows: { day: string; month: string }; rows: UsageRow[]; rails: RailRow[] }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "limits.read");
  const now = deps.clock.now();
  const windows = usageWindows(now, deps.timeZone);
  const status = await loadAgreementStatus(deps.db, corporateCtx.corporateId, now);
  const rows: UsageRow[] = [];
  const currency = "LYD";

  if (status.policy) {
    const policy = status.policy;
    const userKey = corporateCtx.membershipId ? `membership:${corporateCtx.membershipId}` : null;
    const counters: CounterRef[] = [];
    for (const rule of policy.rules) {
      if (rule.period !== "DAY" && rule.period !== "MONTH") continue;
      const key =
        rule.scope === "TYPE"
          ? scopeKeys.type(rule.moduleId as string, rule.transactionType as string)
          : rule.scope === "MODULE"
            ? scopeKeys.module(rule.moduleId as string)
            : scopeKeys.corporate();
      counters.push({ scopeKey: key, period: rule.period });
    }
    if (userKey) counters.push({ scopeKey: scopeKeys.user(userKey), period: "DAY" });
    const usage = await loadUsage(deps.db, { corporateId: corporateCtx.corporateId, currency, windows, counters });

    for (const rule of policy.rules) {
      const scopeKey =
        rule.scope === "TYPE"
          ? scopeKeys.type(rule.moduleId as string, rule.transactionType as string)
          : rule.scope === "MODULE"
            ? scopeKeys.module(rule.moduleId as string)
            : scopeKeys.corporate();
      const windowed = rule.period === "DAY" || rule.period === "MONTH";
      const used = windowed ? usage.get(counterKey(scopeKey, rule.period as "DAY" | "MONTH")) : undefined;
      const limitMinor = rule.valueMinor;
      rows.push({
        level: rule.scope,
        moduleId: rule.moduleId,
        transactionType: rule.transactionType,
        metric: rule.metric,
        period: rule.period,
        windowStart: rule.period === "DAY" ? windows.day : rule.period === "MONTH" ? windows.month : null,
        limit: rule.metric === "AMOUNT" && limitMinor !== null ? minorToJson(limitMinor, rule.currency ?? currency) : null,
        itemLimit: rule.metric === "ITEMS" ? rule.itemCount : null,
        consumed: windowed ? minorToJson(used?.consumedMinor ?? 0n, currency) : null,
        reserved: windowed ? minorToJson(used?.reservedMinor ?? 0n, currency) : null,
        remaining:
          windowed && limitMinor !== null
            ? minorToJson(((r) => (r < 0n ? 0n : r))(limitMinor - (used?.consumedMinor ?? 0n) - (used?.reservedMinor ?? 0n)), currency)
            : null,
        provenance: rule.provenance,
      });
    }
    if (userKey) {
      const used = usage.get(counterKey(scopeKeys.user(userKey), "DAY"));
      const perItem = corporateCtx.userLimits.perItemMinor;
      const daily = corporateCtx.userLimits.dailyMinor;
      rows.push({
        level: "USER", moduleId: null, transactionType: null, metric: "AMOUNT", period: "ITEM", windowStart: null,
        limit: perItem !== null ? minorToJson(perItem, currency) : null, itemLimit: null, consumed: null, reserved: null, remaining: null, provenance: null,
      });
      rows.push({
        level: "USER", moduleId: null, transactionType: null, metric: "AMOUNT", period: "DAY", windowStart: windows.day,
        limit: daily !== null ? minorToJson(daily, currency) : null, itemLimit: null,
        consumed: minorToJson(used?.consumedMinor ?? 0n, currency),
        reserved: minorToJson(used?.reservedMinor ?? 0n, currency),
        remaining: daily !== null ? minorToJson(((r) => (r < 0n ? 0n : r))(daily - (used?.consumedMinor ?? 0n) - (used?.reservedMinor ?? 0n)), currency) : null,
        provenance: null,
      });
    }
  }

  const rails: RailRow[] = [];
  for (const rail of ["LYPAY", "ACH", "INTERNAL"]) {
    const policy = await loadRailPolicy(deps.db, corporateCtx.bankId, rail, currency, now);
    rails.push({
      rail,
      ceiling: policy?.ceiling.perItemMinor != null ? minorToJson(policy.ceiling.perItemMinor, currency) : null,
      blocked: !policy || policy.ceiling.perItemMinor === null,
      provenance: policy?.ceiling.provenance ?? null,
      cutoffLocalTime: policy?.window.cutoffLocalTime ?? null,
      openLocalTime: policy?.window.openLocalTime ?? null,
    });
  }
  return { state: status.state, businessTimeZone: deps.timeZone, windows, rows, rails };
}
