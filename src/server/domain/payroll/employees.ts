/**
 * Payroll employee master (PYR-01, SEC-04) — RESTRICTED.
 *
 * Every function here needs the payroll-detail capability. Names and account identifiers are
 * returned only to a payroll officer; audit rows record that something was read or changed
 * and how many records, never a name, an account or an employee code.
 * An employee whose account did not pass the name check is stored (so the officer can see and
 * fix it) but its payroll lines are blocked until the check passes.
 */
import { DEMO_ACCOUNT_PATTERN, DEMO_ACCOUNT_SCHEME, hasUnsafeCharacters, maskAccountReference, normalizeAccountReference } from "@/contracts/common";
import { DomainError, conflict, notFound } from "@/contracts/errors";
import { EMPLOYEE_CODE_PATTERN, employeeCreateSchema, employeeImportCommitSchema, employeeImportSchema, employeeUpdateSchema, type EmployeeRowError } from "@/contracts/payroll";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { writeAudit } from "@/server/audit/audit";
import { requireCorporate, requirePerson, type AuthContext, type CorporateContext } from "@/server/auth/context";
import { inTx, isUniqueViolation, type Prisma } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { HARD_ROW_CAP, DEFAULT_TABLE_LIMITS, ImportFileError, TEMPLATES, bindTemplate, parseTable, type BoundRow } from "@/server/files/tabular";
import { digestOf, sha256Hex } from "@/server/hash";
import type { PayrollEmployee } from "@/generated/prisma/client";
import { requirePayrollDetail } from "./detail";

const IMPORT_KIND = "EMPLOYEES";
const IMPORT_VALIDITY_MS = 30 * 60_000;
const STATUS_MAP = { MATCH: "MATCHED", CLOSE_MATCH: "CLOSE_MATCH", MISMATCH: "MISMATCH", NOT_FOUND: "NOT_FOUND" } as const;
type MatchStatus = PayrollEmployee["accountMatchStatus"];

export type EmployeeView = {
  id: string;
  employeeCode: string;
  name: string;
  accountScheme: string;
  accountReference: string;
  maskedAccount: string;
  accountMatchStatus: MatchStatus;
  matchCheckedAt: string | null;
  active: boolean;
  /** Whether a payroll line for this employee would pass the employee checks. */
  payable: boolean;
  version: number;
  updatedAt: string;
};

const view = (row: PayrollEmployee): EmployeeView => ({
  id: row.id,
  employeeCode: row.employeeCode,
  name: row.name,
  accountScheme: row.accountScheme,
  accountReference: row.accountReference,
  maskedAccount: maskAccountReference(row.accountReference),
  accountMatchStatus: row.accountMatchStatus,
  matchCheckedAt: row.matchCheckedAt?.toISOString() ?? null,
  active: row.active,
  payable: row.active && row.accountMatchStatus === "MATCHED",
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

/** The officer context: corporate member, payroll-detail permission, a signed-in person. */
function officer(ctx: AuthContext): CorporateContext {
  const corporateCtx = requireCorporate(ctx);
  requirePayrollDetail(corporateCtx);
  requirePerson(corporateCtx);
  return corporateCtx;
}

async function nameCheck(deps: Deps, ctx: CorporateContext, input: { scheme: string; reference: string; name: string }): Promise<Exclude<MatchStatus, "UNCHECKED">> {
  try {
    const match = await deps.core.validateBeneficiary({ bankCode: ctx.bankCode, correlationId: ctx.correlationId }, input);
    return STATUS_MAP[match.status];
  } catch (error) {
    // "The check could not be made" is never treated as a match or as a mismatch.
    if (error instanceof CoreUnavailableError) throw new DomainError("NAME_CHECK_UNAVAILABLE");
    throw error;
  }
}

export async function listEmployees(
  deps: Deps,
  ctx: AuthContext,
  query: { search?: string | undefined; status?: "ACTIVE" | "INACTIVE" | "UNVERIFIED" | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: EmployeeView[]; nextCursor: string | null; counts: { total: number; active: number; unverified: number } }> {
  const corporateCtx = officer(ctx);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const where: Prisma.PayrollEmployeeWhereInput = {
    corporateId: corporateCtx.corporateId,
    ...(query.status === "ACTIVE" ? { active: true } : query.status === "INACTIVE" ? { active: false } : query.status === "UNVERIFIED" ? { accountMatchStatus: { not: "MATCHED" } } : {}),
    ...(query.search ? { OR: [{ name: { contains: query.search, mode: "insensitive" } }, { employeeCode: { contains: query.search.toUpperCase() } }] } : {}),
  };
  const rows = await deps.db.payrollEmployee.findMany({ where, orderBy: [{ employeeCode: "asc" }, { id: "asc" }], take: limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
  const page = rows.slice(0, limit);
  const scope = { corporateId: corporateCtx.corporateId };
  const [total, active, unverified] = await Promise.all([
    deps.db.payrollEmployee.count({ where: scope }),
    deps.db.payrollEmployee.count({ where: { ...scope, active: true } }),
    deps.db.payrollEmployee.count({ where: { ...scope, accountMatchStatus: { not: "MATCHED" } } }),
  ]);
  // Reading the employee master is recorded — without its content.
  await writeAudit(deps.db, corporateCtx, { action: "payroll.employees.read", targetType: "payrollEmployee", sensitiveRead: true, changes: { rows: page.length } });
  return { items: page.map(view), nextCursor: rows.length > limit ? (page[page.length - 1] as PayrollEmployee).id : null, counts: { total, active, unverified } };
}

export async function getEmployee(deps: Deps, ctx: AuthContext, employeeId: string): Promise<EmployeeView> {
  const corporateCtx = officer(ctx);
  const row = await deps.db.payrollEmployee.findFirst({ where: { id: employeeId, corporateId: corporateCtx.corporateId } });
  if (!row) throw notFound();
  return view(row);
}

export async function createEmployee(deps: Deps, ctx: AuthContext, rawInput: unknown, employeeId: string): Promise<void> {
  const corporateCtx = officer(ctx);
  const input = employeeCreateSchema.parse(rawInput);
  const status = await nameCheck(deps, corporateCtx, { scheme: input.accountScheme, reference: input.accountReference, name: input.name });
  try {
    await inTx(deps.db, async (tx) => {
      await tx.payrollEmployee.create({
        data: {
          id: employeeId,
          bankId: corporateCtx.bankId,
          corporateId: corporateCtx.corporateId,
          employeeCode: input.employeeCode,
          name: input.name,
          accountScheme: input.accountScheme,
          accountReference: input.accountReference,
          accountMatchStatus: status,
          matchCheckedAt: deps.clock.now(),
          active: input.active ?? true,
        },
      });
      // No name, account or employee code in the audit trail (SEC-04).
      await writeAudit(tx, corporateCtx, { action: "payroll.employee.created", targetType: "payrollEmployee", targetId: employeeId, changes: { accountMatchStatus: status, active: input.active ?? true } });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("DUPLICATE_RESOURCE", { detail: "An employee with this code already exists.", violations: [{ field: "employeeCode", rule: "unique", message: "An employee with this code already exists." }] });
    throw error;
  }
}

export async function updateEmployee(deps: Deps, ctx: AuthContext, employeeId: string, rawInput: unknown, expectedVersion: number): Promise<void> {
  const corporateCtx = officer(ctx);
  const input = employeeUpdateSchema.parse(rawInput);
  const current = await deps.db.payrollEmployee.findFirst({ where: { id: employeeId, corporateId: corporateCtx.corporateId } });
  if (!current) throw notFound();
  if (current.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
  const name = input.name ?? current.name;
  const accountReference = input.accountReference ?? current.accountReference;
  const identityChanged = name !== current.name || accountReference !== current.accountReference;
  // A changed name or account is never trusted on the strength of the earlier check.
  const status = identityChanged || input.recheck || current.accountMatchStatus !== "MATCHED" ? await nameCheck(deps, corporateCtx, { scheme: current.accountScheme, reference: accountReference, name }) : current.accountMatchStatus;
  await inTx(deps.db, async (tx) => {
    const updated = await tx.payrollEmployee.updateMany({
      where: { id: employeeId, corporateId: corporateCtx.corporateId, version: expectedVersion },
      data: {
        name,
        accountReference,
        accountMatchStatus: status,
        ...(status !== current.accountMatchStatus || identityChanged || input.recheck ? { matchCheckedAt: deps.clock.now() } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new DomainError("VERSION_CONFLICT");
    // Field NAMES only: which parts changed, never their values.
    const changed = [name !== current.name ? "name" : null, accountReference !== current.accountReference ? "account" : null, input.active !== undefined && input.active !== current.active ? "active" : null].filter((field): field is string => field !== null);
    await writeAudit(tx, corporateCtx, { action: "payroll.employee.updated", targetType: "payrollEmployee", targetId: employeeId, changes: { fields: changed.join(","), accountMatchStatus: status, ...(input.active !== undefined ? { active: input.active } : {}) } });
  });
}

// ---------------------------------------------------------------------------------------------
// Import: preview, then commit
// ---------------------------------------------------------------------------------------------

export type EmployeeImportRow = {
  line: number;
  employeeCode: string;
  name: string;
  accountScheme: string;
  accountReference: string;
  active: boolean;
  state: "VALID" | "INVALID";
  /** What committing would do to the master. */
  action: "CREATE" | "UPDATE" | "UNCHANGED" | null;
  matchStatus: MatchStatus | null;
  errors: Array<{ code: EmployeeRowError; field: string }>;
};

export type EmployeeImportView = {
  id: string;
  state: "PREVIEWED" | "COMMITTED" | "EXPIRED";
  fileName: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  acceptedHash: string;
  expiresAt: string;
  committedAt: string | null;
  version: number;
  rows: EmployeeImportRow[];
};

function draftRow(bound: BoundRow, seen: Set<string>): EmployeeImportRow {
  const errors: EmployeeImportRow["errors"] = [];
  const value = (column: string) => bound.values[column] ?? "";
  const text = (field: string, raw: string, max: number): string => {
    if (raw === "") errors.push({ code: "REQUIRED", field });
    else if (hasUnsafeCharacters(raw)) errors.push({ code: "UNSAFE_CHARACTERS", field });
    else if (raw.length > max) errors.push({ code: "TOO_LONG", field });
    else return raw;
    return "";
  };
  let employeeCode = text("employee_code", value("employee_code").toUpperCase(), 32);
  if (employeeCode !== "" && !EMPLOYEE_CODE_PATTERN.test(employeeCode)) {
    errors.push({ code: "CODE_FORMAT", field: "employee_code" });
    employeeCode = "";
  }
  const name = text("employee_name", value("employee_name"), 160);
  const accountScheme = value("account_scheme").toUpperCase();
  if (accountScheme !== DEMO_ACCOUNT_SCHEME) errors.push({ code: accountScheme === "" ? "REQUIRED" : "ACCOUNT_SCHEME", field: "account_scheme" });
  const accountReference = normalizeAccountReference(value("account_reference"));
  if (!DEMO_ACCOUNT_PATTERN.test(accountReference)) errors.push({ code: accountReference === "" ? "REQUIRED" : "ACCOUNT_FORMAT", field: "account_reference" });
  const rawActive = value("active").toLowerCase();
  if (!["", "true", "false"].includes(rawActive)) errors.push({ code: "ACTIVE_FORMAT", field: "active" });
  if (employeeCode !== "") {
    if (seen.has(employeeCode)) errors.push({ code: "DUPLICATE_CODE", field: "employee_code" });
    seen.add(employeeCode);
  }
  return { line: bound.line, employeeCode, name, accountScheme, accountReference, active: rawActive !== "false", state: errors.length > 0 ? "INVALID" : "VALID", action: null, matchStatus: null, errors };
}

const acceptedHashOf = (rows: readonly EmployeeImportRow[]) =>
  digestOf({ rows: rows.filter((row) => row.state === "VALID").map((row) => [row.line, row.employeeCode, row.name, row.accountScheme, row.accountReference, row.active, row.matchStatus]) });

function toImportView(session: { id: string; state: string; fileName: string; totalRows: number; validRows: number; invalidRows: number; acceptedHash: string; expiresAt: Date; committedAt: Date | null; version: number; rows: unknown }, now: Date): EmployeeImportView {
  const expired = session.state === "PREVIEWED" && session.expiresAt.getTime() <= now.getTime();
  return {
    id: session.id,
    state: expired ? "EXPIRED" : (session.state as "PREVIEWED" | "COMMITTED"),
    fileName: session.fileName,
    totalRows: session.totalRows,
    validRows: session.validRows,
    invalidRows: session.invalidRows,
    acceptedHash: session.acceptedHash,
    expiresAt: session.expiresAt.toISOString(),
    committedAt: session.committedAt?.toISOString() ?? null,
    version: session.version,
    rows: session.rows as EmployeeImportRow[],
  };
}

/**
 * Preview an employee file. Nothing is written to the master: the validated rows are kept in
 * a short-lived import session that only a payroll officer of the same corporate can read.
 */
export async function previewEmployeeImport(deps: Deps, ctx: AuthContext, form: FormData | null, sessionId: string): Promise<void> {
  const corporateCtx = officer(ctx);
  const person = requirePerson(corporateCtx);
  if (!form) throw new DomainError("VALIDATION_FAILED");
  const fields: Record<string, string> = {};
  let file: File | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
    else if (key === "file") file = value;
  }
  const meta = employeeImportSchema.parse(fields);
  if (!file) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "file", rule: "required", message: "Choose a file to upload." }] });
  const fileName = (file.name.split(/[\\/]/).pop() ?? "").trim();
  if (fileName === "" || fileName.length > 200 || hasUnsafeCharacters(fileName)) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "file", rule: "name", message: "The file name is not acceptable." }] });

  const bytes = new Uint8Array(await file.arrayBuffer());
  let bound: BoundRow[];
  let format: "CSV" | "XLSX";
  try {
    const table = parseTable(bytes, fileName, DEFAULT_TABLE_LIMITS);
    bound = bindTemplate(table, TEMPLATES.employees, meta.templateVersion);
    format = table.format;
  } catch (error) {
    if (!(error instanceof ImportFileError)) throw error;
    const violation = { field: "file", rule: error.code, message: error.message, ...(error.line ? { line: String(error.line) } : {}) };
    if (error.code === "UNSUPPORTED_FILE") throw new DomainError("UNSUPPORTED_FILE", { detail: error.message, violations: [violation] });
    if (error.code === "IMPORT_TOO_LARGE") throw new DomainError("IMPORT_TOO_LARGE", { detail: error.message, violations: [violation] });
    throw new DomainError("VALIDATION_FAILED", { violations: [violation] });
  }
  if (bound.length === 0) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "file", rule: "EMPTY", message: "The file has no data rows." }] });
  if (bound.length > HARD_ROW_CAP) throw new DomainError("BATCH_ROW_CAP_EXCEEDED", { violations: [{ field: "file", rule: "import.rows", limit: String(HARD_ROW_CAP), rows: String(bound.length) }] });

  const seen = new Set<string>();
  const rows = bound.map((row) => draftRow(row, seen));
  const existing = await deps.db.payrollEmployee.findMany({ where: { corporateId: corporateCtx.corporateId, employeeCode: { in: rows.filter((row) => row.employeeCode !== "").map((row) => row.employeeCode) } } });
  const byCode = new Map(existing.map((employee) => [employee.employeeCode, employee]));
  const pending = rows.filter((row) => row.state === "VALID");
  for (let index = 0; index < pending.length; index += deps.settings.rowConcurrency) {
    await Promise.all(
      pending.slice(index, index + deps.settings.rowConcurrency).map(async (row) => {
        const status = await nameCheck(deps, corporateCtx, { scheme: row.accountScheme, reference: row.accountReference, name: row.name });
        row.matchStatus = status;
        // A wrong account or a different holder is never imported.
        if (status === "NOT_FOUND") row.errors.push({ code: "ACCOUNT_NOT_FOUND", field: "account_reference" });
        else if (status === "MISMATCH") row.errors.push({ code: "NAME_MISMATCH", field: "employee_name" });
        if (row.errors.length > 0) {
          row.state = "INVALID";
          return;
        }
        const current = byCode.get(row.employeeCode);
        row.action = !current ? "CREATE" : current.name === row.name && current.accountReference === row.accountReference && current.active === row.active && current.accountMatchStatus === status ? "UNCHANGED" : "UPDATE";
      }),
    );
  }
  const validRows = rows.filter((row) => row.state === "VALID").length;
  const now = deps.clock.now();
  await inTx(deps.db, async (tx) => {
    await tx.importSession.create({
      data: {
        id: sessionId,
        bankId: corporateCtx.bankId,
        corporateId: corporateCtx.corporateId,
        kind: IMPORT_KIND,
        fileName,
        fileSha256: sha256Hex(bytes),
        fileFormat: format,
        totalRows: rows.length,
        validRows,
        invalidRows: rows.length - validRows,
        rows: rows as unknown as Prisma.InputJsonValue,
        acceptedHash: acceptedHashOf(rows),
        createdByPersonId: person.personId,
        expiresAt: new Date(now.getTime() + IMPORT_VALIDITY_MS),
      },
    });
    await writeAudit(tx, corporateCtx, { action: "payroll.employees.import.previewed", targetType: "importSession", targetId: sessionId, sensitiveRead: true, changes: { rows: rows.length, valid: validRows, invalid: rows.length - validRows } });
  });
}

export async function getEmployeeImport(deps: Deps, ctx: AuthContext, sessionId: string): Promise<EmployeeImportView> {
  const corporateCtx = officer(ctx);
  const session = await deps.db.importSession.findFirst({ where: { id: sessionId, corporateId: corporateCtx.corporateId, kind: IMPORT_KIND } });
  if (!session) throw notFound();
  return toImportView(session, deps.clock.now());
}

/** Persist exactly the valid rows that were previewed, in one transaction. */
export async function commitEmployeeImport(deps: Deps, ctx: AuthContext, sessionId: string, rawInput: unknown, expectedVersion: number): Promise<void> {
  const corporateCtx = officer(ctx);
  const input = employeeImportCommitSchema.parse(rawInput);
  const now = deps.clock.now();
  await inTx(deps.db, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ImportSession" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
    const session = await tx.importSession.findFirst({ where: { id: sessionId, corporateId: corporateCtx.corporateId, kind: IMPORT_KIND } });
    if (!session) throw notFound();
    if (session.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (session.state !== "PREVIEWED") throw conflict("This import was already committed.");
    if (session.expiresAt.getTime() <= now.getTime()) throw conflict("This preview has expired. Upload the file again.");
    const rows = session.rows as unknown as EmployeeImportRow[];
    // The digest binds the commit to exactly what was previewed.
    if (input.acceptedHash !== session.acceptedHash || acceptedHashOf(rows) !== session.acceptedHash) throw new DomainError("VERSION_CONFLICT", { detail: "The preview changed. Upload the file again." });
    const valid = rows.filter((row) => row.state === "VALID");
    if (valid.length === 0) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "file", rule: "emptyAcceptedSet", message: "No valid row to import." }] });
    if (valid.length !== rows.length && !input.confirmExcludeInvalid) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "confirmExcludeInvalid", rule: "required", message: "Confirm that invalid rows will not be imported." }] });
    let created = 0;
    let updated = 0;
    for (const row of valid) {
      const data = { name: row.name, accountScheme: row.accountScheme, accountReference: row.accountReference, accountMatchStatus: row.matchStatus ?? "UNCHECKED", matchCheckedAt: session.createdAt, active: row.active };
      const current = await tx.payrollEmployee.findUnique({ where: { corporateId_employeeCode: { corporateId: corporateCtx.corporateId, employeeCode: row.employeeCode } } });
      if (!current) {
        await tx.payrollEmployee.create({ data: { bankId: corporateCtx.bankId, corporateId: corporateCtx.corporateId, employeeCode: row.employeeCode, ...data } });
        created += 1;
      } else if (current.name !== data.name || current.accountReference !== data.accountReference || current.active !== data.active || current.accountMatchStatus !== data.accountMatchStatus) {
        await tx.payrollEmployee.update({ where: { id: current.id }, data: { ...data, version: { increment: 1 } } });
        updated += 1;
      }
    }
    await tx.importSession.update({ where: { id: sessionId }, data: { state: "COMMITTED", committedAt: now, version: { increment: 1 } } });
    await writeAudit(tx, corporateCtx, { action: "payroll.employees.import.committed", targetType: "importSession", targetId: sessionId, changes: { created, updated, unchanged: valid.length - created - updated, notImported: rows.length - valid.length } });
  });
}
