/**
 * Pure limit and approval-band rules (U-LIM-01..08, U-APR-01..03). No database, no clock.
 *
 * The amounts are the documented demo fixture of document 07: corporate LYD 30,000 a day and
 * 150,000 a month, a maker allowance of LYD 3,000 per item and 10,000 a day, one checker below
 * LYD 2,000 and two from LYD 2,000. All values are integer minor units (LYD has three decimals).
 *
 * U-APR-04 (the maker never votes) and U-APR-05 (a changed proposal invalidates votes) need the
 * approval tables and are proven against PostgreSQL in tests/integration (own proposal: I-05, I-08,
 * I-36; changed proposal: I-26).
 */
import { describe, expect, it } from "vitest";
import { validateBands } from "@/contracts/agreement";
import { usageWindows } from "@/server/calendar";
import {
  type BandData,
  type LimitRequest,
  type LimitRuleData,
  type UsageSnapshot,
  bandFor,
  constraintToJson,
  counterKey,
  evaluateLimits,
  quoteFee,
  requiredCheckers,
  scopeKeys,
  weakensBankFloor,
} from "@/server/policy/evaluate";
import { countersFor } from "@/server/policy/reservations";

const MODULE = "1.1";
const TYPE = "INSTANT";
const USER = "membership-a-maker";
const LYD = (units: number) => BigInt(units) * 1000n;

const rule = (
  scope: LimitRuleData["scope"],
  period: LimitRuleData["period"],
  valueMinor: bigint | null,
  extra: Partial<LimitRuleData> = {},
): LimitRuleData => ({
  scope,
  moduleId: scope === "CORPORATE" ? null : MODULE,
  transactionType: scope === "TYPE" ? TYPE : null,
  metric: "AMOUNT",
  period,
  currency: "LYD",
  valueMinor,
  itemCount: null,
  provenance: "DEMO_UNCONFIRMED",
  ...extra,
});

/** Every layer configured, each wide enough that a LYD 125 payment passes all of them. */
const RULES: readonly LimitRuleData[] = [
  rule("TYPE", "ITEM", LYD(5_000)),
  rule("TYPE", "DAY", LYD(20_000)),
  rule("TYPE", "MONTH", LYD(100_000)),
  rule("MODULE", "DAY", LYD(20_000)),
  rule("MODULE", "MONTH", LYD(100_000)),
  rule("CORPORATE", "DAY", LYD(30_000)),
  rule("CORPORATE", "MONTH", LYD(150_000)),
];

const usage = (entries: Record<string, [consumed: bigint, reserved: bigint]>): UsageSnapshot =>
  new Map(Object.entries(entries).map(([key, [consumedMinor, reservedMinor]]) => [key, { consumedMinor, reservedMinor }]));

const request = (overrides: Partial<LimitRequest> = {}): LimitRequest => ({
  moduleId: MODULE,
  transactionType: TYPE,
  currency: "LYD",
  itemAmounts: [LYD(125)],
  userKey: USER,
  userLimits: { perItemMinor: LYD(3_000), dailyMinor: LYD(10_000) },
  rail: { perItemMinor: LYD(10_000), provenance: "DEMO_UNCONFIRMED" },
  railRequired: true,
  rules: RULES,
  usage: new Map(),
  ...overrides,
});

const replaceRule = (scope: LimitRuleData["scope"], period: LimitRuleData["period"], valueMinor: bigint | null) =>
  RULES.map((existing) => (existing.scope === scope && existing.period === period && existing.metric === "AMOUNT" ? { ...existing, valueMinor } : existing));

const failureOf = (overrides: Partial<LimitRequest>) => {
  const evaluation = evaluateLimits(request(overrides));
  const failed = evaluation.constraints.filter((constraint) => !constraint.passes);
  return { evaluation, failed, summary: failed.map((constraint) => `${constraint.scope}:${constraint.period}:${constraint.code}`) };
};

describe("U-LIM-01 each limit layer rejects on its own", () => {
  it("passes when every layer has room, and reports every layer it checked", () => {
    const evaluation = evaluateLimits(request());
    expect(evaluation.passes).toBe(true);
    expect(evaluation.failure).toBeNull();
    expect(evaluation.constraints.map((constraint) => `${constraint.scope}:${constraint.period}`)).toEqual([
      "rail:ITEM",
      "type:ITEM",
      "type:DAY",
      "module:DAY",
      "type:MONTH",
      "module:MONTH",
      "corporate:DAY",
      "corporate:MONTH",
      "user:ITEM",
      "user:DAY",
    ]);
  });

  // One layer is tightened to LYD 100 at a time; every other layer keeps its wide value, so
  // exactly that layer must be the one — and the only one — that refuses a LYD 125 payment.
  const cases: Array<[label: string, overrides: Partial<LimitRequest>, expected: string]> = [
    ["rail ceiling", { rail: { perItemMinor: LYD(100), provenance: "DEMO_UNCONFIRMED" } }, "rail:ITEM:RAIL_LIMIT_EXCEEDED"],
    ["transaction-type per item", { rules: replaceRule("TYPE", "ITEM", LYD(100)) }, "type:ITEM:MODULE_LIMIT_EXCEEDED"],
    ["transaction-type per day", { rules: replaceRule("TYPE", "DAY", LYD(100)) }, "type:DAY:MODULE_LIMIT_EXCEEDED"],
    ["transaction-type per month", { rules: replaceRule("TYPE", "MONTH", LYD(100)) }, "type:MONTH:MODULE_LIMIT_EXCEEDED"],
    ["module per day", { rules: replaceRule("MODULE", "DAY", LYD(100)) }, "module:DAY:MODULE_LIMIT_EXCEEDED"],
    ["module per month", { rules: replaceRule("MODULE", "MONTH", LYD(100)) }, "module:MONTH:MODULE_LIMIT_EXCEEDED"],
    ["corporate per day", { rules: replaceRule("CORPORATE", "DAY", LYD(100)) }, "corporate:DAY:CORPORATE_DAILY_LIMIT_EXCEEDED"],
    ["corporate per month", { rules: replaceRule("CORPORATE", "MONTH", LYD(100)) }, "corporate:MONTH:CORPORATE_MONTHLY_LIMIT_EXCEEDED"],
    ["user per item", { userLimits: { perItemMinor: LYD(100), dailyMinor: LYD(10_000) } }, "user:ITEM:USER_LIMIT_EXCEEDED"],
    ["user per day", { userLimits: { perItemMinor: LYD(3_000), dailyMinor: LYD(100) } }, "user:DAY:USER_LIMIT_EXCEEDED"],
  ];
  it.each(cases)("%s", (_label, overrides, expected) => {
    const { evaluation, summary } = failureOf(overrides);
    expect(evaluation.passes).toBe(false);
    expect(summary).toEqual([expected]);
    expect(`${evaluation.failure?.scope}:${evaluation.failure?.period}:${evaluation.failure?.code}`).toBe(expected);
  });

  it("a wide corporate limit never rescues a narrower user allowance, and the reverse", () => {
    // The maker may send LYD 3,000 per item; the corporate could send far more.
    expect(failureOf({ itemAmounts: [LYD(3_000) + 1n] }).summary).toEqual(["user:ITEM:USER_LIMIT_EXCEEDED"]);
    // A treasurer-sized allowance does not widen the corporate day limit.
    const { summary } = failureOf({
      itemAmounts: [LYD(1_000)],
      userLimits: { perItemMinor: LYD(50_000), dailyMinor: LYD(50_000) },
      usage: usage({ [counterKey(scopeKeys.corporate(), "DAY")]: [LYD(29_500), 0n] }),
    });
    expect(summary).toEqual(["corporate:DAY:CORPORATE_DAILY_LIMIT_EXCEEDED"]);
  });

  it("applies a rule only to its own module, transaction type and currency", () => {
    const foreign: LimitRuleData[] = [
      rule("TYPE", "ITEM", 1n, { moduleId: "1.2" }),
      rule("TYPE", "ITEM", 1n, { transactionType: "ACH" }),
      rule("MODULE", "DAY", 1n, { moduleId: "2.1" }),
      rule("CORPORATE", "DAY", 1n, { currency: "USD" }),
    ];
    const evaluation = evaluateLimits(request({ rules: [...RULES, ...foreign] }));
    expect(evaluation.passes).toBe(true);
    expect(evaluation.constraints).toHaveLength(10);
  });
});

describe("U-LIM-02 the exact boundary is allowed, one minor unit more is not", () => {
  it("per item", () => {
    expect(evaluateLimits(request({ itemAmounts: [LYD(3_000)] })).passes).toBe(true);
    expect(failureOf({ itemAmounts: [LYD(3_000) + 1n] }).summary).toEqual(["user:ITEM:USER_LIMIT_EXCEEDED"]);
  });

  it("per day, with earlier usage", () => {
    const key = counterKey(scopeKeys.corporate(), "DAY");
    const wide = { perItemMinor: LYD(50_000), dailyMinor: LYD(50_000) };
    const exact = evaluateLimits(request({ itemAmounts: [LYD(500)], userLimits: wide, usage: usage({ [key]: [LYD(29_500), 0n] }) }));
    expect(exact.passes).toBe(true);
    const corporateDay = exact.constraints.find((constraint) => constraint.scope === "corporate" && constraint.period === "DAY");
    expect(corporateDay).toMatchObject({ limit: LYD(30_000), used: LYD(29_500), requested: LYD(500), remaining: LYD(500), passes: true });
    const over = failureOf({ itemAmounts: [LYD(500) + 1n], userLimits: wide, usage: usage({ [key]: [LYD(29_500), 0n] }) });
    expect(over.summary).toEqual(["corporate:DAY:CORPORATE_DAILY_LIMIT_EXCEEDED"]);
    expect(over.failed[0]).toMatchObject({ remaining: LYD(500), requested: LYD(500) + 1n });
  });

  it("the smallest amount, LYD 0.001, is compared exactly", () => {
    const key = counterKey(scopeKeys.user(USER), "DAY");
    expect(evaluateLimits(request({ itemAmounts: [1n], usage: usage({ [key]: [LYD(10_000) - 1n, 0n] }) })).passes).toBe(true);
    expect(failureOf({ itemAmounts: [2n], usage: usage({ [key]: [LYD(10_000) - 1n, 0n] }) }).summary).toEqual(["user:DAY:USER_LIMIT_EXCEEDED"]);
  });
});

describe("U-LIM-03 item counts and amounts are never compared with each other", () => {
  const batchRules = [...RULES, rule("TYPE", "BATCH", null, { metric: "ITEMS", currency: null, itemCount: 3 })];
  const wide = { perItemMinor: LYD(50_000), dailyMinor: LYD(50_000) };

  it("a row cap counts rows, whatever they are worth", () => {
    const allowed = evaluateLimits(request({ rules: batchRules, userLimits: wide, itemAmounts: [LYD(4_000), LYD(4_000), LYD(4_000)] }));
    expect(allowed.passes).toBe(true);
    const cap = allowed.constraints.find((constraint) => constraint.metric === "ITEMS");
    expect(cap).toMatchObject({ code: "BATCH_ROW_CAP_EXCEEDED", limit: 3n, requested: 3n, passes: true });

    // Four rows of LYD 0.001: the total is four minor units, far below "3" read as an amount.
    const refused = failureOf({ rules: batchRules, itemAmounts: [1n, 1n, 1n, 1n] });
    expect(refused.summary).toEqual(["type:BATCH:BATCH_ROW_CAP_EXCEEDED"]);
    expect(refused.failed[0]).toMatchObject({ metric: "ITEMS", limit: 3n, requested: 4n });
  });

  it("an amount limit looks at the largest row per item and at the total per period", () => {
    const evaluation = evaluateLimits(request({ rules: batchRules, userLimits: wide, itemAmounts: [LYD(100), LYD(250), LYD(50)] }));
    const byKey = new Map(evaluation.constraints.map((constraint) => [`${constraint.scope}:${constraint.period}:${constraint.metric}`, constraint.requested]));
    expect(byKey.get("rail:ITEM:AMOUNT")).toBe(LYD(250));
    expect(byKey.get("type:ITEM:AMOUNT")).toBe(LYD(250));
    expect(byKey.get("user:ITEM:AMOUNT")).toBe(LYD(250));
    expect(byKey.get("type:DAY:AMOUNT")).toBe(LYD(400));
    expect(byKey.get("corporate:MONTH:AMOUNT")).toBe(LYD(400));
    expect(byKey.get("user:DAY:AMOUNT")).toBe(LYD(400));
    expect(byKey.get("type:BATCH:ITEMS")).toBe(3n);
  });

  it("one row above the per-item limit fails even when the total is small", () => {
    expect(failureOf({ itemAmounts: [LYD(10), LYD(3_001), LYD(10)], userLimits: { perItemMinor: LYD(3_000), dailyMinor: LYD(50_000) } }).summary).toEqual([
      "user:ITEM:USER_LIMIT_EXCEEDED",
    ]);
  });

  it("a row cap applies in every currency; an amount limit only in its own", () => {
    const evaluation = evaluateLimits(request({ rules: batchRules, currency: "USD", railRequired: false, userKey: null, itemAmounts: [1n, 1n, 1n, 1n] }));
    expect(evaluation.constraints.map((constraint) => `${constraint.scope}:${constraint.period}:${constraint.metric}`)).toEqual(["type:BATCH:ITEMS"]);
    expect(evaluation.passes).toBe(false);
  });
});

describe("U-LIM-04 limits count the principal; the fee is quoted separately", () => {
  it("the documented LYD 125.000 payment asks every limit for 125.000, never 125.500", () => {
    const evaluation = evaluateLimits(request({ itemAmounts: [125_000n] }));
    expect(new Set(evaluation.constraints.map((constraint) => constraint.requested))).toEqual(new Set([125_000n]));
    expect(quoteFee(500n, 1)).toEqual({ perItemMinor: 500n, totalMinor: 500n });
  });

  it("a payment whose principal exactly fills the limit passes although principal plus fee would not", () => {
    const fee = quoteFee(500n, 1);
    const evaluation = evaluateLimits(request({ itemAmounts: [LYD(3_000)] }));
    expect(evaluation.passes).toBe(true);
    expect(LYD(3_000) + (fee?.totalMinor ?? 0n)).toBeGreaterThan(LYD(3_000));
  });

  it("charges one fixed fee per child transfer, in exact integers", () => {
    expect(quoteFee(250n, 100)).toEqual({ perItemMinor: 250n, totalMinor: 25_000n });
    expect(quoteFee(100n, 8)).toEqual({ perItemMinor: 100n, totalMinor: 800n });
    expect(quoteFee(9_007_199_254_740_993n, 3)?.totalMinor).toBe(27_021_597_764_222_979n);
  });

  it("tells an explicit zero fee from a tariff that is not configured", () => {
    expect(quoteFee(0n, 1)).toEqual({ perItemMinor: 0n, totalMinor: 0n });
    expect(quoteFee(null, 1)).toBeNull();
  });
});

describe("U-LIM-05 an unknown rail ceiling blocks; it is never read as unlimited", () => {
  it("no parameter row at all", () => {
    const { evaluation, summary } = failureOf({ rail: null });
    expect(summary).toEqual(["rail:ITEM:RAIL_CONFIGURATION_REQUIRED"]);
    expect(evaluation.failure).toMatchObject({ limit: null, remaining: null, provenance: null });
  });

  it("a parameter row without a ceiling", () => {
    const { evaluation, summary } = failureOf({ rail: { perItemMinor: null, provenance: "BANK_CONFIRMED" } });
    expect(summary).toEqual(["rail:ITEM:RAIL_CONFIGURATION_REQUIRED"]);
    expect(evaluation.failure).toMatchObject({ limit: null, provenance: "BANK_CONFIRMED" });
  });

  it("blocks even the smallest amount", () => {
    expect(failureOf({ rail: null, itemAmounts: [1n] }).summary).toEqual(["rail:ITEM:RAIL_CONFIGURATION_REQUIRED"]);
  });

  it("carries the provenance of the parameter so an unconfirmed value stays labelled", () => {
    const evaluation = evaluateLimits(request());
    expect(evaluation.constraints[0]).toMatchObject({ scope: "rail", provenance: "DEMO_UNCONFIRMED" });
    expect(constraintToJson(evaluation.constraints[0]!)).toMatchObject({ limit: "10000000", requested: "125000", remaining: "10000000", provenance: "DEMO_UNCONFIRMED" });
  });

  it("a type that uses no rail (own-account transfer) gets no rail check", () => {
    const evaluation = evaluateLimits(request({ rail: null, railRequired: false }));
    expect(evaluation.passes).toBe(true);
    expect(evaluation.constraints.some((constraint) => constraint.scope === "rail")).toBe(false);
  });
});

describe("U-LIM-06 amounts reserved by payments in flight count against the limit", () => {
  const key = counterKey(scopeKeys.corporate(), "DAY");
  const wide = { perItemMinor: LYD(50_000), dailyMinor: LYD(50_000) };

  it("reserved usage alone can exhaust a limit", () => {
    const { summary, failed } = failureOf({ itemAmounts: [LYD(1_000)], userLimits: wide, usage: usage({ [key]: [0n, LYD(29_500)] }) });
    expect(summary).toEqual(["corporate:DAY:CORPORATE_DAILY_LIMIT_EXCEEDED"]);
    expect(failed[0]).toMatchObject({ used: 0n, reserved: LYD(29_500), remaining: LYD(500) });
  });

  it("consumed and reserved add up", () => {
    const snapshot = usage({ [key]: [LYD(20_000), LYD(9_500)] });
    expect(evaluateLimits(request({ itemAmounts: [LYD(500)], userLimits: wide, usage: snapshot })).passes).toBe(true);
    expect(failureOf({ itemAmounts: [LYD(500) + 1n], userLimits: wide, usage: snapshot }).summary).toEqual(["corporate:DAY:CORPORATE_DAILY_LIMIT_EXCEEDED"]);
  });

  it("each layer reads its own counter", () => {
    const snapshot = usage({
      [counterKey(scopeKeys.type(MODULE, TYPE), "DAY")]: [LYD(1), LYD(2)],
      [counterKey(scopeKeys.module(MODULE), "MONTH")]: [LYD(3), LYD(4)],
      [counterKey(scopeKeys.corporate(), "MONTH")]: [LYD(5), LYD(6)],
      [counterKey(scopeKeys.user(USER), "DAY")]: [LYD(7), LYD(8)],
      // Another maker and another module: neither belongs to this request.
      [counterKey(scopeKeys.user("someone-else"), "DAY")]: [LYD(9_999), 0n],
      [counterKey(scopeKeys.module("2.2"), "DAY")]: [LYD(99_999), 0n],
    });
    const evaluation = evaluateLimits(request({ usage: snapshot }));
    const read = new Map(evaluation.constraints.map((constraint) => [`${constraint.scope}:${constraint.period}`, [constraint.used, constraint.reserved]]));
    expect(read.get("type:DAY")).toEqual([LYD(1), LYD(2)]);
    expect(read.get("module:MONTH")).toEqual([LYD(3), LYD(4)]);
    expect(read.get("corporate:MONTH")).toEqual([LYD(5), LYD(6)]);
    expect(read.get("user:DAY")).toEqual([LYD(7), LYD(8)]);
    expect(read.get("module:DAY")).toEqual([0n, 0n]);
    expect(evaluation.passes).toBe(true);
  });

  it("one outgoing instruction counts once in each bucket it belongs to", () => {
    expect(countersFor({ moduleId: MODULE, transactionType: TYPE, userKey: USER }).map((ref) => counterKey(ref.scopeKey, ref.period))).toEqual([
      "TYPE:1.1:INSTANT|DAY",
      "MODULE:1.1|DAY",
      "CORPORATE|DAY",
      "TYPE:1.1:INSTANT|MONTH",
      "MODULE:1.1|MONTH",
      "CORPORATE|MONTH",
      `USER:${USER}|DAY`,
    ]);
    // A non-human principal has no personal bucket.
    expect(countersFor({ moduleId: MODULE, transactionType: TYPE, userKey: null })).toHaveLength(6);
  });
});

describe("U-LIM-07 a missing limit value fails closed", () => {
  it("a maker with no allowance cannot move money", () => {
    expect(failureOf({ userLimits: { perItemMinor: null, dailyMinor: null } }).summary).toEqual(["user:ITEM:USER_LIMIT_EXCEEDED", "user:DAY:USER_LIMIT_EXCEEDED"]);
    expect(failureOf({ userLimits: { perItemMinor: LYD(3_000), dailyMinor: null }, itemAmounts: [1n] }).summary).toEqual(["user:DAY:USER_LIMIT_EXCEEDED"]);
  });

  it("a configured rule without a value refuses instead of allowing everything", () => {
    const { summary, failed } = failureOf({ rules: replaceRule("CORPORATE", "DAY", null), itemAmounts: [1n] });
    expect(summary).toEqual(["corporate:DAY:CORPORATE_DAILY_LIMIT_EXCEEDED"]);
    expect(failed[0]).toMatchObject({ limit: null, remaining: null });
  });

  it("a non-human principal has no user allowance to check and still meets every other layer", () => {
    const evaluation = evaluateLimits(request({ userKey: null, userLimits: { perItemMinor: null, dailyMinor: null } }));
    expect(evaluation.passes).toBe(true);
    expect(evaluation.constraints.some((constraint) => constraint.scope === "user")).toBe(false);
    expect(failureOf({ userKey: null, userLimits: { perItemMinor: null, dailyMinor: null }, itemAmounts: [LYD(5_000) + 1n] }).summary).toEqual([
      "type:ITEM:MODULE_LIMIT_EXCEEDED",
    ]);
  });
});

describe("U-LIM-08 day and month windows follow the bank's clock", () => {
  const TZ = "Africa/Tripoli";

  it("a payment at 00:30 Tripoli on 1 December counts in December, although it is still 30 November in UTC", () => {
    const instant = new Date("2026-11-30T22:30:00.000Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(usageWindows(instant, TZ)).toEqual({ day: "2026-12-01", month: "2026-12-01" });
  });

  it("the last second of the business day still belongs to that day and month", () => {
    expect(usageWindows(new Date("2026-11-30T21:59:59.999Z"), TZ)).toEqual({ day: "2026-11-30", month: "2026-11-01" });
    expect(usageWindows(new Date("2026-11-30T22:00:00.000Z"), TZ)).toEqual({ day: "2026-12-01", month: "2026-12-01" });
  });

  it("a new day starts with empty day counters while the month keeps counting", () => {
    // What the loader hands over on the next business day: no DAY rows, the MONTH row carried on.
    const nextDay = usage({ [counterKey(scopeKeys.corporate(), "MONTH")]: [LYD(30_000), 0n] });
    const wide = { perItemMinor: LYD(50_000), dailyMinor: LYD(50_000) };
    const evaluation = evaluateLimits(request({ itemAmounts: [LYD(1_000)], userLimits: wide, usage: nextDay }));
    expect(evaluation.passes).toBe(true);
    const month = evaluation.constraints.find((constraint) => constraint.scope === "corporate" && constraint.period === "MONTH");
    expect(month).toMatchObject({ used: LYD(30_000), remaining: LYD(120_000) });
    const day = evaluation.constraints.find((constraint) => constraint.scope === "corporate" && constraint.period === "DAY");
    expect(day).toMatchObject({ used: 0n, remaining: LYD(30_000) });
  });
});

// ------------------------------------------------------------------------------------------
// Approval bands
// ------------------------------------------------------------------------------------------

const BANK: readonly BandData[] = [
  { minMinor: 0n, maxExclusiveMinor: LYD(2_000), checkerCount: 1 },
  { minMinor: LYD(2_000), maxExclusiveMinor: null, checkerCount: 2 },
];
const band = (min: number, max: number | null, checkerCount: number): BandData => ({ minMinor: LYD(min), maxExclusiveMinor: max === null ? null : LYD(max), checkerCount });
const text = (bands: readonly BandData[]) =>
  bands.map((entry) => ({ minMinor: entry.minMinor.toString(), maxExclusiveMinor: entry.maxExclusiveMinor?.toString() ?? null, checkerCount: entry.checkerCount }));

describe("U-APR-01 band minimum is inclusive, maximum exclusive", () => {
  it("LYD 1,999.999 needs one checker; LYD 2,000.000 needs two", () => {
    expect(requiredCheckers(0n, BANK, [])).toBe(1);
    expect(requiredCheckers(1n, BANK, [])).toBe(1);
    expect(requiredCheckers(LYD(2_000) - 1n, BANK, [])).toBe(1);
    expect(requiredCheckers(LYD(2_000), BANK, [])).toBe(2);
    expect(requiredCheckers(LYD(2_000) + 1n, BANK, [])).toBe(2);
    expect(requiredCheckers(LYD(1_000_000_000), BANK, [])).toBe(2);
  });

  it("a boundary amount belongs to exactly one band", () => {
    for (const amount of [0n, LYD(2_000) - 1n, LYD(2_000), LYD(2_000) + 1n]) {
      const matches = BANK.filter((entry) => amount >= entry.minMinor && (entry.maxExclusiveMinor === null || amount < entry.maxExclusiveMinor));
      expect(matches).toHaveLength(1);
      expect(bandFor(amount, BANK)).toBe(matches[0]);
    }
  });

  it("a bounded top band stops exactly at its maximum", () => {
    const bounded = [band(0, 2_000, 1), band(2_000, 50_000, 2)];
    expect(requiredCheckers(LYD(50_000) - 1n, bounded, [])).toBe(2);
    expect(requiredCheckers(LYD(50_000), bounded, [])).toBeNull();
  });
});

describe("U-APR-02 bands have no gaps and no overlaps", () => {
  it("accepts the documented two-band rule in any order", () => {
    expect(validateBands(text(BANK))).toBeNull();
    expect(validateBands(text([...BANK].reverse()))).toBeNull();
    expect(validateBands(text([band(0, null, 1)]))).toBeNull();
  });

  it("refuses a gap", () => {
    expect(validateBands(text([band(0, 2_000, 1), band(2_500, null, 2)]))).toMatch(/contiguous/);
    // One minor unit is still a gap: LYD 2,000.000 would match nothing.
    expect(validateBands([{ minMinor: "0", maxExclusiveMinor: "2000000", checkerCount: 1 }, { minMinor: "2000001", maxExclusiveMinor: null, checkerCount: 2 }])).toMatch(/contiguous/);
  });

  it("refuses an overlap", () => {
    expect(validateBands(text([band(0, 2_000, 1), band(1_500, null, 2)]))).toMatch(/contiguous/);
    expect(validateBands([{ minMinor: "0", maxExclusiveMinor: "2000000", checkerCount: 1 }, { minMinor: "1999999", maxExclusiveMinor: null, checkerCount: 2 }])).toMatch(/contiguous/);
    expect(validateBands(text([band(0, null, 1), band(2_000, null, 2)]))).toMatch(/last band/);
  });

  it("refuses bands that do not start at zero, an empty or inverted band, and an empty rule", () => {
    expect(validateBands(text([band(1, null, 1)]))).toMatch(/start at 0/);
    expect(validateBands(text([band(0, 0, 1), band(0, null, 1)]))).toMatch(/greater than its minimum/);
    expect(validateBands([{ minMinor: "0", maxExclusiveMinor: "2000000", checkerCount: 1 }, { minMinor: "2000000", maxExclusiveMinor: "1000000", checkerCount: 2 }])).toMatch(/greater than its minimum/);
    expect(validateBands([])).toMatch(/at least one/);
  });

  it("refuses a band with no independent checker", () => {
    expect(validateBands(text([band(0, 2_000, 0), band(2_000, null, 2)]))).toMatch(/at least one independent checker/);
    expect(validateBands(text([band(0, null, -1)]))).toMatch(/at least one independent checker/);
  });
});

describe("U-APR-03 checker counts respect the bank floor", () => {
  it("a corporate rule can raise the count", () => {
    const stricter = [band(0, 500, 1), band(500, null, 3)];
    expect(requiredCheckers(LYD(499), BANK, stricter)).toBe(1);
    expect(requiredCheckers(LYD(500), BANK, stricter)).toBe(3);
    expect(requiredCheckers(LYD(5_000), BANK, stricter)).toBe(3);
    expect(weakensBankFloor(stricter, BANK)).toBe(false);
  });

  it("a corporate rule can never lower it", () => {
    const weaker = [band(0, null, 1)];
    expect(requiredCheckers(LYD(5_000), BANK, weaker)).toBe(2);
    expect(weakensBankFloor(weaker, BANK)).toBe(true);
  });

  it("detects a weaker rule even when the boundaries differ", () => {
    // One checker up to LYD 2,000.001: weaker than the bank for exactly one amount.
    const offByOne: BandData[] = [
      { minMinor: 0n, maxExclusiveMinor: LYD(2_000) + 1n, checkerCount: 1 },
      { minMinor: LYD(2_000) + 1n, maxExclusiveMinor: null, checkerCount: 2 },
    ];
    expect(weakensBankFloor(offByOne, BANK)).toBe(true);
    expect(requiredCheckers(LYD(2_000), BANK, offByOne)).toBe(2);
    // The same boundary moved down is stricter, not weaker.
    expect(weakensBankFloor([band(0, 1_000, 1), band(1_000, null, 2)], BANK)).toBe(false);
    expect(weakensBankFloor(BANK, BANK)).toBe(false);
    expect(weakensBankFloor([], BANK)).toBe(false);
  });

  it("a missing corporate band falls back to the bank floor", () => {
    expect(requiredCheckers(LYD(100), BANK, [])).toBe(1);
    expect(requiredCheckers(LYD(100), BANK, [band(5_000, null, 3)])).toBe(1);
    expect(requiredCheckers(LYD(2_500), BANK, [band(5_000, null, 3)])).toBe(2);
  });

  it("never returns fewer than one independent checker", () => {
    const zero = [band(0, null, 0)];
    expect(requiredCheckers(LYD(100), zero, [])).toBe(1);
    expect(requiredCheckers(LYD(100), zero, zero)).toBe(1);
  });

  it("no bank band for the amount means no decision: the caller must refuse", () => {
    expect(requiredCheckers(LYD(100), [], [band(0, null, 2)])).toBeNull();
    expect(requiredCheckers(LYD(100), [band(1_000, null, 2)], [])).toBeNull();
    expect(bandFor(LYD(100), [])).toBeNull();
  });
});
