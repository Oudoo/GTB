/**
 * Policy evaluation for single payments: loads the effective agreement, rail parameters and
 * current usage, then delegates the arithmetic to the pure evaluator. Used by the advisory
 * preview, by submit, by the approval vote and again by the worker before release (APR-03).
 */
import type { ErrorCode } from "@/contracts/errors";
import { PAYMENT_TYPE_MODULE, PAYMENT_TYPE_RAIL, type SinglePaymentType } from "@/contracts/payments";
import { resolveExecutionWindow, usageWindows, withinSchedulingHorizon, type ExecutionWindow, type UsageWindows } from "@/server/calendar";
import type { DbOrTx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import {
  loadCorporateBands,
  loadRailPolicy,
  requireEffectivePolicy,
  requireEntitlement,
  type EffectivePolicy,
  type RailPolicy,
} from "@/server/domain/agreements/policy";
import {
  counterKey,
  evaluateLimits,
  quoteFee,
  requiredCheckers,
  scopeKeys,
  type Constraint,
} from "@/server/policy/evaluate";
import { countersFor, loadUsage, type CounterRef, type LimitLookup } from "@/server/policy/reservations";

export type PaymentFacts = Readonly<{
  bankId: string;
  corporateId: string;
  transactionType: SinglePaymentType;
  sourceAccountId: string;
  destinationAccountId: string | null;
  amountMinor: bigint;
  currency: string;
  /** NULL = execute as soon as the rail allows. */
  requestedExecuteAt: Date | null;
  /** `membership:<id>` for a human maker; NULL for an API credential. */
  userKey: string | null;
  userLimits: Readonly<{ perItemMinor: bigint | null; dailyMinor: bigint | null }>;
}>;

export type PaymentEvaluation = Readonly<{
  evaluatedAt: Date;
  policy: EffectivePolicy;
  railPolicy: RailPolicy | null;
  feeMinor: bigint | null;
  constraints: Constraint[];
  /** Constraints that depend on the execution day's cumulative usage (day/month windows). */
  cumulativeFailure: Constraint | null;
  /** Per-item, rail-ceiling and configuration failures: they can never pass on another day. */
  structuralFailure: Constraint | null;
  requiredCheckers: number | null;
  window: ExecutionWindow | null;
  windows: UsageWindows;
  counters: CounterRef[];
  limits: LimitLookup;
  horizonExceeded: boolean;
}>;

/** Limits that apply to each usage bucket, for the atomic reservation step. */
export function buildLimitLookup(
  policy: EffectivePolicy,
  facts: Pick<PaymentFacts, "currency" | "userKey" | "userLimits">,
  moduleId: string,
  transactionType: string,
): LimitLookup {
  const lookup = new Map<string, { limit: bigint | null; code: ErrorCode }>();
  for (const rule of policy.rules) {
    if (rule.metric !== "AMOUNT" || (rule.period !== "DAY" && rule.period !== "MONTH")) continue;
    if (rule.currency !== facts.currency) continue;
    if (rule.scope === "TYPE" && rule.moduleId === moduleId && rule.transactionType === transactionType) {
      lookup.set(counterKey(scopeKeys.type(moduleId, transactionType), rule.period), { limit: rule.valueMinor, code: "MODULE_LIMIT_EXCEEDED" });
    } else if (rule.scope === "MODULE" && rule.moduleId === moduleId) {
      lookup.set(counterKey(scopeKeys.module(moduleId), rule.period), { limit: rule.valueMinor, code: "MODULE_LIMIT_EXCEEDED" });
    } else if (rule.scope === "CORPORATE") {
      lookup.set(counterKey(scopeKeys.corporate(), rule.period), {
        limit: rule.valueMinor,
        code: rule.period === "DAY" ? "CORPORATE_DAILY_LIMIT_EXCEEDED" : "CORPORATE_MONTHLY_LIMIT_EXCEEDED",
      });
    }
  }
  if (facts.userKey !== null) {
    // A human maker without a daily allowance cannot reserve at all (fail closed).
    lookup.set(counterKey(scopeKeys.user(facts.userKey), "DAY"), { limit: facts.userLimits.dailyMinor, code: "USER_LIMIT_EXCEEDED" });
  }
  return lookup;
}

/**
 * Evaluate a payment against CURRENT policy. Throws AGREEMENT_INACTIVE / MODULE_DISABLED /
 * TRANSACTION_TYPE_DISABLED / ACCOUNT_NOT_ALLOWED when the agreement does not cover it;
 * everything quantitative is returned as explained constraints.
 */
export async function evaluatePayment(deps: Deps, db: DbOrTx, facts: PaymentFacts): Promise<PaymentEvaluation> {
  const now = deps.clock.now();
  const moduleId = PAYMENT_TYPE_MODULE[facts.transactionType];
  const rail = PAYMENT_TYPE_RAIL[facts.transactionType];
  const policy = await requireEffectivePolicy(db, facts.corporateId, now);
  requireEntitlement(policy, {
    moduleId,
    transactionType: facts.transactionType,
    debitAccountId: facts.sourceAccountId,
    ...(facts.destinationAccountId ? { creditAccountId: facts.destinationAccountId } : {}),
  });

  const railPolicy = await loadRailPolicy(db, facts.bankId, rail, facts.currency, now);
  const requested = facts.requestedExecuteAt ?? now;
  const window = railPolicy ? resolveExecutionWindow(requested, railPolicy.window, railPolicy.calendar) : null;
  const executeAt = window?.executeAt ?? requested;
  const windows = usageWindows(executeAt, deps.timeZone);
  const counters = countersFor({ moduleId, transactionType: facts.transactionType, userKey: facts.userKey });
  const usage = await loadUsage(db, { corporateId: facts.corporateId, currency: facts.currency, windows, counters });

  const evaluation = evaluateLimits({
    moduleId,
    transactionType: facts.transactionType,
    currency: facts.currency,
    itemAmounts: [facts.amountMinor],
    userKey: facts.userKey,
    userLimits: facts.userLimits,
    rail: railPolicy?.ceiling ?? null,
    railRequired: true,
    rules: policy.rules,
    usage,
  });
  const failing = evaluation.constraints.filter((constraint) => !constraint.passes);
  const fee = quoteFee(policy.fees.get(facts.transactionType) ?? null, 1);
  const corporateBands = await loadCorporateBands(db, facts.corporateId);

  return {
    evaluatedAt: now,
    policy,
    railPolicy,
    feeMinor: fee?.totalMinor ?? null,
    constraints: evaluation.constraints,
    structuralFailure: failing.find((constraint) => constraint.period === "ITEM" || constraint.period === "BATCH") ?? null,
    cumulativeFailure: failing.find((constraint) => constraint.period === "DAY" || constraint.period === "MONTH") ?? null,
    requiredCheckers: requiredCheckers(
      facts.amountMinor,
      policy.bankBands.get(facts.transactionType) ?? [],
      corporateBands.get(facts.transactionType) ?? [],
    ),
    window,
    windows,
    counters,
    limits: buildLimitLookup(policy, facts, moduleId, facts.transactionType),
    horizonExceeded: facts.requestedExecuteAt !== null && !withinSchedulingHorizon(now, facts.requestedExecuteAt, deps.timeZone),
  };
}
