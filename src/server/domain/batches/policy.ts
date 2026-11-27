/**
 * Policy evaluation for a batch (bulk or payroll): entitlement, row cap, rail ceiling and
 * per-item limits for every row, aggregate day/month limits for the total, the fee tariff per
 * child and the number of checkers the total requires. Used by the advisory figures at
 * acceptance, by submit, by the vote and again by the worker before release (APR-03).
 */
import { BATCH_MODULE, type BatchKind } from "@/contracts/batches";
import { resolveExecutionWindow, usageWindows, withinSchedulingHorizon, type ExecutionWindow, type UsageWindows } from "@/server/calendar";
import type { DbOrTx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { loadCorporateBands, loadRailPolicy, requireEffectivePolicy, requireEntitlement, type EffectivePolicy, type RailPolicy } from "@/server/domain/agreements/policy";
import { buildLimitLookup } from "@/server/domain/payments/policy";
import { HARD_ROW_CAP } from "@/server/files/tabular";
import { evaluateLimits, requiredCheckers, type Constraint } from "@/server/policy/evaluate";
import { countersFor, loadUsage, type CounterRef, type LimitLookup } from "@/server/policy/reservations";

export type BatchTransactionType = "BULK_CREDIT" | "PAYROLL_SALARY" | "PAYROLL_ALLOWANCE";

export type BatchFacts = Readonly<{
  bankId: string;
  corporateId: string;
  kind: BatchKind;
  rail: "LYPAY" | "ACH";
  sourceAccountId: string;
  currency: string;
  items: ReadonlyArray<{ transactionType: BatchTransactionType; amountMinor: bigint }>;
  /** NULL = execute as soon as the rail allows. */
  requestedExecuteAt: Date | null;
  userKey: string | null;
  userLimits: Readonly<{ perItemMinor: bigint | null; dailyMinor: bigint | null }>;
}>;

export type BatchEvaluation = Readonly<{
  evaluatedAt: Date;
  policy: EffectivePolicy;
  railPolicy: RailPolicy | null;
  /** Row cap of the agreement, inside the system-tested hard cap. */
  rowCap: number;
  totalMinor: bigint;
  /** Fee per child by transaction type; NULL = tariff not configured (blocks). */
  feeByType: ReadonlyMap<BatchTransactionType, bigint | null>;
  feeTotalMinor: bigint | null;
  constraints: Constraint[];
  structuralFailure: Constraint | null;
  cumulativeFailure: Constraint | null;
  requiredCheckers: number | null;
  window: ExecutionWindow | null;
  windows: UsageWindows;
  countersByType: ReadonlyMap<BatchTransactionType, CounterRef[]>;
  limits: LimitLookup;
  horizonExceeded: boolean;
}>;

/**
 * Evaluate a batch against CURRENT policy. Throws AGREEMENT_INACTIVE / MODULE_DISABLED /
 * TRANSACTION_TYPE_DISABLED / ACCOUNT_NOT_ALLOWED when the agreement does not cover it.
 */
export async function evaluateBatch(deps: Deps, db: DbOrTx, facts: BatchFacts): Promise<BatchEvaluation> {
  const now = deps.clock.now();
  const moduleId = BATCH_MODULE[facts.kind];
  const policy = await requireEffectivePolicy(db, facts.corporateId, now);
  const types = [...new Set(facts.items.map((item) => item.transactionType))];
  let entitlement = requireEntitlement(policy, { moduleId, debitAccountId: facts.sourceAccountId });
  for (const transactionType of types) entitlement = requireEntitlement(policy, { moduleId, transactionType, debitAccountId: facts.sourceAccountId });

  const railPolicy = await loadRailPolicy(db, facts.bankId, facts.rail, facts.currency, now);
  const requested = facts.requestedExecuteAt ?? now;
  const window = railPolicy ? resolveExecutionWindow(requested, railPolicy.window, railPolicy.calendar) : null;
  const windows = usageWindows(window?.executeAt ?? requested, deps.timeZone);

  const countersByType = new Map<BatchTransactionType, CounterRef[]>();
  const allCounters: CounterRef[] = [];
  for (const transactionType of types) {
    const counters = countersFor({ moduleId, transactionType, userKey: facts.userKey });
    countersByType.set(transactionType, counters);
    allCounters.push(...counters);
  }
  const usage = await loadUsage(db, { corporateId: facts.corporateId, currency: facts.currency, windows, counters: allCounters });
  const common = { moduleId, currency: facts.currency, userKey: facts.userKey, userLimits: facts.userLimits, rail: railPolicy?.ceiling ?? null, railRequired: true, rules: policy.rules, usage };

  // Per-type view: rail ceiling, per-item and type-level limits for that type's rows.
  const constraints: Constraint[] = [];
  for (const transactionType of types) {
    const amounts = facts.items.filter((item) => item.transactionType === transactionType).map((item) => item.amountMinor);
    const evaluation = evaluateLimits({ ...common, transactionType, itemAmounts: amounts });
    constraints.push(...evaluation.constraints.filter((constraint) => types.length === 1 || constraint.scope === "type" || constraint.scope === "rail" || (constraint.scope === "user" && constraint.period === "ITEM")));
  }
  if (types.length > 1) {
    // Module, corporate and user-day limits count the WHOLE batch, whatever the row types.
    const whole = evaluateLimits({ ...common, transactionType: types[0] as string, itemAmounts: facts.items.map((item) => item.amountMinor) });
    constraints.push(...whole.constraints.filter((constraint) => constraint.scope === "module" || constraint.scope === "corporate" || (constraint.scope === "user" && constraint.period !== "ITEM")));
  }

  const rowCap = Math.min(entitlement.rowCap ?? HARD_ROW_CAP, HARD_ROW_CAP);
  if (facts.items.length > rowCap) {
    constraints.push({
      code: "BATCH_ROW_CAP_EXCEEDED",
      scope: "module",
      metric: "ITEMS",
      period: "BATCH",
      limit: BigInt(rowCap),
      used: 0n,
      reserved: 0n,
      requested: BigInt(facts.items.length),
      remaining: BigInt(rowCap),
      passes: false,
      provenance: null,
    });
  }
  const failing = constraints.filter((constraint) => !constraint.passes);

  const feeByType = new Map<BatchTransactionType, bigint | null>();
  let feeTotal: bigint | null = 0n;
  for (const transactionType of types) {
    const fee = policy.fees.get(transactionType) ?? null;
    feeByType.set(transactionType, fee);
    const count = BigInt(facts.items.filter((item) => item.transactionType === transactionType).length);
    feeTotal = fee === null || feeTotal === null ? null : feeTotal + fee * count;
  }

  const total = facts.items.reduce((sum, item) => sum + item.amountMinor, 0n);
  const corporateBands = await loadCorporateBands(db, facts.corporateId);
  // The whole batch is one proposal: the strictest requirement of its row types applies.
  let checkers: number | null = 0;
  for (const transactionType of types) {
    const needed = requiredCheckers(total, policy.bankBands.get(transactionType) ?? [], corporateBands.get(transactionType) ?? []);
    checkers = needed === null || checkers === null ? null : Math.max(checkers, needed);
  }
  if (types.length === 0) checkers = null;

  const limits = new Map<string, { limit: bigint | null; code: Constraint["code"] }>();
  for (const transactionType of types) {
    for (const [key, value] of buildLimitLookup(policy, facts, moduleId, transactionType)) limits.set(key, value);
  }

  return {
    evaluatedAt: now,
    policy,
    railPolicy,
    rowCap,
    totalMinor: total,
    feeByType,
    feeTotalMinor: feeTotal,
    constraints,
    structuralFailure: failing.find((constraint) => constraint.period === "ITEM" || constraint.period === "BATCH") ?? null,
    cumulativeFailure: failing.find((constraint) => constraint.period === "DAY" || constraint.period === "MONTH") ?? null,
    requiredCheckers: checkers,
    window,
    windows,
    countersByType,
    limits,
    horizonExceeded: facts.requestedExecuteAt !== null && !withinSchedulingHorizon(now, facts.requestedExecuteAt, deps.timeZone),
  };
}
