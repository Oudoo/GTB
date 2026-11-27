/**
 * RESTRICTED payroll storage access (SEC-04, PYR-02).
 *
 * Employee identity, accounts and per-person amounts live only in `PayrollEmployee` and
 * `PayrollRowDetail`. Every function that reads them needs a `PayrollDetailCapability`, and a
 * capability can be obtained in exactly two ways:
 *   - `requirePayrollDetail(ctx)` — a corporate member holding `payroll.detail`;
 *   - `engineCapability(...)`     — the execution engine, which must know an amount to book it
 *                                    and never returns it to any caller.
 * Checkers, finance, viewers, administrators, API credentials and bank staff cannot obtain one,
 * so no projection written for them can reach this data by mistake: it does not type-check.
 */
import type { RowIssue, RowWarningCode } from "@/contracts/batches";
import { denied } from "@/contracts/errors";
import { requireCorporate, type AuthContext } from "@/server/auth/context";
import type { DbOrTx, Tx } from "@/server/db/client";
import type { BatchTransactionType } from "@/server/domain/batches/policy";
import { payrollBusinessKey, type PayrollRowDraft } from "@/server/domain/batches/validation";

declare const capability: unique symbol;
export type PayrollDetailCapability = { readonly [capability]: true; readonly corporateId: string; readonly holder: "OFFICER" | "ENGINE" };

/** A corporate member with the payroll-detail permission. Nobody else gets a capability. */
export function requirePayrollDetail(ctx: AuthContext): PayrollDetailCapability {
  const corporateCtx = requireCorporate(ctx);
  if (!corporateCtx.permissions.has("payroll.detail")) throw denied();
  return { corporateId: corporateCtx.corporateId, holder: "OFFICER" } as PayrollDetailCapability;
}

/**
 * Engine-only capability: validation, acceptance and booking need amounts and destinations.
 * Code that uses it must never place what it reads into a response, an audit row, an event,
 * a notification or a log line.
 */
export function engineCapability(corporateId: string): PayrollDetailCapability {
  return { corporateId, holder: "ENGINE" } as PayrollDetailCapability;
}

export const COMPONENT_TYPE = { SALARY: "PAYROLL_SALARY", ALLOWANCE: "PAYROLL_ALLOWANCE" } as const satisfies Record<string, BatchTransactionType>;

export type EmployeeSnapshot = { id: string; employeeCode: string; name: string; accountScheme: string; accountReference: string; active: boolean; accountMatchStatus: string };

export async function loadEmployees(db: DbOrTx, cap: PayrollDetailCapability, codes: readonly string[]): Promise<Map<string, EmployeeSnapshot>> {
  const rows = await db.payrollEmployee.findMany({ where: { corporateId: cap.corporateId, employeeCode: { in: [...new Set(codes)] } } });
  return new Map(rows.map((row) => [row.employeeCode, row]));
}

/**
 * Last CONFIRMED net pay per employee and component before `payPeriod` — the baseline for the
 * salary-change warning. Only settled lines count.
 */
export async function loadBaselines(
  db: DbOrTx,
  cap: PayrollDetailCapability,
  employeeIds: readonly string[],
  payPeriod: string,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (employeeIds.length === 0) return out;
  const rows = await db.payrollRowDetail.findMany({
    where: { corporateId: cap.corporateId, employeeId: { in: [...employeeIds] }, payPeriod: { lt: payPeriod }, netMinor: { not: null }, row: { executionState: "SETTLED" } },
    select: { employeeId: true, component: true, payPeriod: true, netMinor: true },
    orderBy: { payPeriod: "desc" },
  });
  for (const row of rows) {
    const key = `${row.employeeId}|${row.component}`;
    if (!out.has(key) && row.netMinor !== null) out.set(key, row.netMinor);
  }
  return out;
}

/** Store the restricted part of validated payroll rows next to their public row shells. */
export async function insertPayrollDetails(
  tx: Tx,
  cap: PayrollDetailCapability,
  rows: ReadonlyArray<{ rowId: string; draft: PayrollRowDraft; employee: EmployeeSnapshot | null; previousNetMinor: bigint | null; changeFlag: boolean }>,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.payrollRowDetail.createMany({
    data: rows.map(({ rowId, draft, employee, previousNetMinor, changeFlag }) => ({
      batchRowId: rowId,
      corporateId: cap.corporateId,
      employeeId: employee?.id ?? null,
      employeeCode: draft.employeeCode,
      // Snapshot of the reviewed employee master at validation time; never taken from the file.
      employeeName: employee?.name ?? null,
      accountScheme: employee?.accountScheme ?? null,
      accountReference: employee?.accountReference ?? null,
      payPeriod: draft.payPeriod,
      component: draft.component,
      basicMinor: draft.basicMinor,
      allowancesMinor: draft.allowancesMinor,
      deductionsMinor: draft.deductionsMinor,
      correctionMinor: draft.correctionMinor,
      netMinor: draft.netMinor,
      payslipReference: draft.payslipReference,
      correctionReference: draft.correctionReference,
      previousNetMinor,
      changeFlag,
    })),
  });
}

export type RowExecutionFacts = {
  rowId: string;
  lineNumber: number;
  businessKey: string;
  transactionType: BatchTransactionType;
  amountMinor: bigint;
  destinationScheme: string;
  destinationReference: string;
  destinationName: string;
};

/** Booking facts of payroll rows (all valid rows, or only the given ones). ENGINE USE. */
export async function loadPayrollFacts(db: DbOrTx, cap: PayrollDetailCapability, batchId: string, rowIds?: readonly string[]): Promise<RowExecutionFacts[]> {
  const details = await db.payrollRowDetail.findMany({
    where: { corporateId: cap.corporateId, row: { batchId, validationState: "VALID", ...(rowIds ? { id: { in: [...rowIds] } } : {}) } },
    include: { row: { select: { id: true, lineNumber: true } } },
  });
  const facts: RowExecutionFacts[] = [];
  for (const detail of details) {
    if (detail.netMinor === null || detail.component === null || !detail.accountScheme || !detail.accountReference) continue;
    facts.push({
      rowId: detail.row.id,
      lineNumber: detail.row.lineNumber,
      businessKey: payrollBusinessKey({ employeeCode: detail.employeeCode, payPeriod: detail.payPeriod, component: detail.component, correctionReference: detail.correctionReference }),
      transactionType: COMPONENT_TYPE[detail.component],
      amountMinor: detail.netMinor,
      destinationScheme: detail.accountScheme,
      destinationReference: detail.accountReference,
      destinationName: detail.employeeName ?? detail.employeeCode,
    });
  }
  return facts.sort((a, b) => a.lineNumber - b.lineNumber);
}

/** How many accepted lines carry a salary-change flag — a COUNT, safe for the approver. */
export async function countChangeFlags(db: DbOrTx, cap: PayrollDetailCapability, batchId: string): Promise<number> {
  return db.payrollRowDetail.count({ where: { corporateId: cap.corporateId, changeFlag: true, row: { batchId, accepted: true } } });
}

export type PayrollRowDetailView = {
  employeeCode: string;
  employeeName: string | null;
  maskedAccount: string | null;
  payPeriod: string;
  component: string | null;
  basicMinor: string | null;
  allowancesMinor: string | null;
  deductionsMinor: string | null;
  correctionMinor: string | null;
  netMinor: string | null;
  previousNetMinor: string | null;
  changeFlag: boolean;
  payslipReference: string | null;
  correctionReference: string | null;
};

/** Officer projection of the restricted part of rows, keyed by row id. */
export async function loadPayrollRowDetails(db: DbOrTx, cap: PayrollDetailCapability, rowIds: readonly string[]): Promise<Map<string, PayrollRowDetailView>> {
  if (cap.holder !== "OFFICER") throw denied();
  const details = await db.payrollRowDetail.findMany({ where: { corporateId: cap.corporateId, batchRowId: { in: [...rowIds] } } });
  const text = (value: bigint | null) => (value === null ? null : value.toString());
  return new Map(
    details.map((detail) => [
      detail.batchRowId,
      {
        employeeCode: detail.employeeCode,
        employeeName: detail.employeeName,
        maskedAccount: detail.accountReference ? `${detail.accountReference.slice(0, 8)}••${detail.accountReference.slice(-4)}` : null,
        payPeriod: detail.payPeriod,
        component: detail.component,
        basicMinor: text(detail.basicMinor),
        allowancesMinor: text(detail.allowancesMinor),
        deductionsMinor: text(detail.deductionsMinor),
        correctionMinor: text(detail.correctionMinor),
        netMinor: text(detail.netMinor),
        previousNetMinor: text(detail.previousNetMinor),
        changeFlag: detail.changeFlag,
        payslipReference: detail.payslipReference,
        correctionReference: detail.correctionReference,
      },
    ]),
  );
}

export type { RowIssue, RowWarningCode };
