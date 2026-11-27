/**
 * Segment templates (AGR-03): starting points for the bank console editor and the demo seed.
 * They are synthetic TEST POLICY — not CBL or bank-approved limits and not legally binding
 * defaults. Every amount is marked DEMO_UNCONFIRMED. Editing a template never changes a
 * signed agreement, because agreements store their own immutable copy of the terms.
 *
 * The MEDIUM template reproduces the deterministic fixture table in document 07.
 */
import type { AgreementTerms, ModuleTerms } from "@/contracts/agreement";

export type TemplateAccounts = {
  /** All accounts the agreement links. */
  all: string[];
  /** Accounts payments, bulk and own transfers may debit. */
  payments: string[];
  /** Accounts payroll may debit. */
  payroll: string[];
  /** Accounts branch deposits may credit. */
  collections: string[];
};

type Scale = { num: bigint; den: bigint };

const SCALE: Record<AgreementTerms["segment"], Scale> = {
  SMALL: { num: 1n, den: 2n },
  MEDIUM: { num: 1n, den: 1n },
  LARGE: { num: 3n, den: 1n },
};

/** LYD whole dinars → minor-unit string, scaled for the segment. */
const lyd = (dinars: number, scale: Scale): string => ((BigInt(dinars) * 1000n * scale.num) / scale.den).toString();
const fixed = (minor: number): string => String(minor);

export function segmentTemplate(segment: AgreementTerms["segment"], accounts: TemplateAccounts): AgreementTerms {
  const s = SCALE[segment];
  const bands = (type: ModuleTerms["approvalBands"][number]["transactionType"], secondBandFrom: number) => [
    { transactionType: type, currency: "LYD" as const, minMinor: "0", maxExclusiveMinor: lyd(secondBandFrom, s), checkerCount: 1 },
    { transactionType: type, currency: "LYD" as const, minMinor: lyd(secondBandFrom, s), maxExclusiveMinor: null, checkerCount: 2 },
  ];
  const amount = (
    scope: "TYPE" | "MODULE",
    period: "ITEM" | "DAY" | "MONTH",
    dinars: number,
    transactionType?: ModuleTerms["approvalBands"][number]["transactionType"],
  ) => ({
    scope,
    ...(transactionType ? { transactionType } : {}),
    metric: "AMOUNT" as const,
    period,
    currency: "LYD" as const,
    minor: lyd(dinars, s),
    provenance: "DEMO_UNCONFIRMED" as const,
  });

  const moduleTerms: ModuleTerms[] = [
    {
      moduleId: "1.1",
      transactionTypes: ["INSTANT_ACCOUNT_CREDIT"],
      currency: "LYD",
      debitAccountIds: accounts.payments,
      creditAccountIds: [],
      limits: [
        amount("TYPE", "ITEM", 5_000, "INSTANT_ACCOUNT_CREDIT"),
        amount("MODULE", "DAY", 20_000),
        amount("MODULE", "MONTH", 100_000),
      ],
      feeRules: [{ transactionType: "INSTANT_ACCOUNT_CREDIT", currency: "LYD", minor: fixed(500) }],
      approvalBands: bands("INSTANT_ACCOUNT_CREDIT", 2_000),
    },
    {
      moduleId: "1.2",
      transactionTypes: ["ACH_CREDIT"],
      currency: "LYD",
      debitAccountIds: accounts.payments,
      creditAccountIds: [],
      limits: [amount("TYPE", "ITEM", 8_000, "ACH_CREDIT"), amount("MODULE", "DAY", 20_000), amount("MODULE", "MONTH", 100_000)],
      feeRules: [{ transactionType: "ACH_CREDIT", currency: "LYD", minor: fixed(500) }],
      approvalBands: bands("ACH_CREDIT", 2_000),
    },
    {
      moduleId: "1.5",
      transactionTypes: ["OWN_ACCOUNT_TRANSFER"],
      currency: "LYD",
      debitAccountIds: accounts.all,
      creditAccountIds: accounts.all,
      limits: [amount("TYPE", "ITEM", 20_000, "OWN_ACCOUNT_TRANSFER"), amount("MODULE", "DAY", 25_000), amount("MODULE", "MONTH", 120_000)],
      // Explicit zero tariff: exempt, not "missing configuration" (LIM-04).
      feeRules: [{ transactionType: "OWN_ACCOUNT_TRANSFER", currency: "LYD", minor: fixed(0) }],
      approvalBands: bands("OWN_ACCOUNT_TRANSFER", 2_000),
    },
    {
      moduleId: "2.1",
      transactionTypes: ["BULK_CREDIT"],
      currency: "LYD",
      debitAccountIds: accounts.payments,
      creditAccountIds: [],
      limits: [
        amount("TYPE", "ITEM", 5_000, "BULK_CREDIT"),
        amount("MODULE", "DAY", 25_000),
        amount("MODULE", "MONTH", 120_000),
        { scope: "MODULE", metric: "ITEMS", period: "BATCH", count: 100, provenance: "DEMO_UNCONFIRMED" },
      ],
      feeRules: [{ transactionType: "BULK_CREDIT", currency: "LYD", minor: fixed(250) }],
      approvalBands: bands("BULK_CREDIT", 15_000),
      rowCap: 100,
    },
    {
      moduleId: "2.2",
      transactionTypes: ["PAYROLL_SALARY", "PAYROLL_ALLOWANCE"],
      currency: "LYD",
      debitAccountIds: accounts.payroll,
      creditAccountIds: [],
      limits: [
        amount("TYPE", "ITEM", 6_000, "PAYROLL_SALARY"),
        amount("TYPE", "ITEM", 3_000, "PAYROLL_ALLOWANCE"),
        amount("MODULE", "DAY", 28_000),
        amount("MODULE", "MONTH", 90_000),
        { scope: "MODULE", metric: "ITEMS", period: "BATCH", count: 100, provenance: "DEMO_UNCONFIRMED" },
      ],
      feeRules: [
        { transactionType: "PAYROLL_SALARY", currency: "LYD", minor: fixed(100) },
        { transactionType: "PAYROLL_ALLOWANCE", currency: "LYD", minor: fixed(100) },
      ],
      approvalBands: [...bands("PAYROLL_SALARY", 25_000), ...bands("PAYROLL_ALLOWANCE", 25_000)],
      rowCap: 100,
    },
    { moduleId: "3.1", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
    {
      moduleId: "3.2",
      transactionTypes: ["BRANCH_CASH_DEPOSIT", "BRANCH_CHEQUE_DEPOSIT"],
      currency: "LYD",
      debitAccountIds: [],
      creditAccountIds: accounts.collections,
      limits: [amount("TYPE", "ITEM", 50_000, "BRANCH_CASH_DEPOSIT"), amount("TYPE", "ITEM", 50_000, "BRANCH_CHEQUE_DEPOSIT")],
      feeRules: [],
      approvalBands: [],
    },
    { moduleId: "3.3", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
    { moduleId: "7.2", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
    { moduleId: "10.1", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
    { moduleId: "11.1", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
    { moduleId: "12.1", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
    { moduleId: "12.2", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
    { moduleId: "12.3", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] },
  ];

  return {
    segment,
    linkedAccounts: accounts.all,
    moduleTerms,
    corporateLimits: [
      { metric: "AMOUNT", period: "DAY", currency: "LYD", minor: lyd(30_000, s), provenance: "DEMO_UNCONFIRMED" },
      { metric: "AMOUNT", period: "MONTH", currency: "LYD", minor: lyd(150_000, s), provenance: "DEMO_UNCONFIRMED" },
    ],
    userLimitEnvelope: { perItemMinor: lyd(8_000, s), dailyMinor: lyd(30_000, s) },
    depositPolicy: {
      perDepositCapMinor: lyd(50_000, s),
      // Fixture: strictly above LYD 2,000 needs an independent branch manager (document 07).
      managerThresholdMinor: fixed(2_000_000),
      cashReviewThresholdMinor: fixed(10_000_000),
    },
    apiPlan: { perMinute: 60, perDay: 10_000 },
  };
}
