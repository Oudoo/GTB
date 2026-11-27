/**
 * Pure batch and payroll rules: derived batch state (U-STA-05), row validation of import files
 * (U-IMP-05..07) and exact payroll arithmetic (U-PYR-01..04). No database, no clock.
 */
import { describe, expect, it } from "vitest";
import { acceptedSetHash, deriveBatchState, payrollNet, salaryChanged } from "@/server/domain/batches/state";
import { bulkBusinessKey, parseBulkRows, parsePayrollRows, payrollBusinessKey } from "@/server/domain/batches/validation";
import type { BoundRow } from "@/server/files/tabular";

const bound = (rows: Array<Record<string, string>>): BoundRow[] => rows.map((values, index) => ({ line: index + 2, values }));
const bulk = (overrides: Record<string, string> = {}) => ({ row_reference: "INV-1", beneficiary_name: "Synthetic Supplier", account_scheme: "DEMO_DOMESTIC", account_reference: "DEMO-LY-920001", amount: "10.000", currency: "LYD", purpose: "Synthetic invoice", ...overrides });
const pay = (overrides: Record<string, string> = {}) => ({ row_reference: "PAY-1", employee_code: "EMP-001", pay_period: "2026-11", component: "SALARY", basic: "1500.000", allowances: "200.000", deductions: "50.000", correction: "0.000", payslip_reference: "PS-1", correction_reference: "", currency: "LYD", ...overrides });
const BOTH = new Set(["SALARY", "ALLOWANCE"] as const);
const codes = (row: { errors: Array<{ code: string; field: string }> }) => row.errors.map((issue) => `${issue.field}:${issue.code}`);

describe("derived batch state (U-STA-05)", () => {
  const base = { accepted: 10, settled: 0, failed: 0, returned: 0, unknown: 0, inFlight: 0 };
  it("is complete only when every accepted row settled", () => {
    expect(deriveBatchState({ ...base, settled: 10 })).toBe("COMPLETED");
    expect(deriveBatchState({ ...base, settled: 9, failed: 1 })).toBe("PARTIALLY_COMPLETED");
    expect(deriveBatchState({ ...base, settled: 9, returned: 1 })).toBe("PARTIALLY_COMPLETED");
    expect(deriveBatchState({ ...base, failed: 10 })).toBe("FAILED");
  });
  it("never finishes while a row is unknown or in flight", () => {
    expect(deriveBatchState({ ...base, settled: 9, unknown: 1 })).toBe("PROCESSING");
    expect(deriveBatchState({ ...base, settled: 9, inFlight: 1 })).toBe("PROCESSING");
    expect(deriveBatchState({ ...base, failed: 9, unknown: 1 })).toBe("PROCESSING");
  });
  it("treats an empty accepted set as failed, never as complete", () => {
    expect(deriveBatchState({ ...base, accepted: 0 })).toBe("FAILED");
  });
});

describe("accepted-set digest (BAT-02)", () => {
  const rows = [
    { lineNumber: 2, businessKey: "BULK:A", amountMinor: 10_000n, destination: "DEMO_DOMESTIC:DEMO-LY-920001" },
    { lineNumber: 3, businessKey: "BULK:B", amountMinor: 20_000n, destination: "DEMO_DOMESTIC:DEMO-LY-920002" },
  ];
  it("does not depend on row order", () => {
    expect(acceptedSetHash(rows)).toBe(acceptedSetHash([...rows].reverse()));
  });
  it("changes when a row is removed, an amount changes or a destination changes", () => {
    const hash = acceptedSetHash(rows);
    expect(acceptedSetHash(rows.slice(0, 1))).not.toBe(hash);
    expect(acceptedSetHash([rows[0]!, { ...rows[1]!, amountMinor: 20_001n }])).not.toBe(hash);
    expect(acceptedSetHash([rows[0]!, { ...rows[1]!, destination: "DEMO_DOMESTIC:DEMO-LY-920003" }])).not.toBe(hash);
  });
});

describe("bulk row validation (U-IMP-05..07)", () => {
  it("accepts a clean row and converts the amount exactly", () => {
    const [row] = parseBulkRows(bound([bulk({ amount: "125.000" })]), { currency: "LYD" });
    expect(row).toMatchObject({ validationState: "VALID", amountMinor: 125_000n, errors: [], lineNumber: 2 });
  });
  it("marks a repeated row reference as a duplicate, case-insensitively (U-IMP-05)", () => {
    const rows = parseBulkRows(bound([bulk(), bulk({ row_reference: "inv-1", account_reference: "DEMO-LY-920002" })]), { currency: "LYD" });
    expect(rows.map((row) => row.validationState)).toEqual(["VALID", "DUPLICATE"]);
    expect(codes(rows[1]!)).toEqual(["row_reference:DUPLICATE_REFERENCE"]);
  });
  it("warns — and does not reject — when the same account appears twice", () => {
    const rows = parseBulkRows(bound([bulk(), bulk({ row_reference: "INV-2" })]), { currency: "LYD" });
    expect(rows.map((row) => row.validationState)).toEqual(["VALID", "VALID"]);
    expect(rows[1]!.warnings).toEqual([{ code: "REPEATED_ACCOUNT", field: "account_reference" }]);
  });
  it("rejects a row in another currency: one batch, one currency (U-IMP-06)", () => {
    const [row] = parseBulkRows(bound([bulk({ currency: "USD" })]), { currency: "LYD" });
    expect(row).toMatchObject({ validationState: "INVALID" });
    expect(codes(row!)).toEqual(["currency:CURRENCY_MISMATCH"]);
  });
  it("rejects zero, negative, four-decimal, exponent and non-numeric amounts without rounding", () => {
    const amounts = ["0.000", "-5.000", "10.0001", "1e3", "ten", ""];
    const rows = parseBulkRows(bound(amounts.map((amount, index) => bulk({ amount, row_reference: `INV-${index}`, account_reference: `DEMO-LY-92000${index + 1}` }))), { currency: "LYD" });
    expect(rows.map((row) => codes(row)[0])).toEqual(["amount:AMOUNT_NOT_POSITIVE", "amount:NEGATIVE_COMPONENT", "amount:AMOUNT_DECIMALS", "amount:AMOUNT_FORMAT", "amount:AMOUNT_FORMAT", "amount:REQUIRED"]);
    expect(rows.every((row) => row.amountMinor === null && row.validationState === "INVALID")).toBe(true);
  });
  it("rejects missing fields, a foreign account scheme, a malformed account and control characters", () => {
    const rows = parseBulkRows(
      bound([bulk({ beneficiary_name: "" }), bulk({ row_reference: "INV-2", account_scheme: "IBAN" }), bulk({ row_reference: "INV-3", account_reference: "LY83002048000020100120361" }), bulk({ row_reference: "INV-4", purpose: "line\u0000break" })]),
      { currency: "LYD" },
    );
    expect(rows.map((row) => codes(row)[0])).toEqual(["beneficiary_name:REQUIRED", "account_scheme:ACCOUNT_SCHEME", "account_reference:ACCOUNT_FORMAT", "purpose:UNSAFE_CHARACTERS"]);
  });
  it("yields no valid row when every line is wrong, so nothing can be accepted (U-IMP-07)", () => {
    const rows = parseBulkRows(bound([bulk({ amount: "x" }), bulk({ row_reference: "INV-2", currency: "EUR" })]), { currency: "LYD" });
    expect(rows.filter((row) => row.validationState === "VALID")).toHaveLength(0);
  });
  it("never puts a value from the file into a problem code", () => {
    const [row] = parseBulkRows(bound([bulk({ beneficiary_name: "Secret Holder\u0007", amount: "99999999999999999999" })]), { currency: "LYD" });
    expect(JSON.stringify(row!.errors)).not.toContain("Secret");
    expect(JSON.stringify(row!.errors)).not.toContain("9999");
  });
});

describe("payroll arithmetic and validation (U-PYR-01..04)", () => {
  it("computes net pay exactly, with a signed correction (U-PYR-01)", () => {
    expect(payrollNet({ basicMinor: 1_500_000n, allowancesMinor: 200_000n, deductionsMinor: 50_000n, correctionMinor: 0n })).toBe(1_650_000n);
    expect(payrollNet({ basicMinor: 1_500_000n, allowancesMinor: 0n, deductionsMinor: 0n, correctionMinor: -1n })).toBe(1_499_999n);
    const { rows } = parsePayrollRows(bound([pay({ basic: "0.001", allowances: "0.001", deductions: "0.001", correction: "0.001", correction_reference: "CORR-1" })]), { currency: "LYD", isCorrection: false, enabledComponents: BOTH });
    expect(rows[0]).toMatchObject({ validationState: "VALID", netMinor: 2n, correctionReference: "CORR-1" });
  });
  it("rejects negative components and a net that is not positive (U-PYR-02)", () => {
    const { rows } = parsePayrollRows(
      bound([pay({ basic: "-1.000" }), pay({ row_reference: "PAY-2", employee_code: "EMP-002", deductions: "-0.001" }), pay({ row_reference: "PAY-3", employee_code: "EMP-003", basic: "10.000", allowances: "0.000", deductions: "10.000" }), pay({ row_reference: "PAY-4", employee_code: "EMP-004", basic: "10.000", allowances: "0.000", deductions: "0.000", correction: "-10.001", correction_reference: "CORR-4" })]),
      { currency: "LYD", isCorrection: false, enabledComponents: BOTH },
    );
    expect(rows.map((row) => codes(row)[0])).toEqual(["basic:NEGATIVE_COMPONENT", "deductions:NEGATIVE_COMPONENT", "net:NET_NOT_POSITIVE", "net:NET_NOT_POSITIVE"]);
    expect(rows.every((row) => row.netMinor === null)).toBe(true);
  });
  it("rejects the same employee, period and component twice, and mixed pay periods (U-PYR-03)", () => {
    const { rows, payPeriod } = parsePayrollRows(
      bound([pay(), pay({ row_reference: "PAY-2" }), pay({ row_reference: "PAY-3", component: "ALLOWANCE" }), pay({ row_reference: "PAY-4", employee_code: "EMP-002", pay_period: "2026-10" })]),
      { currency: "LYD", isCorrection: false, enabledComponents: BOTH },
    );
    expect(payPeriod).toBe("2026-11");
    expect(rows.map((row) => row.validationState)).toEqual(["VALID", "DUPLICATE", "VALID", "INVALID"]);
    expect(codes(rows[1]!)).toEqual(["employee_code:DUPLICATE_SALARY"]);
    expect(codes(rows[3]!)).toEqual(["pay_period:PAY_PERIOD_MIXED"]);
  });
  it("requires an explicit correction reference for a correcting line and refuses a stray one", () => {
    const { rows } = parsePayrollRows(
      bound([pay({ correction: "25.000" }), pay({ row_reference: "PAY-2", employee_code: "EMP-002", correction_reference: "CORR-9" })]),
      { currency: "LYD", isCorrection: false, enabledComponents: BOTH },
    );
    expect(codes(rows[0]!)).toEqual(["correction_reference:CORRECTION_REFERENCE_REQUIRED"]);
    expect(codes(rows[1]!)).toEqual(["correction_reference:CORRECTION_REFERENCE_UNEXPECTED"]);
    const correctionRun = parsePayrollRows(bound([pay()]), { currency: "LYD", isCorrection: true, enabledComponents: BOTH });
    expect(codes(correctionRun.rows[0]!)).toEqual(["correction_reference:CORRECTION_REFERENCE_REQUIRED"]);
  });
  it("refuses a component the agreement does not enable, and an unknown one", () => {
    const { rows } = parsePayrollRows(bound([pay({ component: "ALLOWANCE" }), pay({ row_reference: "PAY-2", employee_code: "EMP-002", component: "BONUS" })]), { currency: "LYD", isCorrection: false, enabledComponents: new Set(["SALARY"] as const) });
    expect(rows.map((row) => codes(row)[0])).toEqual(["component:COMPONENT_DISABLED", "component:COMPONENT_INVALID"]);
  });
  it("flags a change of 20% or more against the last confirmed pay, in exact integers (U-PYR-04)", () => {
    expect(salaryChanged(1_000_000n, 1_200_000n, 2_000)).toBe(true);
    expect(salaryChanged(1_000_000n, 1_199_999n, 2_000)).toBe(false);
    expect(salaryChanged(1_000_000n, 800_000n, 2_000)).toBe(true);
    expect(salaryChanged(1_000_000n, 800_001n, 2_000)).toBe(false);
    expect(salaryChanged(null, 5_000_000n, 2_000)).toBe(false);
    expect(salaryChanged(0n, 5_000_000n, 2_000)).toBe(false);
  });
});

describe("business identity of rows (BAT-03, PYR-01)", () => {
  it("is independent of the file and of letter case", () => {
    expect(bulkBusinessKey("inv-1")).toBe(bulkBusinessKey("INV-1"));
    const salary = payrollBusinessKey({ employeeCode: "EMP-001", payPeriod: "2026-11", component: "SALARY", correctionReference: null });
    expect(salary).toBe(payrollBusinessKey({ employeeCode: "EMP-001", payPeriod: "2026-11", component: "SALARY", correctionReference: null }));
    expect(salary).not.toBe(payrollBusinessKey({ employeeCode: "EMP-001", payPeriod: "2026-11", component: "ALLOWANCE", correctionReference: null }));
    expect(salary).not.toBe(payrollBusinessKey({ employeeCode: "EMP-001", payPeriod: "2026-12", component: "SALARY", correctionReference: null }));
    // A correction is its own instruction, named by its reference.
    expect(salary).not.toBe(payrollBusinessKey({ employeeCode: "EMP-001", payPeriod: "2026-11", component: "SALARY", correctionReference: "CORR-1" }));
  });
});
