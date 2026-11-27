/**
 * The 33-module catalogue (AGR-03). This is immutable product metadata: the database table
 * `ModuleDefinition` is populated from exactly this list by a migration and a test asserts the
 * two are identical. Delivery status (what this release ships) is separate from agreement
 * status (what a bank has enabled for one corporate).
 */

export type DeliveryStatus = "R1_CORE" | "R1_SUBSET" | "R1_FOUNDATION" | "R2" | "R3";

export type TransactionTypeCode =
  | "INSTANT_ACCOUNT_CREDIT"
  | "ACH_CREDIT"
  | "OWN_ACCOUNT_TRANSFER"
  | "BULK_CREDIT"
  | "PAYROLL_SALARY"
  | "PAYROLL_ALLOWANCE"
  | "BRANCH_CASH_DEPOSIT"
  | "BRANCH_CHEQUE_DEPOSIT";

export type RailCode = "LYPAY" | "ACH" | "INTERNAL" | "BRANCH";

export type ModuleDefinition = Readonly<{
  catalogueId: string;
  domainNo: number;
  sortOrder: number;
  name: string;
  nameAr: string;
  deliveryStatus: DeliveryStatus;
  /** What the catalogue says daily/monthly limits count for this module. */
  limitBasis: string;
  /** Rails named by the catalogue (informational). */
  rails: readonly string[];
  /** Transaction types executable in R1. Empty for deferred or non-transactional modules. */
  r1TransactionTypes: readonly TransactionTypeCode[];
  /** Printed catalogue pages. */
  sourcePages: string;
}>;

export const DOMAINS: ReadonlyArray<{ no: number; name: string; nameAr: string }> = [
  { no: 1, name: "Payments and clearing", nameAr: "المدفوعات والمقاصة" },
  { no: 2, name: "Bulk transfers and payroll", nameAr: "التحويلات المجمعة والرواتب" },
  { no: 3, name: "Collections and cash monitoring", nameAr: "التحصيل ومتابعة النقد" },
  { no: 4, name: "Virtual account management", nameAr: "إدارة الحسابات الافتراضية" },
  { no: 5, name: "Conditional payments", nameAr: "المدفوعات المشروطة" },
  { no: 6, name: "Trade finance", nameAr: "تمويل التجارة" },
  { no: 7, name: "Liquidity", nameAr: "السيولة" },
  { no: 8, name: "Cheques", nameAr: "الصكوك" },
  { no: 9, name: "Cards", nameAr: "البطاقات" },
  { no: 10, name: "Connectivity", nameAr: "الربط والتكامل" },
  { no: 11, name: "Insight", nameAr: "التقارير والتحليل" },
  { no: 12, name: "Administration", nameAr: "الإدارة والصلاحيات" },
];

const m = (
  catalogueId: string,
  name: string,
  nameAr: string,
  deliveryStatus: DeliveryStatus,
  limitBasis: string,
  rails: string[],
  r1TransactionTypes: TransactionTypeCode[],
  sourcePages: string,
): Omit<ModuleDefinition, "sortOrder" | "domainNo"> => ({
  catalogueId,
  name,
  nameAr,
  deliveryStatus,
  limitBasis,
  rails,
  r1TransactionTypes,
  sourcePages,
});

const RAW = [
  m("1.1", "Instant payments", "المدفوعات الفورية", "R1_SUBSET", "Amount", ["LYPay"], ["INSTANT_ACCOUNT_CREDIT"], "1,5"),
  m("1.2", "ACH", "المقاصة الآلية (ACH)", "R1_SUBSET", "Amount, items", ["ACH"], ["ACH_CREDIT"], "1,5"),
  m("1.3", "RTGS", "التسوية الإجمالية الآنية (RTGS)", "R2", "Amount", ["RTGS"], [], "1,5"),
  m("1.4", "SWIFT payments", "مدفوعات سويفت", "R3", "Amount per currency", ["SWIFT"], [], "1,6"),
  m("1.5", "Own-account and scheduled transfers", "التحويل بين حسابات الشركة والتحويلات المجدولة", "R1_SUBSET", "Amount", ["Internal"], ["OWN_ACCOUNT_TRANSFER"], "1,6"),
  m("2.1", "Bulk transfers", "التحويلات المجمعة", "R1_SUBSET", "Batch total, items", ["LYPay", "ACH"], ["BULK_CREDIT"], "2,6"),
  m("2.2", "Payroll", "الرواتب", "R1_SUBSET", "Batch total, items", ["ACH", "LYPay"], ["PAYROLL_SALARY", "PAYROLL_ALLOWANCE"], "2,7"),
  m("3.1", "Customer ID and collection list", "رمز العميل وقائمة التحصيل", "R1_CORE", "n/a", [], [], "2,8-9"),
  m("3.2", "Branch deposits by customer code", "الإيداع في الفروع برمز العميل", "R1_SUBSET", "Amount per deposit", ["Branch", "ACH"], ["BRANCH_CASH_DEPOSIT", "BRANCH_CHEQUE_DEPOSIT"], "2,9"),
  m("3.3", "Deposit summary and receipts", "ملخص الإيداعات والإيصالات", "R1_CORE", "n/a", [], [], "2,9"),
  m("3.4", "Payment links", "روابط الدفع", "R2", "Amount", ["LYPay", "card"], [], "2,9"),
  m("3.5", "QR collections", "التحصيل برمز الاستجابة السريعة", "R2", "Amount", ["LYPay"], [], "2,9"),
  m("4.1", "Virtual account structure", "هيكل الحسابات الافتراضية", "R2", "Items", ["Internal"], [], "2,10"),
  m("4.2", "Auto-reconciliation and sweeping", "المطابقة الآلية والتجميع", "R2", "Amount", ["Internal"], [], "2,10"),
  m("5.1", "Certified cheque", "الصك المصدق", "R3", "Amount held", ["ACH"], [], "2,11"),
  m("5.2", "LG/LC escrow", "حساب الضمان للاعتمادات وخطابات الضمان", "R3", "Amount held", ["ACH", "RTGS"], [], "2,11"),
  m("6.1", "Documentary collections", "التحصيلات المستندية", "R3", "Exposure", ["SWIFT", "ACH"], [], "2,12"),
  m("6.2", "Letters of credit", "الاعتمادات المستندية", "R3", "Exposure", ["SWIFT"], [], "2,12"),
  m("6.3", "Guarantees", "خطابات الضمان", "R3", "Exposure", ["SWIFT"], [], "2,12"),
  m("7.1", "Cash concentration", "تركيز النقد", "R2", "Amount", ["Internal"], [], "2,13"),
  m("7.2", "Liquidity alerts", "تنبيهات السيولة", "R1_SUBSET", "n/a", [], [], "2,13"),
  m("8.1", "Cheque issuance", "إصدار الصكوك", "R3", "Amount, items", ["ACH"], [], "2,13"),
  m("8.2", "Cheque management", "إدارة الصكوك", "R3", "Items", ["ACH"], [], "3,13"),
  m("9.1", "Corporate debit and prepaid cards", "بطاقات الخصم والبطاقات المسبقة الدفع للشركات", "R3", "Amount", ["Card network"], [], "3,13"),
  m("9.2", "Corporate credit cards", "بطاقات الائتمان للشركات", "R3", "Credit limit", ["Card network"], [], "3,14"),
  m("10.1", "API connectivity", "الربط عبر واجهات برمجة التطبيقات", "R1_FOUNDATION", "Calls", ["API"], [], "3,14-16"),
  m("10.2", "Host-to-host and file exchange", "الربط المباشر وتبادل الملفات", "R2", "Items", ["File"], [], "3,14"),
  m("10.3", "ERP connectors", "موصلات أنظمة تخطيط الموارد", "R3", "n/a", ["API"], [], "3,14"),
  m("11.1", "Statements and reports", "كشوف الحساب والتقارير", "R1_SUBSET", "n/a", [], [], "3,14"),
  m("11.2", "Cash forecasting", "توقعات التدفق النقدي", "R2", "n/a", [], [], "3,14"),
  m("12.1", "Users and roles", "المستخدمون والأدوار", "R1_CORE", "n/a", [], [], "3-5,14"),
  m("12.2", "Approval matrix", "مصفوفة الاعتماد", "R1_CORE", "n/a", [], [], "3-5,15"),
  m("12.3", "Agreement and limits console", "لوحة الاتفاقية والحدود", "R1_CORE", "n/a", [], [], "3-5,15"),
] as const;

export const MODULE_REGISTRY: readonly ModuleDefinition[] = RAW.map((entry, index) => ({
  ...entry,
  domainNo: Number(entry.catalogueId.split(".")[0]),
  sortOrder: index + 1,
}));

const BY_ID = new Map(MODULE_REGISTRY.map((entry) => [entry.catalogueId, entry]));

export function getModule(catalogueId: string): ModuleDefinition | undefined {
  return BY_ID.get(catalogueId);
}

/** A module may be switched on in an agreement only if this release delivers it. */
export function isDeliveredInR1(definition: ModuleDefinition): boolean {
  return definition.deliveryStatus.startsWith("R1");
}

export const R1_MODULE_IDS: readonly string[] = MODULE_REGISTRY.filter(isDeliveredInR1).map(
  (entry) => entry.catalogueId,
);

/** The rail each R1 transaction type may use. Payroll runs on ACH in R1 (document 01). */
export const TYPE_RAILS: Readonly<Record<TransactionTypeCode, readonly RailCode[]>> = {
  INSTANT_ACCOUNT_CREDIT: ["LYPAY"],
  ACH_CREDIT: ["ACH"],
  OWN_ACCOUNT_TRANSFER: ["INTERNAL"],
  BULK_CREDIT: ["LYPAY", "ACH"],
  PAYROLL_SALARY: ["ACH"],
  PAYROLL_ALLOWANCE: ["ACH"],
  BRANCH_CASH_DEPOSIT: ["BRANCH"],
  BRANCH_CHEQUE_DEPOSIT: ["BRANCH"],
};

export const TYPE_MODULE: Readonly<Record<TransactionTypeCode, string>> = {
  INSTANT_ACCOUNT_CREDIT: "1.1",
  ACH_CREDIT: "1.2",
  OWN_ACCOUNT_TRANSFER: "1.5",
  BULK_CREDIT: "2.1",
  PAYROLL_SALARY: "2.2",
  PAYROLL_ALLOWANCE: "2.2",
  BRANCH_CASH_DEPOSIT: "3.2",
  BRANCH_CHEQUE_DEPOSIT: "3.2",
};

export const TRANSACTION_TYPES = Object.keys(TYPE_MODULE) as TransactionTypeCode[];

/** Outgoing (debit) transaction types that consume outgoing limits (LIM-02). */
export const OUTGOING_TYPES: readonly TransactionTypeCode[] = [
  "INSTANT_ACCOUNT_CREDIT",
  "ACH_CREDIT",
  "OWN_ACCOUNT_TRANSFER",
  "BULK_CREDIT",
  "PAYROLL_SALARY",
  "PAYROLL_ALLOWANCE",
];
