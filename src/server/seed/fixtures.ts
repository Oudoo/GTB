/**
 * Deterministic SYNTHETIC fixtures (document 07 "Deterministic seed contract").
 * Every name, address and account below is invented. Amounts are test policy, not CBL or
 * bank-approved figures. IDs are derived from fixture names so the seed is idempotent and
 * tests/documentation can refer to the same objects.
 */
import { fixtureUuid } from "@/server/hash";

export const EMAIL_DOMAIN = "demo.alqarib.test";
const email = (local: string) => `${local}@${EMAIL_DOMAIN}`;
const lyd = (dinars: number) => BigInt(dinars) * 1000n;

export const BANKS = {
  A: { id: fixtureUuid("bank:A"), code: "ALQARIB-SBX", name: "Al Qarib Sandbox", nameAr: "القريب — بيئة تجريبية" },
  B: { id: fixtureUuid("bank:B"), code: "BOUNDARY-SBX", name: "Boundary Test Bank", nameAr: "مصرف الحدود التجريبي" },
} as const;

export const BRANCHES = {
  BR1: { id: fixtureUuid("branch:A:BR1"), bank: "A", code: "BR1", name: "Tripoli Main Branch (Demo)", nameAr: "فرع طرابلس الرئيسي (تجريبي)" },
  BR2: { id: fixtureUuid("branch:A:BR2"), bank: "A", code: "BR2", name: "Benghazi Branch (Demo)", nameAr: "فرع بنغازي (تجريبي)" },
  BB1: { id: fixtureUuid("branch:B:BB1"), bank: "B", code: "BB1", name: "Boundary Branch (Demo)", nameAr: "فرع الحدود (تجريبي)" },
} as const;

export const CALENDARS = {
  A: { id: fixtureUuid("calendar:A"), bank: "A", code: "SBX-LY", name: "Synthetic sandbox calendar" },
  B: { id: fixtureUuid("calendar:B"), bank: "B", code: "SBX-LY", name: "Synthetic sandbox calendar" },
} as const;

/** Invented closed days used only to exercise roll-forward. Not real holidays. */
export const CLOSED_DAYS = [
  { date: "2026-11-25", label: "Synthetic closed day (fixture)" },
  { date: "2026-12-24", label: "Synthetic closed day (fixture)" },
] as const;

export const CORPORATES = {
  A: {
    id: fixtureUuid("corporate:A"),
    bank: "A",
    legalName: "Qarib Trading Demo",
    legalNameAr: "شركة القريب للتجارة (تجريبية)",
    shortCode: "QTD",
    segment: "MEDIUM",
    coreCustomerRef: "CIF-A-000001",
  },
  B: {
    id: fixtureUuid("corporate:B"),
    bank: "A",
    legalName: "Sahara Logistics Demo",
    legalNameAr: "شركة الصحراء للخدمات اللوجستية (تجريبية)",
    shortCode: "SLD",
    segment: "SMALL",
    coreCustomerRef: "CIF-A-000002",
  },
  C: {
    id: fixtureUuid("corporate:C"),
    bank: "B",
    legalName: "Boundary Imports Demo",
    legalNameAr: "شركة الحدود للاستيراد (تجريبية)",
    shortCode: "BID",
    segment: "SMALL",
    coreCustomerRef: "CIF-B-000001",
  },
} as const;

export type CorporateKey = keyof typeof CORPORATES;

export const ACCOUNTS = {
  A_OPERATING: { id: fixtureUuid("account:A:operating"), corporate: "A", ref: "DEMO-LY-000001", name: "Operating account", nameAr: "الحساب الجاري التشغيلي", kind: "OPERATING", opening: lyd(100_000) },
  A_PAYROLL: { id: fixtureUuid("account:A:payroll"), corporate: "A", ref: "DEMO-LY-000002", name: "Payroll account", nameAr: "حساب الرواتب", kind: "PAYROLL", opening: lyd(50_000) },
  A_SAVINGS: { id: fixtureUuid("account:A:savings"), corporate: "A", ref: "DEMO-LY-000003", name: "Savings account", nameAr: "حساب الادخار", kind: "SAVINGS", opening: lyd(25_000) },
  B_OPERATING: { id: fixtureUuid("account:B:operating"), corporate: "B", ref: "DEMO-LY-000011", name: "Operating account", nameAr: "الحساب الجاري التشغيلي", kind: "OPERATING", opening: lyd(20_000) },
  B_SAVINGS: { id: fixtureUuid("account:B:savings"), corporate: "B", ref: "DEMO-LY-000012", name: "Reserve account", nameAr: "حساب الاحتياطي", kind: "SAVINGS", opening: lyd(5_000) },
  C_OPERATING: { id: fixtureUuid("account:C:operating"), corporate: "C", ref: "DEMO-LY-100001", name: "Operating account", nameAr: "الحساب الجاري التشغيلي", kind: "OPERATING", opening: lyd(10_000) },
} as const;

export type AccountKey = keyof typeof ACCOUNTS;

type Grant = { account: AccountKey; read?: boolean; debit?: boolean; approve?: boolean; report?: boolean };

export type PersonFixture = {
  key: string;
  email: string;
  name: string;
  nameAr: string;
  locale: "en" | "ar";
  memberships: Array<{
    scope: { corporate: CorporateKey } | { bank: "A" | "B" };
    roles: string[];
    branch?: keyof typeof BRANCHES;
    perItem?: bigint;
    daily?: bigint;
    grants?: Grant[];
  }>;
};

const allA = (rights: Omit<Grant, "account">): Grant[] => [
  { account: "A_OPERATING", ...rights },
  { account: "A_PAYROLL", ...rights },
  { account: "A_SAVINGS", ...rights },
];

/**
 * Distinct people (document 07). No two entries share an identity; the `dual` entries hold two
 * roles on purpose to prove that role combinations do not defeat human separation.
 */
export const PEOPLE: PersonFixture[] = [
  { key: "aAdmin", email: email("a.admin"), name: "Salma Admin (Demo)", nameAr: "سلمى — مسؤولة الشركة (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["CORPORATE_ADMIN", "API_INTEGRATOR"] }] },
  { key: "aAdmin2", email: email("a.admin2"), name: "Tariq Admin (Demo)", nameAr: "طارق — مسؤول الشركة (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["CORPORATE_ADMIN"] }] },
  { key: "aMaker", email: email("a.maker"), name: "Mona Maker (Demo)", nameAr: "منى — مُنشئة (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["MAKER"], perItem: lyd(3_000), daily: lyd(10_000),
      grants: [{ account: "A_OPERATING", read: true, debit: true }, { account: "A_SAVINGS", read: true, debit: true }, { account: "A_PAYROLL", read: true }] }] },
  { key: "aChecker1", email: email("a.checker1"), name: "Khalid Checker (Demo)", nameAr: "خالد — مدقق (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["CHECKER"], grants: allA({ read: true, approve: true }) }] },
  { key: "aChecker2", email: email("a.checker2"), name: "Huda Checker (Demo)", nameAr: "هدى — مدققة (تجريبي)", locale: "ar",
    memberships: [{ scope: { corporate: "A" }, roles: ["CHECKER"], grants: allA({ read: true, approve: true }) }] },
  { key: "aPayroll", email: email("a.payroll"), name: "Yusuf Payroll (Demo)", nameAr: "يوسف — مسؤول الرواتب (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["PAYROLL_OFFICER"], perItem: lyd(6_000), daily: lyd(28_000),
      grants: [{ account: "A_PAYROLL", read: true, debit: true }] }] },
  { key: "aTreasurer", email: email("a.treasurer"), name: "Layla Treasurer (Demo)", nameAr: "ليلى — أمينة الخزينة (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["TREASURER"], perItem: lyd(8_000), daily: lyd(30_000),
      grants: allA({ read: true, debit: true, report: true }) }] },
  { key: "aFinance", email: email("a.finance"), name: "Omar Finance (Demo)", nameAr: "عمر — المالية (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["FINANCE"], grants: allA({ read: true, report: true }) }] },
  { key: "aViewer", email: email("a.viewer"), name: "Nadia Viewer (Demo)", nameAr: "نادية — مُطّلعة (تجريبي)", locale: "ar",
    memberships: [{ scope: { corporate: "A" }, roles: ["VIEWER"], grants: allA({ read: true, report: true }) }] },
  { key: "aDual", email: email("a.dual"), name: "Sami Maker-Checker (Demo)", nameAr: "سامي — مُنشئ ومدقق (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "A" }, roles: ["MAKER", "CHECKER"], perItem: lyd(3_000), daily: lyd(10_000),
      grants: [{ account: "A_OPERATING", read: true, debit: true, approve: true }, { account: "A_SAVINGS", read: true, debit: true, approve: true }] }] },
  { key: "bMaker", email: email("b.maker"), name: "Basma Maker (Demo)", nameAr: "بسمة — مُنشئة (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "B" }, roles: ["MAKER"], perItem: lyd(1_500), daily: lyd(5_000),
      grants: [{ account: "B_OPERATING", read: true, debit: true }, { account: "B_SAVINGS", read: true, debit: true }] }] },
  { key: "bChecker", email: email("b.checker"), name: "Idris Checker (Demo)", nameAr: "إدريس — مدقق (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "B" }, roles: ["CHECKER"],
      grants: [{ account: "B_OPERATING", read: true, approve: true }, { account: "B_SAVINGS", read: true, approve: true }] }] },
  { key: "bViewer", email: email("b.viewer"), name: "Wafa Viewer (Demo)", nameAr: "وفاء — مُطّلعة (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "B" }, roles: ["VIEWER"], grants: [{ account: "B_OPERATING", read: true, report: true }] }] },
  { key: "bFinance", email: email("b.finance"), name: "Jamal Finance (Demo)", nameAr: "جمال — المالية (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "B" }, roles: ["FINANCE"], grants: [{ account: "B_OPERATING", read: true, report: true }] }] },
  // One person with two workspaces, to exercise explicit context selection.
  { key: "multi", email: email("multi.context"), name: "Rima Two-Workspaces (Demo)", nameAr: "ريما — مساحتا عمل (تجريبي)", locale: "en",
    memberships: [
      { scope: { corporate: "A" }, roles: ["VIEWER"], grants: [{ account: "A_OPERATING", read: true }] },
      { scope: { corporate: "B" }, roles: ["VIEWER"], grants: [{ account: "B_OPERATING", read: true }] },
    ] },
  { key: "bankMaker", email: email("bank.maker"), name: "Faisal Bank Admin Maker (Demo)", nameAr: "فيصل — مسؤول المصرف (مُنشئ) (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BANK_ADMIN_MAKER"] }] },
  { key: "bankChecker", email: email("bank.checker"), name: "Zainab Bank Admin Checker (Demo)", nameAr: "زينب — مسؤولة المصرف (مدققة) (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BANK_ADMIN_CHECKER"] }] },
  { key: "bankDual", email: email("bank.dual"), name: "Nasser Bank Admin Both Roles (Demo)", nameAr: "ناصر — مسؤول المصرف بدورين (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BANK_ADMIN_MAKER", "BANK_ADMIN_CHECKER"] }] },
  { key: "teller1", email: email("teller1"), name: "Hana Teller BR1 (Demo)", nameAr: "هناء — صرافة الفرع ١ (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BRANCH_TELLER"], branch: "BR1" }] },
  { key: "manager1", email: email("manager1"), name: "Mahmoud Manager BR1 (Demo)", nameAr: "محمود — مدير الفرع ١ (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BRANCH_MANAGER"], branch: "BR1" }] },
  { key: "teller2", email: email("teller2"), name: "Samir Teller BR2 (Demo)", nameAr: "سمير — صراف الفرع ٢ (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BRANCH_TELLER"], branch: "BR2" }] },
  { key: "manager2", email: email("manager2"), name: "Dalia Manager BR2 (Demo)", nameAr: "داليا — مديرة الفرع ٢ (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BRANCH_MANAGER"], branch: "BR2" }] },
  { key: "branchDual", email: email("branch.dual"), name: "Karim Teller-Manager BR1 (Demo)", nameAr: "كريم — صراف ومدير الفرع ١ (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["BRANCH_TELLER", "BRANCH_MANAGER"], branch: "BR1" }] },
  { key: "ops", email: email("ops"), name: "Rashid Payments Operations (Demo)", nameAr: "راشد — عمليات المدفوعات (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["PAYMENTS_OPERATIONS"] }] },
  { key: "compliance", email: email("compliance"), name: "Lubna Compliance (Demo)", nameAr: "لبنى — الامتثال (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["COMPLIANCE"] }] },
  { key: "rm", email: email("rm"), name: "Adel Relationship Manager (Demo)", nameAr: "عادل — مدير العلاقة (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["RELATIONSHIP_MANAGER"] }] },
  { key: "payrollSupport", email: email("payroll.support"), name: "Nour Payroll Support (Demo)", nameAr: "نور — دعم الرواتب (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "A" }, roles: ["PAYROLL_SUPPORT"] }] },
  { key: "bankBAdmin", email: email("bankb.admin"), name: "Hisham Boundary Bank Admin (Demo)", nameAr: "هشام — مسؤول مصرف الحدود (تجريبي)", locale: "en",
    memberships: [{ scope: { bank: "B" }, roles: ["BANK_ADMIN_MAKER", "BANK_ADMIN_CHECKER"] }] },
  { key: "cMaker", email: email("c.maker"), name: "Souad Maker C (Demo)", nameAr: "سعاد — مُنشئة (تجريبي)", locale: "en",
    memberships: [{ scope: { corporate: "C" }, roles: ["MAKER"], perItem: lyd(1_000), daily: lyd(3_000),
      grants: [{ account: "C_OPERATING", read: true, debit: true }] }] },
];

export type PersonKey = (typeof PEOPLE)[number]["key"];

export const personId = (key: string) => fixtureUuid(`person:${key}`);
export const membershipId = (key: string, scope: string) => fixtureUuid(`membership:${key}:${scope}`);

/** Synthetic directory of recipient accounts at simulated other banks, with explicit scenarios. */
export const DIRECTORY = [
  { key: "SUPPLIER", reference: "DEMO-LY-900001", holderName: "Tripoli Office Supplies Demo", bankName: "Sahel Demo Bank", scenario: "SUCCESS" },
  { key: "NAME_MISMATCH", reference: "DEMO-LY-900002", holderName: "Misrata Steel Works Demo", bankName: "Sahel Demo Bank", scenario: "NAME_MISMATCH" },
  { key: "BLOCKED", reference: "DEMO-LY-900003", holderName: "Blocked Account Trading Demo", bankName: "Jabal Demo Bank", scenario: "ACCOUNT_BLOCKED" },
  { key: "TIMEOUT_AFTER", reference: "DEMO-LY-900004", holderName: "Response Lost Logistics Demo", bankName: "Jabal Demo Bank", scenario: "TIMEOUT_AFTER_BOOKING" },
  { key: "TIMEOUT_BEFORE", reference: "DEMO-LY-900005", holderName: "No Answer Services Demo", bankName: "Jabal Demo Bank", scenario: "TIMEOUT_BEFORE_PROCESSING" },
  { key: "ACH_DELAYED", reference: "DEMO-LY-900006", holderName: "Slow Clearing Supplies Demo", bankName: "Sahel Demo Bank", scenario: "ACH_DELAYED" },
  { key: "LATE_RETURN", reference: "DEMO-LY-900007", holderName: "Late Return Imports Demo", bankName: "Sahel Demo Bank", scenario: "LATE_RETURN" },
  { key: "CLOSE_MATCH", reference: "DEMO-LY-900008", holderName: "Close Match Catering Demo", bankName: "Jabal Demo Bank", scenario: "CLOSE_MATCH" },
  { key: "DUPLICATE_EVENT", reference: "DEMO-LY-900009", holderName: "Duplicate Notice Foods Demo", bankName: "Jabal Demo Bank", scenario: "DUPLICATE_EVENT" },
  { key: "OUT_OF_ORDER", reference: "DEMO-LY-900010", holderName: "Out Of Order Printing Demo", bankName: "Sahel Demo Bank", scenario: "OUT_OF_ORDER_EVENT" },
  { key: "RAIL_REJECT", reference: "DEMO-LY-900011", holderName: "Rail Reject Motors Demo", bankName: "Sahel Demo Bank", scenario: "RAIL_REJECT" },
] as const;

export type DirectoryKey = (typeof DIRECTORY)[number]["key"];
export const directory = (key: DirectoryKey) => DIRECTORY.find((entry) => entry.key === key) as (typeof DIRECTORY)[number];

/** Beneficiaries pre-registered for Corporate A (name-checked through the simulated core). */
export const BENEFICIARIES_A: Array<{ key: DirectoryKey; id: string; displayName: string }> = [
  { key: "SUPPLIER", id: fixtureUuid("beneficiary:A:SUPPLIER"), displayName: "Tripoli Office Supplies Demo" },
  { key: "TIMEOUT_AFTER", id: fixtureUuid("beneficiary:A:TIMEOUT_AFTER"), displayName: "Response Lost Logistics Demo" },
  { key: "TIMEOUT_BEFORE", id: fixtureUuid("beneficiary:A:TIMEOUT_BEFORE"), displayName: "No Answer Services Demo" },
  { key: "BLOCKED", id: fixtureUuid("beneficiary:A:BLOCKED"), displayName: "Blocked Account Trading Demo" },
  { key: "ACH_DELAYED", id: fixtureUuid("beneficiary:A:ACH_DELAYED"), displayName: "Slow Clearing Supplies Demo" },
  { key: "LATE_RETURN", id: fixtureUuid("beneficiary:A:LATE_RETURN"), displayName: "Late Return Imports Demo" },
  { key: "DUPLICATE_EVENT", id: fixtureUuid("beneficiary:A:DUPLICATE_EVENT"), displayName: "Duplicate Notice Foods Demo" },
  { key: "OUT_OF_ORDER", id: fixtureUuid("beneficiary:A:OUT_OF_ORDER"), displayName: "Out Of Order Printing Demo" },
  { key: "RAIL_REJECT", id: fixtureUuid("beneficiary:A:RAIL_REJECT"), displayName: "Rail Reject Motors Demo" },
];

export const beneficiaryId = (key: DirectoryKey) => (BENEFICIARIES_A.find((entry) => entry.key === key) as { id: string }).id;

/** Synthetic payroll staff of Corporate A (accounts at simulated other banks). */
export const EMPLOYEES_A = [
  { code: "EMP-001", name: "Demo Staff Amna", reference: "DEMO-LY-910001" },
  { code: "EMP-002", name: "Demo Staff Bashir", reference: "DEMO-LY-910002" },
  { code: "EMP-003", name: "Demo Staff Carima", reference: "DEMO-LY-910003" },
  { code: "EMP-004", name: "Demo Staff Dawud", reference: "DEMO-LY-910004" },
  { code: "EMP-005", name: "Demo Staff Eman", reference: "DEMO-LY-910005" },
  { code: "EMP-006", name: "Demo Staff Faraj", reference: "DEMO-LY-910006" },
  { code: "EMP-007", name: "Demo Staff Ghada", reference: "DEMO-LY-910007" },
  { code: "EMP-008", name: "Demo Staff Hadi", reference: "DEMO-LY-910008" },
] as const;

/** Bulk-file recipients DEMO-LY-920001…920100. Two carry failure scenarios for partial results. */
export const BULK_RECIPIENT_COUNT = 100;
export const bulkRecipientRef = (n: number) => `DEMO-LY-92${String(n).padStart(4, "0")}`;
export const bulkRecipientName = (n: number) => `Bulk Demo Supplier ${String(n).padStart(3, "0")}`;
export const BULK_SCENARIOS: Record<number, "ACCOUNT_BLOCKED" | "TIMEOUT_AFTER_BOOKING"> = { 91: "ACCOUNT_BLOCKED", 92: "TIMEOUT_AFTER_BOOKING" };

/** CUST-001 exists in BOTH A and B on purpose (code collision across corporates, COL-01/02). */
export const CUSTOMERS = [
  { corporate: "A", code: "CUST-001", displayName: "Benghazi Retail Demo", company: "Benghazi Retail Demo LLC", mobile: "+218912345601", industry: "Retail", tags: ["retail", "east"] },
  { corporate: "A", code: "CUST-002", displayName: "Zawiya Pharmacy Demo", company: "Zawiya Pharmacy Demo", mobile: "+218922345602", industry: "Healthcare", tags: ["pharmacy"] },
  { corporate: "A", code: "CUST-003", displayName: "Sebha Building Materials Demo", company: "Sebha Building Materials Demo", mobile: "+218942345603", industry: "Construction", tags: ["south"] },
  { corporate: "B", code: "CUST-001", displayName: "Sabha Stores Demo", company: "Sabha Stores Demo", mobile: "+218912345611", industry: "Retail", tags: ["retail"] },
] as const;

export const customerId = (corporate: CorporateKey, code: string) => fixtureUuid(`customer:${corporate}:${code}`);

/** Fixed fixture instant: Monday 2026-11-23 09:00 in Tripoli (document 07 "test date"). */
export const TEST_NOW = "2026-11-23T07:00:00.000Z";
export const RAIL_EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";
