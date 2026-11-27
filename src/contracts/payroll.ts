/**
 * Payroll employee master contracts (PYR-01). Minimal synthetic fields only: employee code,
 * name, account and active status — no national identifiers in R1. Unknown fields are rejected.
 */
import { z } from "zod";
import { accountReferenceSchema, accountSchemeSchema, safeText } from "./common";

export const EMPLOYEE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export const employeeCodeSchema = z
  .string()
  .trim()
  .regex(EMPLOYEE_CODE_PATTERN)
  .transform((value) => value.toUpperCase());

const employeeName = safeText(2, 160);

export const employeeCreateSchema = z.strictObject({
  employeeCode: employeeCodeSchema,
  name: employeeName,
  accountScheme: accountSchemeSchema,
  accountReference: accountReferenceSchema,
  active: z.boolean().optional(),
});
export type EmployeeCreate = z.infer<typeof employeeCreateSchema>;

export const employeeUpdateSchema = z
  .strictObject({
    name: employeeName.optional(),
    accountReference: accountReferenceSchema.optional(),
    active: z.boolean().optional(),
    /** Run the account-name check again without changing anything else. */
    recheck: z.literal(true).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change." });
export type EmployeeUpdate = z.infer<typeof employeeUpdateSchema>;

export const employeeListQuerySchema = z.strictObject({
  search: safeText(1, 80).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "UNVERIFIED"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Text fields of the multipart employee import (everything except the file part). */
export const employeeImportSchema = z.strictObject({ templateVersion: z.coerce.number().int().min(1).max(99) });

export const employeeImportCommitSchema = z.strictObject({
  /** Digest of the valid preview rows shown to the officer; a changed preview cannot be committed. */
  acceptedHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Explicit confirmation that invalid rows will not be imported. */
  confirmExcludeInvalid: z.boolean().default(false),
});

export const EMPLOYEE_ROW_ERRORS = ["REQUIRED", "CODE_FORMAT", "UNSAFE_CHARACTERS", "TOO_LONG", "ACCOUNT_SCHEME", "ACCOUNT_FORMAT", "ACTIVE_FORMAT", "DUPLICATE_CODE", "ACCOUNT_NOT_FOUND", "NAME_MISMATCH"] as const;
export type EmployeeRowError = (typeof EMPLOYEE_ROW_ERRORS)[number];
