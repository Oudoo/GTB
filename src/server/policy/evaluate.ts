/**
 * Pure policy evaluation (LIM-01, LIM-02, LIM-04, ADM-02). No I/O: the callers load the
 * effective agreement, rail parameters and current usage, and this module explains the result.
 *
 * The five levels are checked independently and ALL must pass:
 *   1. rail ceiling (per item; an unset ceiling fails closed, it is never "unlimited")
 *   2. module / transaction-type limits (per item, day, month; per-batch items)
 *   3. corporate limits (per module and overall, day and month)
 *   4. user limits (per item, day)
 *   5. approval matrix (how many independent checkers)
 * Amounts and item counts are never compared with each other. Limits count PRINCIPAL; the fee
 * only affects funds sufficiency (D08).
 */
import type { ErrorCode } from "@/contracts/errors";

export type LimitRuleData = Readonly<{
  scope: "TYPE" | "MODULE" | "CORPORATE";
  moduleId: string | null;
  transactionType: string | null;
  metric: "AMOUNT" | "ITEMS";
  period: "ITEM" | "DAY" | "MONTH" | "BATCH";
  currency: string | null;
  valueMinor: bigint | null;
  itemCount: number | null;
  provenance: "DEMO_UNCONFIRMED" | "BANK_CONFIRMED";
}>;

export type BandData = Readonly<{ minMinor: bigint; maxExclusiveMinor: bigint | null; checkerCount: number }>;

export type RailCeiling = Readonly<{ perItemMinor: bigint | null; provenance: "DEMO_UNCONFIRMED" | "BANK_CONFIRMED" }>;

/** Counter key: `${scopeKey}|${period}`. */
export type UsageSnapshot = ReadonlyMap<string, Readonly<{ consumedMinor: bigint; reservedMinor: bigint }>>;

export type Constraint = Readonly<{
  /** Error raised when this constraint fails. */
  code: ErrorCode;
  /** Which level: rail | type | module | corporate | user. */
  scope: "rail" | "type" | "module" | "corporate" | "user";
  metric: "AMOUNT" | "ITEMS";
  period: "ITEM" | "DAY" | "MONTH" | "BATCH";
  /** NULL when a required parameter is not configured. */
  limit: bigint | null;
  used: bigint;
  reserved: bigint;
  requested: bigint;
  remaining: bigint | null;
  passes: boolean;
  provenance: "DEMO_UNCONFIRMED" | "BANK_CONFIRMED" | null;
}>;

export const scopeKeys = {
  type: (moduleId: string, transactionType: string) => `TYPE:${moduleId}:${transactionType}`,
  module: (moduleId: string) => `MODULE:${moduleId}`,
  corporate: () => "CORPORATE",
  user: (principalKey: string) => `USER:${principalKey}`,
} as const;

export const counterKey = (scopeKey: string, period: "DAY" | "MONTH") => `${scopeKey}|${period}`;

export type LimitRequest = Readonly<{
  moduleId: string;
  transactionType: string;
  currency: string;
  /** Principal of each item (one entry for a single payment). */
  itemAmounts: readonly bigint[];
  /** Maker scope for user-level limits; NULL for a non-human principal (API credential). */
  userKey: string | null;
  userLimits: Readonly<{ perItemMinor: bigint | null; dailyMinor: bigint | null }>;
  /** NULL when the rail has no approved parameter row at all. */
  rail: RailCeiling | null;
  /** Whether a rail ceiling is required for this type (true for every R1 outgoing type). */
  railRequired: boolean;
  rules: readonly LimitRuleData[];
  usage: UsageSnapshot;
}>;

export type LimitEvaluation = Readonly<{ constraints: Constraint[]; passes: boolean; failure: Constraint | null }>;

const max = (values: readonly bigint[]) => values.reduce((a, b) => (b > a ? b : a), 0n);
const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n);

function amountConstraint(
  code: ErrorCode,
  scope: Constraint["scope"],
  period: Constraint["period"],
  limit: bigint | null,
  used: bigint,
  reserved: bigint,
  requested: bigint,
  provenance: Constraint["provenance"],
): Constraint {
  const remaining = limit === null ? null : limit - used - reserved;
  return {
    code,
    scope,
    metric: "AMOUNT",
    period,
    limit,
    used,
    reserved,
    requested,
    remaining,
    // Exact boundary is allowed: used + reserved + requested may EQUAL the limit.
    passes: limit !== null && used + reserved + requested <= limit,
    provenance,
  };
}

export function evaluateLimits(request: LimitRequest): LimitEvaluation {
  const constraints: Constraint[] = [];
  const largest = max(request.itemAmounts);
  const total = sum(request.itemAmounts);
  const items = BigInt(request.itemAmounts.length);
  const usageOf = (scopeKey: string, period: "DAY" | "MONTH") =>
    request.usage.get(counterKey(scopeKey, period)) ?? { consumedMinor: 0n, reservedMinor: 0n };
  const ruleFor = (scope: LimitRuleData["scope"], metric: LimitRuleData["metric"], period: LimitRuleData["period"]) =>
    request.rules.find(
      (rule) =>
        rule.scope === scope &&
        rule.metric === metric &&
        rule.period === period &&
        (scope === "CORPORATE" ||
          (rule.moduleId === request.moduleId && (scope === "MODULE" || rule.transactionType === request.transactionType))) &&
        (metric === "ITEMS" || rule.currency === request.currency),
    );

  // 1. Rail ceiling — unknown is not infinity.
  if (request.railRequired) {
    const ceiling = request.rail?.perItemMinor ?? null;
    constraints.push({
      ...amountConstraint(
        ceiling === null ? "RAIL_CONFIGURATION_REQUIRED" : "RAIL_LIMIT_EXCEEDED",
        "rail",
        "ITEM",
        ceiling,
        0n,
        0n,
        largest,
        request.rail?.provenance ?? null,
      ),
    });
  }

  // 2. Transaction-type and module limits.
  const typeItem = ruleFor("TYPE", "AMOUNT", "ITEM");
  if (typeItem) {
    constraints.push(amountConstraint("MODULE_LIMIT_EXCEEDED", "type", "ITEM", typeItem.valueMinor, 0n, 0n, largest, typeItem.provenance));
  }
  for (const period of ["DAY", "MONTH"] as const) {
    const typeRule = ruleFor("TYPE", "AMOUNT", period);
    if (typeRule) {
      const usage = usageOf(scopeKeys.type(request.moduleId, request.transactionType), period);
      constraints.push(
        amountConstraint("MODULE_LIMIT_EXCEEDED", "type", period, typeRule.valueMinor, usage.consumedMinor, usage.reservedMinor, total, typeRule.provenance),
      );
    }
    // 3a. Corporate total for this module.
    const moduleRule = ruleFor("MODULE", "AMOUNT", period);
    if (moduleRule) {
      const usage = usageOf(scopeKeys.module(request.moduleId), period);
      constraints.push(
        amountConstraint("MODULE_LIMIT_EXCEEDED", "module", period, moduleRule.valueMinor, usage.consumedMinor, usage.reservedMinor, total, moduleRule.provenance),
      );
    }
  }
  for (const scope of ["TYPE", "MODULE"] as const) {
    const batchItems = ruleFor(scope, "ITEMS", "BATCH");
    if (batchItems && batchItems.itemCount !== null) {
      const limit = BigInt(batchItems.itemCount);
      constraints.push({
        code: "BATCH_ROW_CAP_EXCEEDED",
        scope: scope === "TYPE" ? "type" : "module",
        metric: "ITEMS",
        period: "BATCH",
        limit,
        used: 0n,
        reserved: 0n,
        requested: items,
        remaining: limit,
        passes: items <= limit,
        provenance: batchItems.provenance,
      });
    }
  }

  // 3b. Overall corporate limits across all modules.
  for (const period of ["DAY", "MONTH"] as const) {
    const rule = ruleFor("CORPORATE", "AMOUNT", period);
    if (rule) {
      const usage = usageOf(scopeKeys.corporate(), period);
      constraints.push(
        amountConstraint(
          period === "DAY" ? "CORPORATE_DAILY_LIMIT_EXCEEDED" : "CORPORATE_MONTHLY_LIMIT_EXCEEDED",
          "corporate",
          period,
          rule.valueMinor,
          usage.consumedMinor,
          usage.reservedMinor,
          total,
          rule.provenance,
        ),
      );
    }
  }

  // 4. User limits. A human maker with no allowance cannot move money (fail closed).
  if (request.userKey !== null) {
    constraints.push(amountConstraint("USER_LIMIT_EXCEEDED", "user", "ITEM", request.userLimits.perItemMinor, 0n, 0n, largest, null));
    const usage = usageOf(scopeKeys.user(request.userKey), "DAY");
    constraints.push(
      amountConstraint("USER_LIMIT_EXCEEDED", "user", "DAY", request.userLimits.dailyMinor, usage.consumedMinor, usage.reservedMinor, total, null),
    );
  }

  const failure = constraints.find((constraint) => !constraint.passes) ?? null;
  return { constraints, passes: failure === null, failure };
}

/**
 * Band lookup: inclusive minimum, exclusive maximum. Returns null when no band covers the
 * amount — the caller must fail closed (APPROVAL_POLICY_UNAVAILABLE), never assume zero.
 */
export function bandFor(amountMinor: bigint, bands: readonly BandData[]): BandData | null {
  return (
    bands.find((band) => amountMinor >= band.minMinor && (band.maxExclusiveMinor === null || amountMinor < band.maxExclusiveMinor)) ??
    null
  );
}

/**
 * Checkers required = the stronger of the bank floor and the corporate's own rule. A corporate
 * rule can raise the count but can never lower the bank floor, and a missing corporate band
 * falls back to the bank floor (ADM-02). R1 always needs at least one independent checker (D07).
 */
export function requiredCheckers(
  amountMinor: bigint,
  bankBands: readonly BandData[],
  corporateBands: readonly BandData[],
): number | null {
  const bank = bandFor(amountMinor, bankBands);
  if (!bank) return null;
  const corporate = bandFor(amountMinor, corporateBands);
  return Math.max(1, bank.checkerCount, corporate?.checkerCount ?? 0);
}

/** A corporate rule set is valid only if it never asks for fewer checkers than the bank floor. */
export function weakensBankFloor(corporateBands: readonly BandData[], bankBands: readonly BandData[]): boolean {
  // Compare at every band boundary of either set: counts are piecewise constant between them.
  const points = new Set<bigint>([0n]);
  for (const band of [...corporateBands, ...bankBands]) {
    points.add(band.minMinor);
    if (band.maxExclusiveMinor !== null) points.add(band.maxExclusiveMinor);
  }
  for (const point of points) {
    const bank = bandFor(point, bankBands);
    const corporate = bandFor(point, corporateBands);
    if (bank && corporate && corporate.checkerCount < bank.checkerCount) return true;
  }
  return false;
}

export type FeeQuote = Readonly<{ perItemMinor: bigint; totalMinor: bigint }>;

/** Fixed fee per child transfer. NULL tariff = not configured (blocks); 0 = explicit zero. */
export function quoteFee(perItemMinor: bigint | null, items: number): FeeQuote | null {
  if (perItemMinor === null) return null;
  return { perItemMinor, totalMinor: perItemMinor * BigInt(items) };
}

export function constraintToJson(constraint: Constraint) {
  return {
    code: constraint.code,
    scope: constraint.scope,
    metric: constraint.metric,
    period: constraint.period,
    limit: constraint.limit?.toString() ?? null,
    used: constraint.used.toString(),
    reserved: constraint.reserved.toString(),
    requested: constraint.requested.toString(),
    remaining: constraint.remaining?.toString() ?? null,
    passes: constraint.passes,
    provenance: constraint.provenance,
  };
}
