/**
 * Bulk transfer and payroll batch contracts (BAT-01..04, PYR-01, document 04 DTO appendix).
 * Shared by the upload form, the API and the domain service. Unknown fields are rejected.
 */
import { z } from "zod";

export const BATCH_KINDS = ["BULK", "PAYROLL"] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

export const BATCH_MODULE: Record<BatchKind, string> = { BULK: "2.1", PAYROLL: "2.2" };
/** Rails a batch may use in R1. Payroll is ACH only (document 04). */
export const BATCH_RAILS: Record<BatchKind, readonly ("LYPAY" | "ACH")[]> = { BULK: ["LYPAY", "ACH"], PAYROLL: ["ACH"] };

/** Text fields of the multipart upload (everything except the file part). */
export const batchUploadSchema = z.strictObject({
  kind: z.enum(BATCH_KINDS),
  sourceAccountId: z.uuid(),
  templateVersion: z.coerce.number().int().min(1).max(99),
  rail: z.enum(["LYPAY", "ACH"]),
  executionMode: z.enum(["IMMEDIATE", "SCHEDULED"]),
  executeAt: z.iso.datetime({ offset: true }).optional(),
  /** Payroll: this run corrects an earlier one; every row then needs a correction reference. */
  correction: z.enum(["true", "false"]).optional(),
});
export type BatchUpload = z.infer<typeof batchUploadSchema>;

export const acceptRowsSchema = z.strictObject({
  /** Valid rows the maker chooses to leave out. */
  excludedRowIds: z.array(z.uuid()).max(1000).default([]),
  /** Must be the batch's current validation version, so a stale screen cannot confirm. */
  validationVersion: z.int().min(1),
  /** Explicit confirmation that invalid and duplicate rows will not be submitted. */
  confirmExcludeInvalid: z.boolean().default(false),
  acknowledgeWarnings: z.boolean().default(false),
});

export const batchSubmitSchema = z.strictObject({
  /** Accept execution at the next rail window when today's window is closed. */
  acceptRolledExecution: z.boolean().optional(),
});

export const batchRetrySchema = z.strictObject({
  /** Failed rows to retry; omit to take every eligible failed row. */
  rowIds: z.array(z.uuid()).min(1).max(1000).optional(),
});

export const batchListQuerySchema = z.strictObject({
  kind: z.enum(BATCH_KINDS).optional(),
  state: z.string().max(40).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const batchRowsQuerySchema = z.strictObject({
  filter: z.enum(["ALL", "VALID", "INVALID", "ACCEPTED", "FAILED", "UNKNOWN"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const templateQuerySchema = z.strictObject({ format: z.enum(["csv", "xlsx"]).optional() });
export const templateParamSchema = z.strictObject({ kind: z.enum(["bulk", "payroll", "employees"]) });

/** Row problems reported by code only; a code never contains a value from the file. */
export const ROW_ERROR_CODES = [
  "REQUIRED",
  "TOO_LONG",
  "UNSAFE_CHARACTERS",
  "REFERENCE_FORMAT",
  "DUPLICATE_REFERENCE",
  "DUPLICATE_BUSINESS_REFERENCE",
  "AMOUNT_FORMAT",
  "AMOUNT_DECIMALS",
  "AMOUNT_NOT_POSITIVE",
  "AMOUNT_OUT_OF_RANGE",
  "CURRENCY_MISMATCH",
  "ACCOUNT_SCHEME",
  "ACCOUNT_FORMAT",
  "ACCOUNT_NOT_FOUND",
  "NAME_MISMATCH",
  "ITEM_LIMIT_EXCEEDED",
  "RAIL_LIMIT_EXCEEDED",
  // payroll
  "EMPLOYEE_UNKNOWN",
  "EMPLOYEE_INACTIVE",
  "EMPLOYEE_ACCOUNT_UNVERIFIED",
  "PAY_PERIOD_FORMAT",
  "PAY_PERIOD_MIXED",
  "COMPONENT_INVALID",
  "COMPONENT_DISABLED",
  "NEGATIVE_COMPONENT",
  "NET_NOT_POSITIVE",
  "DUPLICATE_SALARY",
  "CORRECTION_REFERENCE_REQUIRED",
  "CORRECTION_REFERENCE_UNEXPECTED",
] as const;
export type RowErrorCode = (typeof ROW_ERROR_CODES)[number];

export const ROW_WARNING_CODES = ["NAME_CLOSE_MATCH", "REPEATED_ACCOUNT", "SALARY_CHANGE"] as const;
export type RowWarningCode = (typeof ROW_WARNING_CODES)[number];

export type RowIssue<C extends string = RowErrorCode> = { code: C; field: string };
