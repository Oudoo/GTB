/**
 * Row-level validation of bulk and payroll files (BAT-01, BAT-02, PYR-01, Appendix A).
 *
 * Pure functions: they take rows already bound to a template and return a draft per row with
 * problem CODES. A code never carries a value from the file, so validation results can be
 * shown, stored and logged without leaking a name, an account or a salary.
 * Amounts are parsed from decimal text to exact minor units; nothing passes through a float.
 */
import { DEMO_ACCOUNT_PATTERN, DEMO_ACCOUNT_SCHEME, hasUnsafeCharacters, normalizeAccountReference } from "@/contracts/common";
import type { RowErrorCode, RowIssue, RowWarningCode } from "@/contracts/batches";
import { MAX_MINOR, MoneyError, parseDecimalAmount, type Currency } from "@/contracts/money";
import type { BoundRow } from "@/server/files/tabular";
import { payrollNet } from "./state";

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9 ._\-/#]{0,63}$/;
const PAY_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

type Issues = { errors: RowIssue[]; warnings: RowIssue<RowWarningCode>[] };

function text(issues: Issues, field: string, value: string, options: { required: boolean; max: number }): string | null {
  if (value === "") {
    if (options.required) issues.errors.push({ code: "REQUIRED", field });
    return null;
  }
  if (hasUnsafeCharacters(value)) {
    issues.errors.push({ code: "UNSAFE_CHARACTERS", field });
    return null;
  }
  if (value.length > options.max) {
    issues.errors.push({ code: "TOO_LONG", field });
    return null;
  }
  return value;
}

function reference(issues: Issues, field: string, value: string, required: boolean): string | null {
  const checked = text(issues, field, value, { required, max: 64 });
  if (checked === null) return null;
  if (!REFERENCE.test(checked)) {
    issues.errors.push({ code: "REFERENCE_FORMAT", field });
    return null;
  }
  return checked;
}

function amount(issues: Issues, field: string, value: string, currency: Currency, options: { signed?: boolean; allowZero: boolean }): bigint | null {
  if (value === "") {
    issues.errors.push({ code: "REQUIRED", field });
    return null;
  }
  try {
    const minor = parseDecimalAmount(value, currency, { allowNegative: options.signed === true });
    if (!options.signed && minor < 0n) {
      issues.errors.push({ code: "NEGATIVE_COMPONENT", field });
      return null;
    }
    if (!options.allowZero && minor <= 0n) {
      issues.errors.push({ code: "AMOUNT_NOT_POSITIVE", field });
      return null;
    }
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      issues.errors.push({ code: "AMOUNT_OUT_OF_RANGE", field });
      return null;
    }
    return minor;
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    const code: RowErrorCode =
      error.code === "TOO_MANY_DECIMALS" ? "AMOUNT_DECIMALS" : error.code === "AMOUNT_OUT_OF_RANGE" ? "AMOUNT_OUT_OF_RANGE" : value.trim().startsWith("-") && !options.signed ? "NEGATIVE_COMPONENT" : "AMOUNT_FORMAT";
    issues.errors.push({ code, field });
    return null;
  }
}

export type BulkRowDraft = {
  lineNumber: number;
  rowReference: string | null;
  validationState: "VALID" | "INVALID" | "DUPLICATE";
  errors: RowIssue[];
  warnings: RowIssue<RowWarningCode>[];
  amountMinor: bigint | null;
  currency: string | null;
  beneficiaryName: string | null;
  accountScheme: string | null;
  accountReference: string | null;
  purpose: string | null;
  beneficiaryReference: string | null;
};

/** Structural validation of bulk rows, in-file duplicate references and repeated accounts. */
export function parseBulkRows(rows: readonly BoundRow[], facts: { currency: Currency }): BulkRowDraft[] {
  const seenReferences = new Set<string>();
  const seenAccounts = new Set<string>();
  return rows.map((row) => {
    const issues: Issues = { errors: [], warnings: [] };
    const value = (column: string) => row.values[column] ?? "";
    const rowReference = reference(issues, "row_reference", value("row_reference"), true);
    const beneficiaryName = text(issues, "beneficiary_name", value("beneficiary_name"), { required: true, max: 160 });
    const purpose = text(issues, "purpose", value("purpose"), { required: true, max: 140 });
    const beneficiaryReference = reference(issues, "beneficiary_reference", value("beneficiary_reference"), false);
    const amountMinor = amount(issues, "amount", value("amount"), facts.currency, { allowZero: false });

    let currency: string | null = value("currency").toUpperCase();
    if (currency === "") {
      issues.errors.push({ code: "REQUIRED", field: "currency" });
      currency = null;
    } else if (currency !== facts.currency) {
      // One batch, one currency: the source account's (BAT-03).
      issues.errors.push({ code: "CURRENCY_MISMATCH", field: "currency" });
    }

    let accountScheme: string | null = value("account_scheme").toUpperCase();
    if (accountScheme !== DEMO_ACCOUNT_SCHEME) {
      issues.errors.push({ code: accountScheme === "" ? "REQUIRED" : "ACCOUNT_SCHEME", field: "account_scheme" });
      accountScheme = null;
    }
    let accountReference: string | null = normalizeAccountReference(value("account_reference"));
    if (!DEMO_ACCOUNT_PATTERN.test(accountReference)) {
      issues.errors.push({ code: accountReference === "" ? "REQUIRED" : "ACCOUNT_FORMAT", field: "account_reference" });
      accountReference = null;
    }

    let duplicate = false;
    if (rowReference !== null) {
      const key = rowReference.toUpperCase();
      if (seenReferences.has(key)) {
        duplicate = true;
        issues.errors.push({ code: "DUPLICATE_REFERENCE", field: "row_reference" });
      }
      seenReferences.add(key);
    }
    if (accountReference !== null) {
      // The same account twice is allowed for bulk, but the maker must acknowledge it.
      if (seenAccounts.has(accountReference)) issues.warnings.push({ code: "REPEATED_ACCOUNT", field: "account_reference" });
      seenAccounts.add(accountReference);
    }

    return {
      lineNumber: row.line,
      rowReference,
      validationState: duplicate ? "DUPLICATE" : issues.errors.length > 0 ? "INVALID" : "VALID",
      errors: issues.errors,
      warnings: issues.warnings,
      amountMinor,
      currency,
      beneficiaryName,
      accountScheme,
      accountReference,
      purpose,
      beneficiaryReference,
    };
  });
}

export type PayrollComponentCode = "SALARY" | "ALLOWANCE";

export type PayrollRowDraft = {
  lineNumber: number;
  rowReference: string | null;
  validationState: "VALID" | "INVALID" | "DUPLICATE";
  errors: RowIssue[];
  warnings: RowIssue<RowWarningCode>[];
  employeeCode: string;
  payPeriod: string;
  component: PayrollComponentCode | null;
  basicMinor: bigint | null;
  allowancesMinor: bigint | null;
  deductionsMinor: bigint | null;
  correctionMinor: bigint | null;
  netMinor: bigint | null;
  payslipReference: string | null;
  correctionReference: string | null;
};

/**
 * Structural validation of payroll rows: one pay period per run, enabled components only,
 * exact net pay that must be positive, and one line per employee, period and component.
 */
export function parsePayrollRows(
  rows: readonly BoundRow[],
  facts: { currency: Currency; isCorrection: boolean; enabledComponents: ReadonlySet<PayrollComponentCode> },
): { rows: PayrollRowDraft[]; payPeriod: string | null } {
  const seenReferences = new Set<string>();
  const seenSalaries = new Set<string>();
  let runPeriod: string | null = null;

  const drafts = rows.map((row): PayrollRowDraft => {
    const issues: Issues = { errors: [], warnings: [] };
    const value = (column: string) => row.values[column] ?? "";
    const rowReference = reference(issues, "row_reference", value("row_reference"), true);
    const employeeCode = reference(issues, "employee_code", value("employee_code").toUpperCase(), true) ?? "";
    const payslipReference = reference(issues, "payslip_reference", value("payslip_reference"), true);
    const correctionReference = reference(issues, "correction_reference", value("correction_reference"), false);

    const payPeriod = value("pay_period");
    if (!PAY_PERIOD.test(payPeriod)) {
      issues.errors.push({ code: payPeriod === "" ? "REQUIRED" : "PAY_PERIOD_FORMAT", field: "pay_period" });
    } else if (runPeriod === null) {
      runPeriod = payPeriod;
    } else if (payPeriod !== runPeriod) {
      issues.errors.push({ code: "PAY_PERIOD_MIXED", field: "pay_period" });
    }

    const rawComponent = value("component").toUpperCase();
    let component: PayrollComponentCode | null = null;
    if (rawComponent !== "SALARY" && rawComponent !== "ALLOWANCE") {
      issues.errors.push({ code: rawComponent === "" ? "REQUIRED" : "COMPONENT_INVALID", field: "component" });
    } else if (!facts.enabledComponents.has(rawComponent)) {
      issues.errors.push({ code: "COMPONENT_DISABLED", field: "component" });
    } else {
      component = rawComponent;
    }

    if (value("currency").toUpperCase() !== facts.currency) {
      issues.errors.push({ code: value("currency") === "" ? "REQUIRED" : "CURRENCY_MISMATCH", field: "currency" });
    }

    const basicMinor = amount(issues, "basic", value("basic"), facts.currency, { allowZero: true });
    const allowancesMinor = amount(issues, "allowances", value("allowances"), facts.currency, { allowZero: true });
    const deductionsMinor = amount(issues, "deductions", value("deductions"), facts.currency, { allowZero: true });
    const correctionMinor = amount(issues, "correction", value("correction"), facts.currency, { allowZero: true, signed: true });

    let netMinor: bigint | null = null;
    if (basicMinor !== null && allowancesMinor !== null && deductionsMinor !== null && correctionMinor !== null) {
      netMinor = payrollNet({ basicMinor, allowancesMinor, deductionsMinor, correctionMinor });
      if (netMinor <= 0n) {
        issues.errors.push({ code: "NET_NOT_POSITIVE", field: "net" });
        netMinor = null;
      } else if (netMinor > MAX_MINOR) {
        issues.errors.push({ code: "AMOUNT_OUT_OF_RANGE", field: "net" });
        netMinor = null;
      }
    }

    // A correcting line is identified explicitly; an ordinary line must not carry one.
    const correcting = facts.isCorrection || (correctionMinor !== null && correctionMinor !== 0n);
    if (correcting && correctionReference === null && !issues.errors.some((issue) => issue.field === "correction_reference")) {
      issues.errors.push({ code: "CORRECTION_REFERENCE_REQUIRED", field: "correction_reference" });
    }
    if (!correcting && correctionReference !== null) issues.errors.push({ code: "CORRECTION_REFERENCE_UNEXPECTED", field: "correction_reference" });

    let duplicate = false;
    if (rowReference !== null) {
      const key = rowReference.toUpperCase();
      if (seenReferences.has(key)) {
        duplicate = true;
        issues.errors.push({ code: "DUPLICATE_REFERENCE", field: "row_reference" });
      }
      seenReferences.add(key);
    }
    if (employeeCode !== "" && component !== null && PAY_PERIOD.test(payPeriod)) {
      const key = `${employeeCode}|${payPeriod}|${component}|${correcting ? (correctionReference ?? "") : ""}`;
      if (seenSalaries.has(key)) {
        duplicate = true;
        issues.errors.push({ code: "DUPLICATE_SALARY", field: "employee_code" });
      }
      seenSalaries.add(key);
    }

    return {
      lineNumber: row.line,
      rowReference,
      validationState: duplicate ? "DUPLICATE" : issues.errors.length > 0 ? "INVALID" : "VALID",
      errors: issues.errors,
      warnings: issues.warnings,
      employeeCode,
      payPeriod,
      component,
      basicMinor,
      allowancesMinor,
      deductionsMinor,
      correctionMinor,
      netMinor,
      payslipReference,
      correctionReference: correcting ? correctionReference : null,
    };
  });
  return { rows: drafts, payPeriod: runPeriod };
}

/** Business identity of one bulk row: unique per corporate, whatever the file is called. */
export function bulkBusinessKey(rowReference: string): string {
  return `BULK:${rowReference.toUpperCase()}`;
}

/**
 * Business identity of one salary line: employee, period and component — independent of the
 * file name, the row reference and the request. A correction is a distinct instruction named
 * by its explicit correction reference (PYR-01).
 */
export function payrollBusinessKey(row: { employeeCode: string; payPeriod: string; component: PayrollComponentCode; correctionReference: string | null }): string {
  const base = `PAYROLL:${row.employeeCode.toUpperCase()}:${row.payPeriod}:${row.component}`;
  return row.correctionReference ? `${base}:C:${row.correctionReference.toUpperCase()}` : base;
}
