/** Helpers for bulk and payroll batch tests: synthetic files and the upload → approval steps. */
import { ACCOUNTS, bulkRecipientName, bulkRecipientRef } from "@/server/seed/fixtures";
import { toCsv } from "@/server/files/csv";
import { TEMPLATES } from "@/server/files/tabular";
import { writeXlsx } from "@/server/files/xlsx";
import { approve } from "./payments";
import type { ApiResult, World } from "./world";

export type BatchData = {
  id: string;
  kind: string;
  reference: string;
  state: string;
  version: number;
  validationVersion: number;
  revision: number;
  counts: { total: number; valid: number; invalid: number; duplicate: number; warnings: number; accepted: number };
  accepted: { amount: { minor: string }; fee: { minor: string }; totalDebit: { minor: string } } | null;
  outcome: { settled: number; failed: number; unknown: number; returned: number; inFlight: number; settledAmount: { minor: string } } | null;
  validationErrorCode: string | null;
  releaseBlockCode: string | null;
  identicalTo: { id: string; reference: string } | null;
  parent: { id: string; reference: string } | null;
  payPeriod: string | null;
  executeAt: string | null;
  approval: { id: string; state: string; requiredApprovals: number; approvalsCount: number; summary: Record<string, unknown>; payloadHash: string; targetRevision: number; version: number } | null;
  retries: Array<{ id: string; reference: string; state: string }>;
  actions: Record<string, boolean>;
  timeline: Array<{ code: string; toState: string | null }>;
};

export type RowData = {
  id: string;
  lineNumber: number;
  projection: string;
  validationState: string;
  accepted: boolean;
  executionState: string;
  rowReference?: string | null;
  errors?: Array<{ code: string; field: string }>;
  warnings?: Array<{ code: string; field: string }>;
  amount?: { minor: string } | null;
  beneficiaryName?: string | null;
  failureCode?: string | null;
  executionReference?: string | null;
  maskedReference?: string;
  detail?: Record<string, unknown> | null;
};

export type BulkRow = Record<(typeof TEMPLATES.bulk.required)[number], string> & { beneficiary_reference?: string };

/** A valid bulk row paying synthetic recipient `n` (1…100). */
export function bulkRow(n: number, overrides: Partial<BulkRow> = {}, tag = "R"): BulkRow {
  return {
    row_reference: `${tag}-${String(n).padStart(3, "0")}`,
    beneficiary_name: bulkRecipientName(n),
    account_scheme: "DEMO_DOMESTIC",
    account_reference: bulkRecipientRef(n),
    amount: "10.000",
    currency: "LYD",
    purpose: `Synthetic invoice ${n}`,
    ...overrides,
  };
}

export function tableFile(headers: readonly string[], rows: ReadonlyArray<Record<string, string | undefined>>, format: "csv" | "xlsx" = "csv"): Uint8Array {
  const cells = rows.map((row) => headers.map((header) => row[header] ?? ""));
  return format === "csv" ? toCsv(headers, cells) : writeXlsx([{ name: "Data", rows: [[...headers], ...cells] }]);
}

export const bulkFile = (rows: readonly BulkRow[], format: "csv" | "xlsx" = "csv") => tableFile([...TEMPLATES.bulk.required], rows, format);

export type UploadOptions = {
  kind?: "BULK" | "PAYROLL";
  source?: keyof typeof ACCOUNTS;
  rail?: "LYPAY" | "ACH";
  fileName?: string;
  executeAt?: string;
  correction?: boolean;
  templateVersion?: number;
  idempotencyKey?: string;
};

export async function upload(world: World, actorKey: string, bytes: Uint8Array, options: UploadOptions = {}): Promise<ApiResult<BatchData>> {
  const actor = await world.as(actorKey);
  const kind = options.kind ?? "BULK";
  const form = new FormData();
  form.set("kind", kind);
  form.set("sourceAccountId", ACCOUNTS[options.source ?? (kind === "PAYROLL" ? "A_PAYROLL" : "A_OPERATING")].id);
  form.set("templateVersion", String(options.templateVersion ?? 1));
  form.set("rail", options.rail ?? (kind === "PAYROLL" ? "ACH" : "LYPAY"));
  form.set("executionMode", options.executeAt ? "SCHEDULED" : "IMMEDIATE");
  if (options.executeAt) form.set("executeAt", options.executeAt);
  if (options.correction) form.set("correction", "true");
  form.set("file", new File([bytes as BlobPart], options.fileName ?? `${kind.toLowerCase()}.csv`));
  return actor.post<BatchData>("/batches/uploads", undefined, { form, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
}

export async function getBatch(world: World, batchId: string, actorKey: string): Promise<BatchData> {
  const response = await (await world.as(actorKey)).get<BatchData>(`/batches/${batchId}`);
  if (response.status !== 200) throw new Error(`get batch failed: ${response.status} ${response.text}`);
  return response.data;
}

export async function rowsOf(world: World, batchId: string, actorKey: string, filter = "ALL"): Promise<{ projection: string; items: RowData[] }> {
  const response = await (await world.as(actorKey)).get<{ projection: string; items: RowData[] }>(`/batches/${batchId}/rows?filter=${filter}&limit=200`);
  if (response.status !== 200) throw new Error(`rows failed: ${response.status} ${response.text}`);
  return response.data;
}

/** Upload, let the worker validate, and return the batch in review. */
export async function uploadAndValidate(world: World, actorKey: string, bytes: Uint8Array, options: UploadOptions = {}): Promise<BatchData> {
  const uploaded = await upload(world, actorKey, bytes, options);
  if (uploaded.status !== 202) throw new Error(`upload failed: ${uploaded.status} ${uploaded.text}`);
  await world.drain();
  return getBatch(world, uploaded.data.id, actorKey);
}

export async function accept(world: World, actorKey: string, batch: BatchData, body: { excludedRowIds?: string[]; confirmExcludeInvalid?: boolean; acknowledgeWarnings?: boolean } = {}): Promise<ApiResult<BatchData>> {
  return (await world.as(actorKey)).post<BatchData>(`/batches/${batch.id}/accept-rows`, { validationVersion: batch.validationVersion, ...body }, { ifMatch: batch.version });
}

export async function submit(world: World, actorKey: string, batch: BatchData, body: { acceptRolledExecution?: boolean } = {}): Promise<ApiResult<BatchData>> {
  return (await world.as(actorKey)).post<BatchData>(`/batches/${batch.id}/submit`, body, { ifMatch: batch.version });
}

/** Accept every valid row, submit and get the approvals needed; the worker has NOT run. */
export async function acceptSubmitApprove(world: World, makerKey: string, batch: BatchData, checkers: string[] = ["aChecker1"]): Promise<BatchData> {
  const accepted = await accept(world, makerKey, batch, { confirmExcludeInvalid: true, acknowledgeWarnings: true });
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${accepted.text}`);
  const submitted = await submit(world, makerKey, accepted.data);
  if (submitted.status !== 202) throw new Error(`submit failed: ${submitted.status} ${submitted.text}`);
  for (const checker of checkers) {
    const vote = await approve(world, (submitted.data.approval as NonNullable<BatchData["approval"]>).id, checker);
    if (vote.status !== 200) throw new Error(`approve failed: ${vote.status} ${vote.text}`);
  }
  return getBatch(world, batch.id, makerKey);
}

// ---------------------------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------------------------

export type PayRow = Record<(typeof TEMPLATES.payroll.required)[number], string> & { correction_reference?: string };

/** A valid salary line for a seeded employee; every employee gets a distinctive net amount. */
export function payRow(employeeNo: number, overrides: Partial<PayRow> = {}, period = "2026-11"): PayRow {
  const code = `EMP-${String(employeeNo).padStart(3, "0")}`;
  return {
    row_reference: `PAY-${period}-${code}`,
    employee_code: code,
    pay_period: period,
    component: "SALARY",
    basic: `${1400 + employeeNo * 37}.${String(employeeNo).repeat(3)}`,
    allowances: "200.000",
    deductions: "50.000",
    correction: "0.000",
    payslip_reference: `PS-${period}-${code}`,
    currency: "LYD",
    ...overrides,
  };
}

/** Net pay of a payroll row in minor units, computed the way the bank must: exactly. */
export function netMinorOf(row: PayRow): bigint {
  const minor = (value: string) => {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = value.replace("-", "").split(".");
    const result = BigInt(whole as string) * 1000n + BigInt(fraction.padEnd(3, "0"));
    return negative ? -result : result;
  };
  return minor(row.basic) + minor(row.allowances) - minor(row.deductions) + minor(row.correction);
}

export const payrollFile = (rows: readonly PayRow[], format: "csv" | "xlsx" = "csv") => tableFile([...TEMPLATES.payroll.required, ...TEMPLATES.payroll.optional], rows, format);

export const employeesFile = (rows: ReadonlyArray<Record<string, string>>) => tableFile([...TEMPLATES.employees.required, ...TEMPLATES.employees.optional], rows);
