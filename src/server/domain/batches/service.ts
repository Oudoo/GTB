/**
 * Shared batch engine for bulk transfers and payroll (BAT-01..04, PYR-01, DEC-007).
 *
 * Lifecycle: upload (bounded parse) → VALIDATING (worker) → READY → explicit acceptance of a
 * row set with an immutable digest → submit (freeze, policy, approval request) → approval →
 * release (re-check everything, reserve the total atomically, one business instruction per
 * row) → dispatch (attempts through the unified execution engine) → state DERIVED from row
 * outcomes. Nothing executes before approval; a definitive row failure releases only its own
 * reservation; a batch is never complete while a row is unknown or pending.
 *
 * Payroll uses the same engine. Its amounts and destinations are read only through the
 * restricted payroll module with the engine capability and are never placed in a response,
 * a summary, an audit row, an event, a notification or a log line.
 */
import { BATCH_MODULE, BATCH_RAILS, acceptRowsSchema, batchUploadSchema, type BatchKind, type RowIssue, type RowWarningCode } from "@/contracts/batches";
import { hasUnsafeCharacters } from "@/contracts/common";
import { DomainError, conflict, notFound, type ErrorCode } from "@/contracts/errors";
import type { Currency } from "@/contracts/money";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { addTimeline, timelineActor, writeAudit } from "@/server/audit/audit";
import { requireAccountRight, requireCorporate, requirePermission, requirePerson, type AuthContext, type CorporateContext } from "@/server/auth/context";
import { permissionsForRoles, type Permission } from "@/server/auth/permissions";
import { businessDateOf, withinSchedulingHorizon } from "@/server/calendar";
import { inTx, isUniqueViolation, type Prisma, type Tx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { requireEffectivePolicy, requireEntitlement } from "@/server/domain/agreements/policy";
import { closeApprovalRequest, createApprovalRequest } from "@/server/domain/approvals/service";
import { startAttempt } from "@/server/domain/execution/engine";
import { COMPONENT_TYPE, countChangeFlags, engineCapability, insertPayrollDetails, loadBaselines, loadEmployees, loadPayrollFacts, type RowExecutionFacts } from "@/server/domain/payroll/detail";
import { putPrivateFile, readPrivateFile } from "@/server/files/storage";
import { DEFAULT_TABLE_LIMITS, HARD_ROW_CAP, ImportFileError, TEMPLATES, bindTemplate, parseTable, type BoundRow, type TableLimits } from "@/server/files/tabular";
import { digestOf, sha256Hex } from "@/server/hash";
import { enqueueJob } from "@/server/jobs/queue";
import { logWarn } from "@/server/logging";
import { notify } from "@/server/notifications/notify";
import { emitEvent } from "@/server/outbox";
import { constraintToJson, type Constraint } from "@/server/policy/evaluate";
import { reserveLimits, settleReservations } from "@/server/policy/reservations";
import type { Batch, BatchRow, BusinessInstruction } from "@/generated/prisma/client";
import { evaluateBatch, type BatchEvaluation, type BatchFacts, type BatchTransactionType } from "./policy";
import { acceptedSetHash, deriveBatchState, salaryChanged, type RowOutcomeCounts } from "./state";
import { bulkBusinessKey, parseBulkRows, parsePayrollRows, payrollBusinessKey, type PayrollComponentCode, type PayrollRowDraft } from "./validation";

export const JOB_BATCH_VALIDATE = "batch.validate";
export const JOB_BATCH_RELEASE = "batch.release";
export const JOB_BATCH_DISPATCH = "batch.dispatch";

/** Demo threshold for the salary-change warning (PYR-01): 20%. */
export const SALARY_CHANGE_BPS = 2_000;
const LONG_TX = { timeoutMs: 120_000, maxWaitMs: 20_000 } as const;
const DISPATCH_CHUNK = 50;

export const createPermission = (kind: BatchKind): Permission => (kind === "PAYROLL" ? "payroll.detail" : "batches.create");
export const readPermission = (kind: BatchKind): Permission => (kind === "PAYROLL" ? "payroll.aggregate.read" : "batches.read");
const approvePermission = (kind: BatchKind): Permission => (kind === "PAYROLL" ? "payroll.approve" : "batches.approve");
const templateOf = (kind: BatchKind) => (kind === "PAYROLL" ? TEMPLATES.payroll : TEMPLATES.bulk);
const linkOf = (batch: Pick<Batch, "kind" | "id">) => `${batch.kind === "PAYROLL" ? "/payroll" : "/batches"}/${batch.id}`;

function importError(error: ImportFileError): DomainError {
  const violation = { field: "file", rule: error.code, message: error.message, ...(error.line ? { line: String(error.line) } : {}), ...(error.cell ? { cell: error.cell } : {}) };
  if (error.code === "UNSUPPORTED_FILE") return new DomainError("UNSUPPORTED_FILE", { detail: error.message, violations: [violation] });
  if (error.code === "IMPORT_TOO_LARGE") return new DomainError("IMPORT_TOO_LARGE", { detail: error.message, violations: [violation] });
  return new DomainError("VALIDATION_FAILED", { violations: [violation] });
}

function parseUpload(bytes: Uint8Array, fileName: string, kind: BatchKind, templateVersion: number, limits: TableLimits): { rows: BoundRow[]; format: "CSV" | "XLSX" } {
  try {
    const table = parseTable(bytes, fileName, limits);
    return { rows: bindTemplate(table, templateOf(kind), templateVersion), format: table.format };
  } catch (error) {
    if (error instanceof ImportFileError) throw importError(error);
    throw error;
  }
}

async function nextSequence(tx: Tx, scopeKey: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    INSERT INTO "ReferenceSequence" ("scopeKey", "nextValue") VALUES (${scopeKey}, 2)
    ON CONFLICT ("scopeKey") DO UPDATE SET "nextValue" = "ReferenceSequence"."nextValue" + 1
    RETURNING "nextValue" - 1 AS value`;
  return (rows[0] as { value: bigint }).value;
}

async function lockBatch(tx: Tx, batchId: string): Promise<Batch | null> {
  await tx.$queryRaw`SELECT "id" FROM "Batch" WHERE "id" = ${batchId}::uuid FOR UPDATE`;
  return tx.batch.findUnique({ where: { id: batchId } });
}

/** A batch of the caller's corporate whose source account the caller may read. */
export async function loadScopedBatch(deps: Deps, ctx: CorporateContext, batchId: string): Promise<Batch> {
  const batch = await deps.db.batch.findFirst({ where: { id: batchId, corporateId: ctx.corporateId } });
  if (!batch) throw notFound();
  if (!ctx.permissions.has(readPermission(batch.kind)) && !ctx.permissions.has(createPermission(batch.kind))) throw notFound();
  requireAccountRight(ctx, batch.sourceAccountId, "read");
  return batch;
}

function throwConstraint(constraint: Constraint): never {
  throw new DomainError(constraint.code, {
    violations: [
      {
        field: "batch",
        rule: `${constraint.scope}.${constraint.period.toLowerCase()}`,
        ...(constraint.remaining !== null ? { remainingMinor: (constraint.remaining < 0n ? 0n : constraint.remaining).toString() } : {}),
        ...(constraint.limit !== null ? { limitMinor: constraint.limit.toString() } : {}),
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

export async function uploadBatch(deps: Deps, ctx: AuthContext, form: FormData | null, batchId: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  const person = requirePerson(corporateCtx);
  if (!form) throw new DomainError("VALIDATION_FAILED");
  const fields: Record<string, string> = {};
  let file: File | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
    else if (key === "file") file = value;
  }
  const meta = batchUploadSchema.parse(fields);
  if (!file) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "file", rule: "required", message: "Choose a file to upload." }] });

  requirePermission(corporateCtx, createPermission(meta.kind));
  requireAccountRight(corporateCtx, meta.sourceAccountId, "debit");
  if (!BATCH_RAILS[meta.kind].includes(meta.rail)) throw new DomainError("TRANSACTION_TYPE_DISABLED", { detail: "This rail is not available for this kind of batch." });
  const now = deps.clock.now();
  const executeAt = meta.executionMode === "SCHEDULED" ? (meta.executeAt ? new Date(meta.executeAt) : null) : null;
  if (meta.executionMode === "SCHEDULED" && (!executeAt || executeAt.getTime() <= now.getTime() || !withinSchedulingHorizon(now, executeAt, deps.timeZone))) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "executeAt", rule: "horizon", message: "Choose a future time within the next 30 days." }] });
  }
  if (meta.executionMode === "IMMEDIATE" && meta.executeAt) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "executeAt", rule: "mode", message: "An immediate batch has no execution time." }] });

  const fileName = (file.name.split(/[\\/]/).pop() ?? "").trim();
  if (fileName === "" || fileName.length > 200 || hasUnsafeCharacters(fileName)) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "file", rule: "name", message: "The file name is not acceptable." }] });
  }

  // The agreement must cover the module, the account and the row cap BEFORE anything is stored.
  const moduleId = BATCH_MODULE[meta.kind];
  const policy = await requireEffectivePolicy(deps.db, corporateCtx.corporateId, now);
  const entitlement = requireEntitlement(policy, { moduleId, ...(meta.kind === "BULK" ? { transactionType: "BULK_CREDIT" } : {}), debitAccountId: meta.sourceAccountId });
  const rowCap = Math.min(entitlement.rowCap ?? HARD_ROW_CAP, HARD_ROW_CAP);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { rows, format } = parseUpload(bytes, fileName, meta.kind, meta.templateVersion, DEFAULT_TABLE_LIMITS);
  if (rows.length === 0) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "file", rule: "EMPTY", message: "The file has no data rows." }] });
  if (rows.length > rowCap) {
    throw new DomainError("BATCH_ROW_CAP_EXCEEDED", { violations: [{ field: "file", rule: "module.batch", limit: String(rowCap), rows: String(rows.length) }] });
  }

  const account = await deps.db.account.findFirstOrThrow({ where: { id: meta.sourceAccountId, corporateId: corporateCtx.corporateId } });
  if (account.status !== "ACTIVE") throw new DomainError("ACCOUNT_NOT_ALLOWED");
  const corporate = await deps.db.corporate.findUniqueOrThrow({ where: { id: corporateCtx.corporateId }, select: { shortCode: true } });
  const fileSha256 = sha256Hex(bytes);
  const identical = await deps.db.batch.findFirst({
    where: { corporateId: corporateCtx.corporateId, kind: meta.kind, fileSha256, state: { notIn: ["CANCELLED", "REJECTED", "FAILED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const stored = await putPrivateFile(deps.storagePath, "uploads", batchId, format === "XLSX" ? "xlsx" : "csv", bytes);
  const year = businessDateOf(now, deps.timeZone).slice(0, 4);
  const prefix = meta.kind === "PAYROLL" ? "PYR" : "BLK";

  await inTx(deps.db, async (tx) => {
    const sequence = await nextSequence(tx, `${prefix}:${corporateCtx.corporateId}:${year}`);
    const reference = `${prefix}-${corporate.shortCode}-${year}-${sequence.toString().padStart(6, "0")}`;
    await tx.batch.create({
      data: {
        id: batchId,
        bankId: corporateCtx.bankId,
        corporateId: corporateCtx.corporateId,
        kind: meta.kind,
        reference,
        moduleId,
        sourceAccountId: account.id,
        currency: account.currency,
        rail: meta.rail,
        executionMode: meta.executionMode,
        executeAt,
        state: "VALIDATING",
        fileName,
        fileSha256,
        fileSizeBytes: bytes.byteLength,
        fileFormat: format,
        storageKey: stored.key,
        templateVersion: meta.templateVersion,
        isCorrection: meta.kind === "PAYROLL" && meta.correction === "true",
        totalRows: rows.length,
        identicalToBatchId: identical?.id ?? null,
        makerPersonId: person.personId,
        makerMembershipId: corporateCtx.membershipId as string,
        agreementVersionId: policy.agreementVersionId,
      },
    });
    await enqueueJob(tx, {
      type: JOB_BATCH_VALIDATE,
      payload: { batchId },
      dedupKey: `batch-validate:${batchId}`,
      bankId: corporateCtx.bankId,
      corporateId: corporateCtx.corporateId,
      aggregateType: "batch",
      aggregateId: batchId,
      correlationId: corporateCtx.correlationId,
    });
    await addTimeline(tx, { at: now, bankId: corporateCtx.bankId, corporateId: corporateCtx.corporateId, aggregateType: "batch", aggregateId: batchId, code: "BATCH_UPLOADED", toState: "VALIDATING", ...timelineActor(corporateCtx), reference });
    await writeAudit(tx, corporateCtx, {
      action: "batch.uploaded",
      targetType: "batch",
      targetId: batchId,
      // Checksum and counts only: never file content.
      changes: { reference, kind: meta.kind, fileSha256, format, rows: rows.length, rail: meta.rail, executionMode: meta.executionMode },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Validation (worker)
// ---------------------------------------------------------------------------------------------

type RowShell = {
  id: string;
  lineNumber: number;
  rowReference: string | null;
  validationState: "VALID" | "INVALID" | "DUPLICATE";
  errors: RowIssue[];
  warnings: RowIssue<RowWarningCode>[];
  bulk: { amountMinor: bigint | null; currency: string | null; beneficiaryName: string | null; accountScheme: string | null; accountReference: string | null; purpose: string | null; beneficiaryReference: string | null } | null;
  businessKey: string | null;
};

const invalidate = (row: { validationState: string; errors: RowIssue[] }, issue: RowIssue, duplicate = false) => {
  row.errors.push(issue);
  row.validationState = duplicate ? "DUPLICATE" : row.validationState === "DUPLICATE" ? "DUPLICATE" : "INVALID";
};

/** Business keys already owned by an instruction or carried by another open batch. */
async function takenBusinessKeys(deps: Deps, corporateId: string, batchId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const instructions = await deps.db.businessInstruction.findMany({ where: { corporateId, businessKey: { in: [...keys] } }, select: { businessKey: true } });
  const carriers = await deps.db.batchRow.findMany({
    where: { corporateId, batchId: { not: batchId }, activeBusinessKey: { in: keys.map((key) => `${corporateId}:${key}`) } },
    select: { businessKey: true },
  });
  return new Set([...instructions.map((row) => row.businessKey), ...carriers.map((row) => row.businessKey as string)]);
}

/**
 * Worker step: row-level validation of the stored file. Throws `CoreUnavailableError` when the
 * name check cannot be made, so the job is retried and the batch stays VALIDATING — rows are
 * never accepted unchecked.
 */
export async function validateBatch(deps: Deps, batchId: string): Promise<void> {
  const batch = await deps.db.batch.findUnique({ where: { id: batchId } });
  if (!batch || batch.state !== "VALIDATING" || !batch.storageKey) return;
  const cap = engineCapability(batch.corporateId);
  const bytes = await readPrivateFile(deps.storagePath, batch.storageKey);
  const { rows: bound } = parseUpload(bytes, batch.fileName, batch.kind, batch.templateVersion, DEFAULT_TABLE_LIMITS);
  const now = deps.clock.now();
  const maker = await deps.db.membership.findUniqueOrThrow({ where: { id: batch.makerMembershipId } });
  const corporate = await deps.db.corporate.findUniqueOrThrow({ where: { id: batch.corporateId }, include: { bank: { select: { code: true } } } });
  const currency = batch.currency as Currency;

  let policyError: ErrorCode | null = null;
  let evaluation: BatchEvaluation | null = null;
  const baseFacts = { bankId: batch.bankId, corporateId: batch.corporateId, kind: batch.kind, rail: batch.rail as "LYPAY" | "ACH", sourceAccountId: batch.sourceAccountId, currency, requestedExecuteAt: batch.executeAt, userKey: `membership:${maker.id}`, userLimits: { perItemMinor: maker.userPerItemLimitMinor, dailyMinor: maker.userDailyLimitMinor } };
  const evaluateItems = async (items: BatchFacts["items"]) => {
    try {
      evaluation = await evaluateBatch(deps, deps.db, { ...baseFacts, items });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      policyError = error.code;
    }
  };

  const shells: RowShell[] = [];
  const payrollDetails: Array<{ rowId: string; draft: PayrollRowDraft; employee: Awaited<ReturnType<typeof loadEmployees>> extends Map<string, infer E> ? E | null : never; previousNetMinor: bigint | null; changeFlag: boolean }> = [];
  let payPeriod: string | null = null;
  // Per-item ceilings applied to every structurally valid row.
  const itemCeiling = (transactionType: BatchTransactionType): { limit: bigint; code: "ITEM_LIMIT_EXCEEDED" | "RAIL_LIMIT_EXCEEDED" }[] => {
    if (!evaluation) return [];
    const out: { limit: bigint; code: "ITEM_LIMIT_EXCEEDED" | "RAIL_LIMIT_EXCEEDED" }[] = [];
    const rail = evaluation.railPolicy?.ceiling.perItemMinor ?? null;
    if (rail !== null) out.push({ limit: rail, code: "RAIL_LIMIT_EXCEEDED" });
    for (const rule of evaluation.policy.rules) {
      if (rule.scope === "TYPE" && rule.metric === "AMOUNT" && rule.period === "ITEM" && rule.transactionType === transactionType && rule.valueMinor !== null) out.push({ limit: rule.valueMinor, code: "ITEM_LIMIT_EXCEEDED" });
    }
    if (maker.userPerItemLimitMinor !== null) out.push({ limit: maker.userPerItemLimitMinor, code: "ITEM_LIMIT_EXCEEDED" });
    return out;
  };

  if (batch.kind === "BULK") {
    const drafts = parseBulkRows(bound, { currency });
    await evaluateItems([{ transactionType: "BULK_CREDIT", amountMinor: 1n }]);
    const keys = drafts.filter((draft) => draft.rowReference !== null).map((draft) => bulkBusinessKey(draft.rowReference as string));
    const taken = await takenBusinessKeys(deps, batch.corporateId, batch.id, keys);
    const ceilings = itemCeiling("BULK_CREDIT");
    for (const draft of drafts) {
      const shell: RowShell = { id: crypto.randomUUID(), lineNumber: draft.lineNumber, rowReference: draft.rowReference, validationState: draft.validationState, errors: draft.errors, warnings: draft.warnings, bulk: draft, businessKey: draft.rowReference ? bulkBusinessKey(draft.rowReference) : null };
      if (shell.validationState === "VALID" && shell.businessKey && taken.has(shell.businessKey)) invalidate(shell, { code: "DUPLICATE_BUSINESS_REFERENCE", field: "row_reference" }, true);
      if (shell.validationState === "VALID" && draft.amountMinor !== null) {
        for (const ceiling of ceilings) {
          if (draft.amountMinor > ceiling.limit) {
            invalidate(shell, { code: ceiling.code, field: "amount" });
            break;
          }
        }
      }
      shells.push(shell);
    }
    // Name enquiry for rows that are otherwise valid, a bounded number at a time.
    const pending = shells.filter((shell) => shell.validationState === "VALID");
    for (let index = 0; index < pending.length; index += deps.settings.rowConcurrency) {
      await Promise.all(
        pending.slice(index, index + deps.settings.rowConcurrency).map(async (shell) => {
          const facts = shell.bulk as NonNullable<RowShell["bulk"]>;
          const match = await deps.core.validateBeneficiary({ bankCode: corporate.bank.code, correlationId: `batch_${batch.id}` }, { scheme: facts.accountScheme as string, reference: facts.accountReference as string, name: facts.beneficiaryName as string });
          if (match.status === "NOT_FOUND") invalidate(shell, { code: "ACCOUNT_NOT_FOUND", field: "account_reference" });
          else if (match.status === "MISMATCH") invalidate(shell, { code: "NAME_MISMATCH", field: "beneficiary_name" });
          else if (match.status === "CLOSE_MATCH") shell.warnings.push({ code: "NAME_CLOSE_MATCH", field: "beneficiary_name" });
        }),
      );
    }
  } else {
    const policy = await requireEffectivePolicy(deps.db, batch.corporateId, now).catch((error: unknown) => {
      if (error instanceof DomainError) policyError = error.code;
      return null;
    });
    const allowed = policy?.modules.get(batch.moduleId)?.allowedTypes ?? new Set<string>();
    const enabledComponents = new Set<PayrollComponentCode>((["SALARY", "ALLOWANCE"] as const).filter((component) => allowed.has(COMPONENT_TYPE[component])));
    const parsed = parsePayrollRows(bound, { currency, isCorrection: batch.isCorrection, enabledComponents });
    payPeriod = parsed.payPeriod;
    const firstType = enabledComponents.has("SALARY") ? "PAYROLL_SALARY" : "PAYROLL_ALLOWANCE";
    if (enabledComponents.size > 0) await evaluateItems([{ transactionType: firstType, amountMinor: 1n }]);
    const employees = await loadEmployees(deps.db, cap, parsed.rows.map((draft) => draft.employeeCode));
    const keyOf = (draft: PayrollRowDraft) => (draft.component ? payrollBusinessKey({ employeeCode: draft.employeeCode, payPeriod: draft.payPeriod, component: draft.component, correctionReference: draft.correctionReference }) : null);
    const taken = await takenBusinessKeys(deps, batch.corporateId, batch.id, parsed.rows.map(keyOf).filter((key): key is string => key !== null));
    const baselines = payPeriod ? await loadBaselines(deps.db, cap, [...employees.values()].map((employee) => employee.id), payPeriod) : new Map<string, bigint>();
    for (const draft of parsed.rows) {
      const shell: RowShell = { id: crypto.randomUUID(), lineNumber: draft.lineNumber, rowReference: draft.rowReference, validationState: draft.validationState, errors: draft.errors, warnings: draft.warnings, bulk: null, businessKey: keyOf(draft) };
      const employee = employees.get(draft.employeeCode) ?? null;
      if (draft.employeeCode !== "") {
        if (!employee) invalidate(shell, { code: "EMPLOYEE_UNKNOWN", field: "employee_code" });
        else if (!employee.active) invalidate(shell, { code: "EMPLOYEE_INACTIVE", field: "employee_code" });
        // An account that did not pass the name check blocks the line (PYR-01).
        else if (employee.accountMatchStatus !== "MATCHED") invalidate(shell, { code: "EMPLOYEE_ACCOUNT_UNVERIFIED", field: "employee_code" });
      }
      // The same employee, period and component can never be paid twice, whatever the file.
      if (shell.validationState === "VALID" && shell.businessKey && taken.has(shell.businessKey)) invalidate(shell, { code: "DUPLICATE_SALARY", field: "employee_code" }, true);
      if (shell.validationState === "VALID" && draft.netMinor !== null && draft.component) {
        for (const ceiling of itemCeiling(COMPONENT_TYPE[draft.component])) {
          if (draft.netMinor > ceiling.limit) {
            invalidate(shell, { code: ceiling.code, field: "net" });
            break;
          }
        }
      }
      const previous = employee && draft.component ? (baselines.get(`${employee.id}|${draft.component}`) ?? null) : null;
      const changeFlag = shell.validationState === "VALID" && draft.netMinor !== null && salaryChanged(previous, draft.netMinor, SALARY_CHANGE_BPS);
      if (changeFlag) shell.warnings.push({ code: "SALARY_CHANGE", field: "net" });
      shells.push(shell);
      payrollDetails.push({ rowId: shell.id, draft, employee, previousNetMinor: previous, changeFlag });
    }
  }

  const count = (state: RowShell["validationState"]) => shells.filter((shell) => shell.validationState === state).length;
  const validRows = count("VALID");
  const failure: string | null = policyError ?? (validRows === 0 ? "NO_VALID_ROWS" : null);

  await inTx(
    deps.db,
    async (tx) => {
      const current = await lockBatch(tx, batchId);
      if (!current || current.state !== "VALIDATING") return;
      await tx.batchRow.createMany({
        data: shells.map((shell) => ({
          id: shell.id,
          batchId,
          corporateId: batch.corporateId,
          lineNumber: shell.lineNumber,
          rowReference: shell.rowReference,
          validationState: shell.validationState,
          errors: shell.errors as unknown as Prisma.InputJsonValue,
          warnings: shell.warnings as unknown as Prisma.InputJsonValue,
          businessKey: shell.businessKey,
          // Only the booking facts of a bulk row; a payroll row keeps none of them here.
          ...(shell.bulk
            ? {
                amountMinor: shell.bulk.amountMinor,
                currency: shell.bulk.currency,
                beneficiaryName: shell.bulk.beneficiaryName,
                accountScheme: shell.bulk.accountScheme,
                accountReference: shell.bulk.accountReference,
                purpose: shell.bulk.purpose,
                beneficiaryReference: shell.bulk.beneficiaryReference,
              }
            : {}),
        })),
      });
      if (batch.kind === "PAYROLL") await insertPayrollDetails(tx, cap, payrollDetails);
      const next = failure ? "FAILED" : "READY";
      await tx.batch.update({
        where: { id: batchId },
        data: {
          state: next,
          totalRows: shells.length,
          validRows,
          invalidRows: count("INVALID"),
          duplicateRows: count("DUPLICATE"),
          warningRows: shells.filter((shell) => shell.validationState === "VALID" && shell.warnings.length > 0).length,
          payPeriod,
          validationErrorCode: failure,
          ...(failure ? { finishedAt: now } : {}),
          version: { increment: 1 },
        },
      });
      await addTimeline(tx, { at: now, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: failure ? "BATCH_VALIDATION_FAILED" : "BATCH_VALIDATED", fromState: "VALIDATING", toState: next, actorService: "worker", reference: batch.reference, ...(failure ? { detail: { code: failure } } : {}) });
      await notify(tx, {
        bankId: batch.bankId,
        corporateId: batch.corporateId,
        recipientPersonIds: [batch.makerPersonId],
        eventKey: `batch:${batchId}:validated`,
        kind: failure ? "batch.validationFailed" : "batch.validated",
        // Counts only.
        params: { reference: batch.reference, valid: validRows, total: shells.length },
        linkPath: linkOf(batch),
      });
    },
    { ...LONG_TX, skipIdempotency: true },
  );
}

// ---------------------------------------------------------------------------------------------
// Row facts (engine)
// ---------------------------------------------------------------------------------------------

type EngineRow = RowExecutionFacts & { narrative: string };

/** Booking facts of rows of a batch: the accepted ones, or the given candidates. */
async function rowFacts(tx: Tx, batch: Batch, rowIds?: readonly string[]): Promise<EngineRow[]> {
  if (batch.kind === "PAYROLL") {
    const facts = await loadPayrollFacts(tx, engineCapability(batch.corporateId), batch.id, rowIds);
    // The narrative names the run only; the statement shows one consolidated line per run.
    return facts.map((fact) => ({ ...fact, narrative: `Payroll ${batch.reference}` }));
  }
  const rows = await tx.batchRow.findMany({ where: { batchId: batch.id, validationState: "VALID", ...(rowIds ? { id: { in: [...rowIds] } } : { accepted: true }) }, orderBy: { lineNumber: "asc" } });
  return rows.map((row) => ({
    rowId: row.id,
    lineNumber: row.lineNumber,
    businessKey: row.businessKey as string,
    transactionType: "BULK_CREDIT" as const,
    amountMinor: row.amountMinor as bigint,
    destinationScheme: row.accountScheme as string,
    destinationReference: row.accountReference as string,
    destinationName: row.beneficiaryName as string,
    narrative: `${batch.reference} ${row.rowReference ?? ""} ${row.purpose ?? ""}`.trim().slice(0, 200),
  }));
}

async function acceptedFacts(tx: Tx, batch: Batch): Promise<EngineRow[]> {
  if (batch.kind !== "PAYROLL") return rowFacts(tx, batch);
  const accepted = await tx.batchRow.findMany({ where: { batchId: batch.id, accepted: true }, select: { id: true } });
  return accepted.length === 0 ? [] : rowFacts(tx, batch, accepted.map((row) => row.id));
}

const hashOf = (rows: readonly EngineRow[]) => acceptedSetHash(rows.map((row) => ({ lineNumber: row.lineNumber, businessKey: row.businessKey, amountMinor: row.amountMinor, destination: `${row.destinationScheme}:${row.destinationReference}` })));

async function batchFacts(tx: Tx, batch: Batch, rows: readonly EngineRow[], requestedExecuteAt: Date | null): Promise<BatchFacts> {
  const maker = await tx.membership.findUniqueOrThrow({ where: { id: batch.makerMembershipId } });
  return {
    bankId: batch.bankId,
    corporateId: batch.corporateId,
    kind: batch.kind,
    rail: batch.rail as "LYPAY" | "ACH",
    sourceAccountId: batch.sourceAccountId,
    currency: batch.currency,
    items: rows.map((row) => ({ transactionType: row.transactionType, amountMinor: row.amountMinor })),
    requestedExecuteAt,
    userKey: `membership:${maker.id}`,
    userLimits: { perItemMinor: maker.userPerItemLimitMinor, dailyMinor: maker.userDailyLimitMinor },
  };
}

const feeSnapshot = (evaluation: BatchEvaluation) => Object.fromEntries([...evaluation.feeByType.entries()].map(([type, fee]) => [type, fee === null ? null : fee.toString()]));

function feeFor(evaluation: BatchEvaluation, type: BatchTransactionType): bigint {
  const fee = evaluation.feeByType.get(type);
  if (fee === null || fee === undefined) throw new DomainError("TRANSACTION_TYPE_DISABLED", { detail: "No tariff is configured for this transaction type." });
  return fee;
}

/** Only the uploader continues their own batch (the same rule as a payment draft). */
function requireOwner(ctx: CorporateContext, batch: Batch): void {
  requirePermission(ctx, createPermission(batch.kind));
  requireAccountRight(ctx, batch.sourceAccountId, "debit");
  if (ctx.principal.kind !== "person" || ctx.principal.personId !== batch.makerPersonId) throw new DomainError("PERMISSION_DENIED", { detail: "Only the person who uploaded this batch can change it." });
}

// ---------------------------------------------------------------------------------------------
// Accept rows
// ---------------------------------------------------------------------------------------------

/**
 * Explicit confirmation of the row set to submit. Only VALID rows can be accepted; invalid and
 * duplicate rows are left out only with an explicit confirmation, warnings only with an
 * explicit acknowledgment. The server recomputes count, total, fees and the digest; a batch
 * that was already waiting for (or holding) approvals returns to review with those votes void.
 */
export async function acceptRows(deps: Deps, ctx: AuthContext, batchId: string, rawInput: unknown, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  const scoped = await loadScopedBatch(deps, corporateCtx, batchId);
  requireOwner(corporateCtx, scoped);
  const input = acceptRowsSchema.parse(rawInput);
  const now = deps.clock.now();

  try {
    await inTx(
      deps.db,
      async (tx) => {
        const batch = await lockBatch(tx, batchId);
        if (!batch) throw notFound();
        if (batch.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
        if (!["READY", "PENDING_APPROVAL", "SCHEDULED"].includes(batch.state)) throw conflict("Rows can be confirmed only while the batch is in review or waiting.");
        if (input.validationVersion !== batch.validationVersion) throw new DomainError("VERSION_CONFLICT", { detail: "The row set changed. Review it again before confirming." });

        const rows = await tx.batchRow.findMany({ where: { batchId }, select: { id: true, validationState: true, warnings: true } });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const excluded = new Set(input.excludedRowIds);
        for (const id of excluded) {
          if (byId.get(id)?.validationState !== "VALID") throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "excludedRowIds", rule: "validRow", message: "Only valid rows of this batch can be excluded." }] });
        }
        const acceptedIds = rows.filter((row) => row.validationState === "VALID" && !excluded.has(row.id)).map((row) => row.id);
        if (rows.some((row) => row.validationState !== "VALID") && !input.confirmExcludeInvalid) {
          throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "confirmExcludeInvalid", rule: "required", message: "Confirm that invalid and duplicate rows will not be submitted." }] });
        }
        // An empty accepted set is never submitted (BAT-01).
        if (acceptedIds.length === 0) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "excludedRowIds", rule: "emptyAcceptedSet", message: "At least one valid row must remain." }] });
        const withWarnings = rows.filter((row) => acceptedIds.includes(row.id) && Array.isArray(row.warnings) && row.warnings.length > 0).length;
        if (withWarnings > 0 && !input.acknowledgeWarnings) {
          throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "acknowledgeWarnings", rule: "required", message: "Acknowledge the warnings on the rows you are submitting." }] });
        }

        const facts = await rowFacts(tx, batch, acceptedIds);
        if (facts.length !== acceptedIds.length) throw conflict("Some rows can no longer be submitted. Upload the file again.");
        const evaluation = await evaluateBatch(deps, tx, await batchFacts(tx, batch, facts, batch.executeAt));
        const feeTotal = facts.reduce((sum, row) => sum + feeFor(evaluation, row.transactionType), 0n);
        const types = [...evaluation.feeByType.keys()];

        // Votes on an earlier accepted set are void: the proposal returns to review.
        if (batch.state !== "READY" && batch.approvalRequestId) {
          await closeApprovalRequest(tx, batch.approvalRequestId, "SUPERSEDED");
          const instructions = await tx.businessInstruction.findMany({ where: { batchId, state: "PENDING" } });
          for (const instruction of instructions) await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
        }

        // The accepted rows become the live carriers of their business references.
        await tx.batchRow.updateMany({ where: { batchId, id: { notIn: acceptedIds } }, data: { accepted: false, activeBusinessKey: null } });
        for (const row of facts) {
          await tx.batchRow.update({ where: { id: row.rowId }, data: { accepted: true, businessKey: row.businessKey, activeBusinessKey: `${batch.corporateId}:${row.businessKey}` } });
        }
        const total = facts.reduce((sum, row) => sum + row.amountMinor, 0n);
        await tx.batch.update({
          where: { id: batchId },
          data: {
            state: "READY",
            acceptedCount: facts.length,
            acceptedTotalMinor: total,
            feePerItemMinor: types.length === 1 ? feeFor(evaluation, types[0] as BatchTransactionType) : null,
            feeTotalMinor: feeTotal,
            acceptedRowsHash: hashOf(facts),
            warningsAcknowledged: withWarnings > 0,
            validationVersion: { increment: 1 },
            revision: batch.state === "READY" ? batch.revision : batch.revision + 1,
            approvalRequestId: batch.state === "READY" ? batch.approvalRequestId : null,
            releaseBlockCode: null,
            version: { increment: 1 },
          },
        });
        await addTimeline(tx, { at: now, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: batch.state === "READY" ? "BATCH_ROWS_ACCEPTED" : "BATCH_REVISED", fromState: batch.state, toState: "READY", ...timelineActor(corporateCtx), reference: batch.reference });
        await writeAudit(tx, corporateCtx, {
          action: "batch.rows.accepted",
          targetType: "batch",
          targetId: batchId,
          proposalRevision: batch.state === "READY" ? batch.revision : batch.revision + 1,
          // Aggregates and the digest only.
          changes: { acceptedCount: facts.length, excludedValid: excluded.size, notSubmitted: rows.length - facts.length, acceptedRowsHash: hashOf(facts), warningsAcknowledged: withWarnings > 0 },
        });
      },
      LONG_TX,
    );
  } catch (error) {
    // Another open batch already carries one of these business references.
    if (isUniqueViolation(error)) throw new DomainError("DUPLICATE_RESOURCE", { detail: "Another open batch already contains one of these references." });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------------------------

function frozenPayload(batch: Batch, hash: string, count: number, total: bigint, feeTotal: bigint, executeAt: Date | null, fees: Record<string, string | null>, policyVersion: number) {
  return {
    batchId: batch.id,
    kind: batch.kind,
    revision: batch.revision,
    policyVersion,
    sourceAccountId: batch.sourceAccountId,
    currency: batch.currency,
    rail: batch.rail,
    acceptedRowsHash: hash,
    acceptedCount: count,
    totalMinor: total.toString(),
    feeTotalMinor: feeTotal.toString(),
    fees,
    executeAt: executeAt?.toISOString() ?? null,
  };
}

async function approvalSummary(tx: Tx, batch: Batch, count: number, total: bigint, feeTotal: bigint, executeAt: Date | null, previousFeeTotal: bigint | null): Promise<Prisma.InputJsonObject> {
  const source = await tx.account.findUniqueOrThrow({ where: { id: batch.sourceAccountId } });
  const money = (minor: bigint) => ({ currency: batch.currency, minor: minor.toString() });
  return {
    kind: batch.kind,
    reference: batch.reference,
    title: batch.fileName,
    linkPath: linkOf(batch),
    // AGGREGATES ONLY. For payroll nothing below identifies an employee or a single amount.
    count,
    amount: money(total),
    fee: money(feeTotal),
    totalDebit: money(total + feeTotal),
    sourceAccount: { name: source.name, nameAr: source.nameAr, maskedNumber: source.maskedNumber },
    rail: batch.rail,
    executeAt: executeAt?.toISOString() ?? null,
    ...(batch.kind === "PAYROLL" ? { payPeriod: batch.payPeriod, isCorrection: batch.isCorrection, changeFlagCount: await countChangeFlags(tx, engineCapability(batch.corporateId), batch.id) } : {}),
    ...(previousFeeTotal !== null ? { previousFee: money(previousFeeTotal) } : {}),
  };
}

async function openApproval(tx: Tx, deps: Deps, batch: Batch, facts: readonly EngineRow[], evaluation: BatchEvaluation, executeAt: Date | null, makerPersonId: string, policyVersion: number, previousFeeTotal: bigint | null) {
  const total = facts.reduce((sum, row) => sum + row.amountMinor, 0n);
  const feeTotal = facts.reduce((sum, row) => sum + feeFor(evaluation, row.transactionType), 0n);
  const payload = frozenPayload(batch, hashOf(facts), facts.length, total, feeTotal, executeAt, feeSnapshot(evaluation), policyVersion);
  const request = await createApprovalRequest(tx, {
    bankId: batch.bankId,
    corporateId: batch.corporateId,
    klass: batch.kind === "PAYROLL" ? "PAYROLL" : "BULK",
    targetType: "batch",
    targetId: batch.id,
    targetRevision: batch.revision,
    payloadHash: digestOf(payload),
    summary: await approvalSummary(tx, batch, facts.length, total, feeTotal, executeAt, previousFeeTotal),
    makerPersonId,
    requiredApprovals: evaluation.requiredCheckers as number,
    policyVersion,
    policySnapshot: { policyVersion, agreementVersionId: evaluation.policy.agreementVersionId, agreementVersionNo: evaluation.policy.versionNo, fees: feeSnapshot(evaluation), requiredCheckers: evaluation.requiredCheckers },
    sourceAccountId: batch.sourceAccountId,
    amountMinor: total,
    currency: batch.currency,
    expiresAt: new Date(deps.clock.now().getTime() + deps.settings.approvalValidityDays * 86_400_000),
  });
  return { request, total, feeTotal };
}

function enforceSubmittable(evaluation: BatchEvaluation, options: { acceptRolled: boolean; immediate: boolean }): void {
  if (evaluation.feeTotalMinor === null) throw new DomainError("TRANSACTION_TYPE_DISABLED", { detail: "No tariff is configured for this transaction type." });
  if (evaluation.requiredCheckers === null) throw new DomainError("APPROVAL_POLICY_UNAVAILABLE");
  if (evaluation.structuralFailure) throwConstraint(evaluation.structuralFailure);
  if (evaluation.horizonExceeded) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "executeAt", rule: "horizon", message: "Choose a future time within the next 30 days." }] });
  if (!evaluation.window) throw new DomainError("RAIL_CONFIGURATION_REQUIRED");
  if (evaluation.window.rolled && !options.acceptRolled) {
    throw new DomainError("EXECUTION_WINDOW_CLOSED", { violations: [{ field: "execution", rule: evaluation.window.reason ?? "ROLLED", nextExecuteAt: evaluation.window.executeAt.toISOString(), businessDate: evaluation.window.businessDate }] });
  }
  if (options.immediate && !evaluation.window.rolled && evaluation.cumulativeFailure) throwConstraint(evaluation.cumulativeFailure);
}

/** Freeze the accepted set and ask for approval. Nothing is debited and nothing executes. */
export async function submitBatch(deps: Deps, ctx: AuthContext, batchId: string, input: { acceptRolledExecution?: boolean | undefined }, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  const person = requirePerson(corporateCtx);
  const scoped = await loadScopedBatch(deps, corporateCtx, batchId);
  requireOwner(corporateCtx, scoped);
  const now = deps.clock.now();

  await inTx(
    deps.db,
    async (tx) => {
      const batch = await lockBatch(tx, batchId);
      if (!batch) throw notFound();
      if (batch.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
      if (batch.state !== "READY") throw conflict("Only a batch in review can be submitted.");
      const facts = await acceptedFacts(tx, batch);
      if (facts.length === 0 || !batch.acceptedRowsHash) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "batch", rule: "acceptedSet", message: "Confirm the rows to submit first." }] });
      // The stored rows must still be exactly what was confirmed.
      if (hashOf(facts) !== batch.acceptedRowsHash) throw conflict("The row set changed. Confirm the rows again.");

      // A scheduled time that passed while the batch was back in review is never used silently:
      // the maker must accept execution at the next available time.
      const overdue = batch.executeAt !== null && batch.executeAt.getTime() <= now.getTime();
      const requested = overdue ? null : batch.executeAt;
      const evaluation = await evaluateBatch(deps, tx, await batchFacts(tx, batch, facts, requested));
      if (overdue && input.acceptRolledExecution !== true) {
        throw new DomainError("EXECUTION_WINDOW_CLOSED", {
          violations: [{ field: "execution", rule: "SCHEDULE_PASSED", ...(evaluation.window ? { nextExecuteAt: evaluation.window.executeAt.toISOString(), businessDate: evaluation.window.businessDate } : {}) }],
        });
      }
      enforceSubmittable(evaluation, { acceptRolled: input.acceptRolledExecution === true, immediate: requested === null });
      const window = evaluation.window as NonNullable<BatchEvaluation["window"]>;
      const executeAt = requested !== null || window.rolled ? window.executeAt : null;
      const { request, total, feeTotal } = await openApproval(tx, deps, batch, facts, evaluation, executeAt, person.personId, 1, null);
      const types = [...evaluation.feeByType.keys()];
      await tx.batch.update({
        where: { id: batchId },
        data: {
          state: "PENDING_APPROVAL",
          executeAt,
          executionMode: executeAt ? "SCHEDULED" : "IMMEDIATE",
          acceptedTotalMinor: total,
          feeTotalMinor: feeTotal,
          feePerItemMinor: types.length === 1 ? feeFor(evaluation, types[0] as BatchTransactionType) : null,
          approvalRequestId: request.id,
          agreementVersionId: evaluation.policy.agreementVersionId,
          policySnapshot: { fees: feeSnapshot(evaluation), requiredCheckers: evaluation.requiredCheckers, constraints: evaluation.constraints.map(constraintToJson), agreementVersionNo: evaluation.policy.versionNo },
          submittedAt: now,
          version: { increment: 1 },
        },
      });
      await addTimeline(tx, { at: now, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: "BATCH_SENT_FOR_APPROVAL", fromState: "READY", toState: "PENDING_APPROVAL", ...timelineActor(corporateCtx), reference: batch.reference });
      await writeAudit(tx, corporateCtx, {
        action: "batch.submitted",
        targetType: "batch",
        targetId: batchId,
        proposalRevision: batch.revision,
        changes: { acceptedCount: facts.length, totalMinor: total.toString(), feeTotalMinor: feeTotal.toString(), requiredCheckers: evaluation.requiredCheckers, proposalHash: request.payloadHash },
      });
    },
    LONG_TX,
  );
}

// ---------------------------------------------------------------------------------------------
// Approval effects
// ---------------------------------------------------------------------------------------------

function comparePolicy(batch: Batch, evaluation: BatchEvaluation, approvalsRequired: number): "OK" | "FEE_CHANGED" | "CHECKERS_INCREASED" {
  const stored = ((batch.policySnapshot ?? {}) as { fees?: Record<string, string | null> }).fees ?? {};
  for (const [type, fee] of evaluation.feeByType) {
    if (fee === null || stored[type] !== fee.toString()) return "FEE_CHANGED";
  }
  if (evaluation.requiredCheckers === null || evaluation.requiredCheckers > approvalsRequired) return "CHECKERS_INCREASED";
  return "OK";
}

/** One business instruction per accepted row, created or reopened for this batch. */
async function ensureInstructions(tx: Tx, batch: Batch, facts: readonly EngineRow[], evaluation: BatchEvaluation): Promise<Map<string, BusinessInstruction>> {
  const source = await tx.account.findUniqueOrThrow({ where: { id: batch.sourceAccountId } });
  const existing = await tx.businessInstruction.findMany({ where: { corporateId: batch.corporateId, businessKey: { in: facts.map((row) => row.businessKey) } } });
  const byKey = new Map(existing.map((instruction) => [instruction.businessKey, instruction]));
  const out = new Map<string, BusinessInstruction>();
  for (const row of facts) {
    const data = {
      batchId: batch.id,
      moduleId: batch.moduleId,
      transactionType: row.transactionType,
      rail: batch.rail,
      sourceAccountId: batch.sourceAccountId,
      sourceCoreRef: source.coreAccountRef,
      destinationScheme: row.destinationScheme,
      destinationReference: row.destinationReference,
      destinationName: row.destinationName,
      amountMinor: row.amountMinor,
      feeMinor: feeFor(evaluation, row.transactionType),
      currency: batch.currency,
      confidential: batch.kind === "PAYROLL",
      groupRef: batch.kind === "PAYROLL" ? batch.reference : null,
      narrative: row.narrative,
      makerMembershipId: batch.makerMembershipId,
    };
    const current = byKey.get(row.businessKey);
    let instruction: BusinessInstruction;
    if (!current) {
      instruction = await tx.businessInstruction.create({ data: { bankId: batch.bankId, corporateId: batch.corporateId, businessKey: row.businessKey, kind: batch.kind === "PAYROLL" ? "PAYROLL_ROW" : "BULK_ROW", ...data } });
    } else if (current.state === "PENDING" || (current.state === "FAILED" && current.batchId !== null)) {
      // PENDING: this batch's own instruction. FAILED: a definitively failed, never-posted
      // instruction reopened by a retry batch — same business identity, new attempt.
      instruction = await tx.businessInstruction.update({ where: { id: current.id }, data: { ...data, state: "PENDING", failureCode: null, version: { increment: 1 } } });
    } else {
      throw conflict("A row of this batch is already being executed or was already paid.");
    }
    out.set(row.rowId, instruction);
    await tx.batchRow.update({ where: { id: row.rowId }, data: { instructionId: instruction.id, executionState: "PENDING", failureCode: null } });
  }
  return out;
}

async function reserveBatch(tx: Tx, batch: Batch, facts: readonly EngineRow[], instructions: Map<string, BusinessInstruction>, evaluation: BatchEvaluation): Promise<void> {
  const items = [];
  for (const row of facts) {
    const instruction = instructions.get(row.rowId) as BusinessInstruction;
    // Drop a reservation from an older window or policy before reserving again.
    await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
    const cycle = instruction.reservationCycle + 1;
    await tx.businessInstruction.update({ where: { id: instruction.id }, data: { reservationCycle: cycle } });
    items.push({ instructionId: instruction.id, cycle, amountMinor: row.amountMinor, counters: evaluation.countersByType.get(row.transactionType) ?? [] });
  }
  // One atomic reservation for the whole batch: all rows fit, or none is reserved.
  await reserveLimits(tx, { bankId: batch.bankId, corporateId: batch.corporateId, currency: batch.currency, windows: evaluation.windows, items, limits: evaluation.limits });
}

export const batchApprovalTarget = {
  checkVoter: async (tx: Tx, request: { id: string; targetId: string; targetRevision: number; requiredApprovals: number }, _ctx: AuthContext, deps: Deps) => {
    const batch = await lockBatch(tx, request.targetId);
    if (!batch || batch.state !== "PENDING_APPROVAL" || batch.approvalRequestId !== request.id || batch.revision !== request.targetRevision) throw conflict("This proposal is no longer awaiting a decision.");
    const facts = await acceptedFacts(tx, batch);
    if (hashOf(facts) !== batch.acceptedRowsHash) throw new DomainError("REAPPROVAL_REQUIRED");
    const evaluation = await evaluateBatch(deps, tx, await batchFacts(tx, batch, facts, batch.executeAt));
    // A checker never approves a fee or an approval requirement that is no longer current.
    if (comparePolicy(batch, evaluation, request.requiredApprovals) !== "OK") throw new DomainError("REAPPROVAL_REQUIRED");
    if (evaluation.structuralFailure) throwConstraint(evaluation.structuralFailure);
  },
  onApproved: async (tx: Tx, request: { targetId: string }, ctx: AuthContext, deps: Deps) => {
    const batch = (await lockBatch(tx, request.targetId)) as Batch;
    const now = deps.clock.now();
    const scheduled = batch.executeAt !== null && batch.executeAt.getTime() > now.getTime();
    await addTimeline(tx, { at: now, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batch.id, code: "BATCH_APPROVED", fromState: "PENDING_APPROVAL", toState: "APPROVED", ...timelineActor(ctx), reference: batch.reference });
    if (scheduled) {
      // Future-dated: nothing is reserved until the due business date.
      await tx.batch.update({ where: { id: batch.id }, data: { state: "SCHEDULED", version: { increment: 1 } } });
    } else {
      // Immediate: the whole total is reserved in THIS transaction. If any limit would be
      // exceeded the vote is refused and nothing changes (DEC-011).
      const facts = await acceptedFacts(tx, batch);
      const evaluation = await evaluateBatch(deps, tx, await batchFacts(tx, batch, facts, null));
      const instructions = await ensureInstructions(tx, batch, facts, evaluation);
      await reserveBatch(tx, batch, facts, instructions, evaluation);
      await tx.batch.update({ where: { id: batch.id }, data: { state: "APPROVED", version: { increment: 1 } } });
    }
    await enqueueJob(tx, {
      type: JOB_BATCH_RELEASE,
      payload: { batchId: batch.id },
      dedupKey: `batch-release:${batch.id}`,
      ...(scheduled ? { availableAt: batch.executeAt as Date } : {}),
      bankId: batch.bankId,
      corporateId: batch.corporateId,
      aggregateType: "batch",
      aggregateId: batch.id,
      correlationId: ctx.correlationId,
    });
  },
  onRejected: async (tx: Tx, request: { targetId: string }, ctx: AuthContext, deps: Deps, reason: string) => {
    const batch = (await lockBatch(tx, request.targetId)) as Batch;
    await tx.batch.update({ where: { id: batch.id }, data: { state: "REJECTED", finishedAt: deps.clock.now(), version: { increment: 1 } } });
    // The references are free again for a corrected file.
    await tx.batchRow.updateMany({ where: { batchId: batch.id }, data: { activeBusinessKey: null } });
    await addTimeline(tx, { at: deps.clock.now(), bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batch.id, code: "BATCH_REJECTED", fromState: "PENDING_APPROVAL", toState: "REJECTED", ...timelineActor(ctx), reference: batch.reference, detail: { reason } });
  },
  onExpired: async (tx: Tx, request: { id: string; targetId: string }, deps: Deps) => {
    const batch = await lockBatch(tx, request.targetId);
    if (!batch || batch.state !== "PENDING_APPROVAL" || batch.approvalRequestId !== request.id) return;
    await tx.batch.update({ where: { id: batch.id }, data: { state: "CANCELLED", finishedAt: deps.clock.now(), version: { increment: 1 } } });
    await tx.batchRow.updateMany({ where: { batchId: batch.id }, data: { activeBusinessKey: null } });
    await addTimeline(tx, { at: deps.clock.now(), bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batch.id, code: "BATCH_EXPIRED", fromState: "PENDING_APPROVAL", toState: "CANCELLED", actorService: "maintenance", reference: batch.reference });
  },
};

// ---------------------------------------------------------------------------------------------
// Release and dispatch (worker)
// ---------------------------------------------------------------------------------------------

class ReleaseBlocked extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type ReleaseOutcome = { kind: "noop" } | { kind: "started" } | { kind: "defer"; at: Date } | { kind: "reapproval"; reason: "FEE_CHANGED" | "CHECKERS_INCREASED" | "APPROVER_INELIGIBLE" };

async function makerStillEligible(tx: Tx, batch: Batch): Promise<boolean> {
  const person = await tx.person.findUnique({ where: { id: batch.makerPersonId }, select: { status: true } });
  if (person?.status !== "ACTIVE") return false;
  const membership = await tx.membership.findFirst({ where: { id: batch.makerMembershipId, status: "ACTIVE" }, include: { grants: { where: { accountId: batch.sourceAccountId } } } });
  return membership !== null && permissionsForRoles(membership.roles).has(createPermission(batch.kind)) && membership.grants.some((grant) => grant.canDebit);
}

async function approversStillEligible(tx: Tx, batch: Batch): Promise<boolean> {
  if (!batch.approvalRequestId) return false;
  const votes = await tx.approvalVote.findMany({ where: { approvalRequestId: batch.approvalRequestId, decision: "APPROVE" } });
  for (const vote of votes) {
    const person = await tx.person.findUnique({ where: { id: vote.personId }, select: { status: true } });
    if (person?.status !== "ACTIVE") return false;
    const membership = await tx.membership.findFirst({ where: { id: vote.membershipId, personId: vote.personId, corporateId: batch.corporateId, status: "ACTIVE" }, include: { grants: { where: { accountId: batch.sourceAccountId } } } });
    if (!membership || !permissionsForRoles(membership.roles).has(approvePermission(batch.kind)) || !membership.grants.some((grant) => grant.canApprove)) return false;
  }
  return votes.length > 0;
}

/**
 * Before a retried row is sent again, the core is asked about its previous reference. A
 * "failed" attempt that the core nevertheless booked must never be paid a second time.
 */
async function previousAttemptsPosted(deps: Deps, batch: Batch): Promise<boolean> {
  if (!batch.parentBatchId) return false;
  const rows = await deps.db.batchRow.findMany({ where: { batchId: batch.id, accepted: true, retryOfRowId: { not: null } }, select: { businessKey: true } });
  const instructions = await deps.db.businessInstruction.findMany({
    where: { corporateId: batch.corporateId, businessKey: { in: rows.map((row) => row.businessKey as string) } },
    include: { attempts: { orderBy: { attemptNo: "desc" }, take: 1 } },
  });
  const bank = await deps.db.bank.findUniqueOrThrow({ where: { id: batch.bankId }, select: { code: true } });
  for (const instruction of instructions) {
    const last = instruction.attempts[0];
    if (!last) continue;
    const result = await deps.core.inquire({ bankCode: bank.code, correlationId: `batch_${batch.id}` }, last.executionReference);
    if (result.kind === "posted") return true;
  }
  return false;
}

export async function releaseBatch(deps: Deps, batchId: string): Promise<ReleaseOutcome> {
  const candidate = await deps.db.batch.findUnique({ where: { id: batchId } });
  if (!candidate || (candidate.state !== "APPROVED" && candidate.state !== "SCHEDULED")) return { kind: "noop" };
  let blocked: string | null = null;
  let outcome: ReleaseOutcome = { kind: "noop" };
  try {
    // Adapter call OUTSIDE any platform transaction.
    if (await previousAttemptsPosted(deps, candidate)) throw new ReleaseBlocked("STATUS_UNRESOLVED");
    outcome = await inTx(
      deps.db,
      async (tx): Promise<ReleaseOutcome> => {
        const batch = await lockBatch(tx, batchId);
        if (!batch || (batch.state !== "APPROVED" && batch.state !== "SCHEDULED") || batch.releaseBlockCode !== null) return { kind: "noop" };
        const now = deps.clock.now();
        // Never execute early.
        if (batch.state === "SCHEDULED" && batch.executeAt && batch.executeAt.getTime() > now.getTime()) return { kind: "defer", at: batch.executeAt };
        if (!(await makerStillEligible(tx, batch))) throw new ReleaseBlocked("MAKER_INELIGIBLE");
        if (!(await approversStillEligible(tx, batch))) return { kind: "reapproval", reason: "APPROVER_INELIGIBLE" };
        const source = await tx.account.findUniqueOrThrow({ where: { id: batch.sourceAccountId } });
        if (source.status !== "ACTIVE") throw new ReleaseBlocked("ACCOUNT_NOT_ALLOWED");

        const request = await tx.approvalRequest.findUniqueOrThrow({ where: { id: batch.approvalRequestId as string } });
        const facts = await acceptedFacts(tx, batch);
        // The approved digest must still describe exactly the rows about to be sent (I-26).
        if (request.state !== "APPROVED" || request.targetRevision !== batch.revision || hashOf(facts) !== batch.acceptedRowsHash) throw new ReleaseBlocked("REAPPROVAL_REQUIRED");
        const evaluation = await evaluateBatch(deps, tx, await batchFacts(tx, batch, facts, null));
        const comparison = comparePolicy(batch, evaluation, request.requiredApprovals);
        if (comparison !== "OK") return { kind: "reapproval", reason: comparison };
        if (evaluation.structuralFailure) throw new ReleaseBlocked(evaluation.structuralFailure.code);
        if (!evaluation.window) throw new ReleaseBlocked("RAIL_CONFIGURATION_REQUIRED");
        // Rail closed right now: wait for the next window.
        if (evaluation.window.rolled) return { kind: "defer", at: evaluation.window.executeAt };

        const instructions = await ensureInstructions(tx, batch, facts, evaluation);
        await reserveBatch(tx, batch, facts, instructions, evaluation);
        await tx.batch.update({ where: { id: batchId }, data: { state: "PROCESSING", releaseBlockCode: null, version: { increment: 1 } } });
        await addTimeline(tx, { at: now, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: "BATCH_PROCESSING", fromState: batch.state, toState: "PROCESSING", actorService: "worker", reference: batch.reference });
        await enqueueJob(tx, { type: JOB_BATCH_DISPATCH, payload: { batchId }, dedupKey: `batch-dispatch:${batchId}`, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId });
        return { kind: "started" };
      },
      { ...LONG_TX, skipIdempotency: true },
    );
  } catch (error) {
    if (error instanceof ReleaseBlocked) blocked = error.code;
    else if (error instanceof CoreUnavailableError) return { kind: "defer", at: new Date(deps.clock.now().getTime() + 30_000) };
    else if (error instanceof DomainError && error.code !== "INTERNAL_ERROR") blocked = error.code;
    else throw error;
  }
  if (blocked) {
    await blockRelease(deps, batchId, blocked);
    return { kind: "noop" };
  }
  if (outcome.kind === "reapproval") await requireBatchReapproval(deps, batchId, outcome.reason);
  return outcome;
}

/** A control tightened but the proposal is unchanged: stop, show why, never release. */
async function blockRelease(deps: Deps, batchId: string, code: string): Promise<void> {
  await inTx(
    deps.db,
    async (tx) => {
      const batch = await lockBatch(tx, batchId);
      if (!batch || (batch.state !== "APPROVED" && batch.state !== "SCHEDULED")) return;
      const instructions = await tx.businessInstruction.findMany({ where: { batchId, state: "PENDING" } });
      for (const instruction of instructions) await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
      await tx.batch.update({ where: { id: batchId }, data: { state: "APPROVED", releaseBlockCode: code, version: { increment: 1 } } });
      await addTimeline(tx, { at: deps.clock.now(), bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: "RELEASE_BLOCKED", fromState: batch.state, toState: "APPROVED", actorService: "worker", reference: batch.reference, detail: { blockCode: code } });
      await notify(tx, { bankId: batch.bankId, corporateId: batch.corporateId, recipientPersonIds: [batch.makerPersonId], eventKey: `batch:${batchId}:blocked:${code}:${batch.version}`, kind: "batch.releaseBlocked", params: { reference: batch.reference, code }, linkPath: linkOf(batch) });
    },
    { ...LONG_TX, skipIdempotency: true },
  );
}

/**
 * The fee or the required number of checkers changed after submission (or an approver lost
 * access): earlier votes are void and the batch waits for approval again under the current
 * terms. It never silently charges more and never carries approvals over (APR-03, LIM-04).
 */
export async function requireBatchReapproval(deps: Deps, batchId: string, reason: "FEE_CHANGED" | "CHECKERS_INCREASED" | "APPROVER_INELIGIBLE"): Promise<boolean> {
  return inTx(
    deps.db,
    async (tx) => {
      const batch = await lockBatch(tx, batchId);
      if (!batch || !["PENDING_APPROVAL", "APPROVED", "SCHEDULED"].includes(batch.state)) return false;
      const facts = await acceptedFacts(tx, batch);
      const evaluation = await evaluateBatch(deps, tx, await batchFacts(tx, batch, facts, batch.executeAt)).catch(() => null);
      if (!evaluation || evaluation.feeTotalMinor === null || evaluation.requiredCheckers === null) return false;
      const previous = batch.approvalRequestId ? await tx.approvalRequest.findUnique({ where: { id: batch.approvalRequestId } }) : null;
      if (previous?.state === "PENDING") await closeApprovalRequest(tx, previous.id, "SUPERSEDED");
      const instructions = await tx.businessInstruction.findMany({ where: { batchId, state: "PENDING" } });
      for (const instruction of instructions) await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
      const { request, feeTotal } = await openApproval(tx, deps, batch, facts, evaluation, batch.executeAt, batch.makerPersonId, (previous?.policyVersion ?? 1) + 1, batch.feeTotalMinor);
      const types = [...evaluation.feeByType.keys()];
      await tx.batch.update({
        where: { id: batchId },
        data: {
          state: "PENDING_APPROVAL",
          feeTotalMinor: feeTotal,
          feePerItemMinor: types.length === 1 ? feeFor(evaluation, types[0] as BatchTransactionType) : null,
          approvalRequestId: request.id,
          policySnapshot: { fees: feeSnapshot(evaluation), requiredCheckers: evaluation.requiredCheckers, constraints: evaluation.constraints.map(constraintToJson), agreementVersionNo: evaluation.policy.versionNo },
          releaseBlockCode: null,
          version: { increment: 1 },
        },
      });
      await addTimeline(tx, { at: deps.clock.now(), bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: "REAPPROVAL_REQUIRED", fromState: batch.state, toState: "PENDING_APPROVAL", actorService: "worker", reference: batch.reference, detail: { reason } });
      return true;
    },
    { ...LONG_TX, skipIdempotency: true },
  );
}

/** Start attempts for rows that are released and not yet started, a bounded number at a time. */
export async function dispatchBatch(deps: Deps, batchId: string): Promise<void> {
  for (;;) {
    const started = await inTx(
      deps.db,
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; instructionId: string }>>`
          SELECT r."id", r."instructionId" FROM "BatchRow" r
            JOIN "BusinessInstruction" i ON i."id" = r."instructionId"
           WHERE r."batchId" = ${batchId}::uuid AND r."accepted" AND r."executionState" = 'PENDING' AND i."state" = 'PENDING' AND i."batchId" = ${batchId}::uuid
           ORDER BY r."lineNumber" LIMIT ${DISPATCH_CHUNK} FOR UPDATE OF r SKIP LOCKED`;
        for (const row of rows) await startAttempt(tx, deps, row.instructionId, row.id);
        return rows.length;
      },
      { ...LONG_TX, skipIdempotency: true },
    );
    if (started === 0) return;
  }
}

// ---------------------------------------------------------------------------------------------
// Row outcomes → derived batch state
// ---------------------------------------------------------------------------------------------

async function outcomeCounts(tx: Tx, batchId: string): Promise<RowOutcomeCounts> {
  const groups = await tx.batchRow.groupBy({ by: ["executionState"], where: { batchId, accepted: true }, _count: { _all: true } });
  const of = (...states: BatchRow["executionState"][]) => groups.filter((group) => states.includes(group.executionState)).reduce((sum, group) => sum + group._count._all, 0);
  return { accepted: of("NONE", "PENDING", "PROCESSING", "SUBMITTED", "SETTLED", "FAILED", "STATUS_UNKNOWN", "RETURNED", "CANCELLED"), settled: of("SETTLED"), failed: of("FAILED", "CANCELLED"), returned: of("RETURNED"), unknown: of("STATUS_UNKNOWN"), inFlight: of("NONE", "PENDING", "PROCESSING", "SUBMITTED") };
}

/** Mirror one instruction outcome onto its row and re-derive the batch state. */
export async function onRowInstructionChange(tx: Tx, instruction: BusinessInstruction, change: { state: BusinessInstruction["state"]; failureCode: string | null; at: Date }, _deps: Deps): Promise<void> {
  if (!instruction.batchId || change.state === "PENDING") return;
  const row = await tx.batchRow.findFirst({ where: { instructionId: instruction.id, batchId: instruction.batchId } });
  if (!row || row.executionState === change.state) return;
  await tx.batchRow.update({ where: { id: row.id }, data: { executionState: change.state, failureCode: change.state === "FAILED" || change.state === "RETURNED" ? change.failureCode : null } });

  const batch = await lockBatch(tx, instruction.batchId);
  if (!batch || !["PROCESSING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(batch.state)) return;
  const counts = await outcomeCounts(tx, batch.id);
  const next = deriveBatchState(counts);
  if (next === batch.state) return;
  const terminal = next !== "PROCESSING";
  await tx.batch.update({ where: { id: batch.id }, data: { state: next, finishedAt: terminal ? change.at : null, version: { increment: 1 } } });
  // Aggregate facts only: safe for payroll in the timeline, the audit trail, events and alerts.
  const aggregate = { accepted: counts.accepted, settled: counts.settled, failed: counts.failed, unknown: counts.unknown, returned: counts.returned };
  await addTimeline(tx, { at: change.at, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batch.id, code: `BATCH_${next}`, fromState: batch.state, toState: next, actorService: "worker", reference: batch.reference, detail: aggregate });
  if (!terminal) return;
  await tx.auditEvent.create({
    data: { bankId: batch.bankId, corporateId: batch.corporateId, actorKind: "SERVICE", actorService: "worker", action: `batch.execution.${next.toLowerCase()}`, targetType: "batch", targetId: batch.id, correlationId: instruction.correlationId, proposalRevision: batch.revision, changes: { before: batch.state, after: next, reference: batch.reference, ...aggregate }, result: next === "FAILED" ? "FAILED" : "SUCCESS" },
  });
  await emitEvent(tx, { bankId: batch.bankId, corporateId: batch.corporateId, type: "batch.finished", data: { resourceId: batch.id, reference: batch.reference, kind: batch.kind, state: next, ...aggregate }, dedupKey: `batch:${batch.id}:${next}:${counts.settled}:${counts.failed}:${counts.returned}`, correlationId: instruction.correlationId, occurredAt: change.at });
  await notify(tx, { bankId: batch.bankId, corporateId: batch.corporateId, recipientPersonIds: [batch.makerPersonId], eventKey: `batch:${batch.id}:${next}:${counts.settled}:${counts.failed}:${counts.returned}`, kind: "batch.finished", params: { reference: batch.reference, state: next, settled: counts.settled, failed: counts.failed }, linkPath: linkOf(batch) });
}

// ---------------------------------------------------------------------------------------------
// Cancel and failed-row retry
// ---------------------------------------------------------------------------------------------

const CANCELLABLE: ReadonlySet<Batch["state"]> = new Set(["READY", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"]);

/** Cancel a whole batch that has not started executing. Nothing was debited. */
export async function cancelBatch(deps: Deps, ctx: AuthContext, batchId: string, expectedVersion: number, reason: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  const scoped = await loadScopedBatch(deps, corporateCtx, batchId);
  requirePermission(corporateCtx, createPermission(scoped.kind));
  requireAccountRight(corporateCtx, scoped.sourceAccountId, "debit");
  await inTx(
    deps.db,
    async (tx) => {
      const batch = await lockBatch(tx, batchId);
      if (!batch) throw notFound();
      if (batch.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
      // Rows that are in flight or unknown can never be cancelled blindly (BAT-03).
      if (!CANCELLABLE.has(batch.state)) throw new DomainError(batch.state === "PROCESSING" ? "STATUS_UNRESOLVED" : "STATE_CONFLICT", { detail: "This batch can no longer be cancelled." });
      if (batch.approvalRequestId) await closeApprovalRequest(tx, batch.approvalRequestId, "CANCELLED");
      const instructions = await tx.businessInstruction.findMany({ where: { batchId, state: "PENDING" } });
      for (const instruction of instructions) {
        await settleReservations(tx, instruction.id, instruction.reservationCycle, "RELEASED");
        // A never-started instruction of a first-time batch is closed; a reopened one returns to FAILED.
        await tx.businessInstruction.update({ where: { id: instruction.id }, data: { state: instruction.currentAttemptNo > 0 ? "FAILED" : "CANCELLED", version: { increment: 1 } } });
      }
      await tx.batchRow.updateMany({ where: { batchId, accepted: true }, data: { executionState: "CANCELLED", activeBusinessKey: null } });
      await tx.batchRow.updateMany({ where: { batchId }, data: { activeBusinessKey: null } });
      // A cancelled retry hands the references back to the original failed rows.
      if (batch.parentBatchId) {
        const retried = await tx.batchRow.findMany({ where: { batchId, retryOfRowId: { not: null } }, select: { retryOfRowId: true, businessKey: true } });
        for (const row of retried) await tx.batchRow.update({ where: { id: row.retryOfRowId as string }, data: { activeBusinessKey: `${batch.corporateId}:${row.businessKey}` } });
      }
      await tx.batch.update({ where: { id: batchId }, data: { state: "CANCELLED", finishedAt: deps.clock.now(), version: { increment: 1 } } });
      await addTimeline(tx, { at: deps.clock.now(), bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: "BATCH_CANCELLED", fromState: batch.state, toState: "CANCELLED", ...timelineActor(corporateCtx), reference: batch.reference, detail: { reason } });
      await writeAudit(tx, corporateCtx, { action: "batch.cancelled", targetType: "batch", targetId: batchId, reason, proposalRevision: batch.revision, changes: { before: batch.state, after: "CANCELLED" } });
    },
    LONG_TX,
  );
}

/**
 * Retry = a NEW batch linked to its parent, containing only rows that definitively failed
 * before posting. Settled, returned, unknown and in-flight rows are never eligible; unknown
 * rows are resolved by operations, not by "retry all". The new batch needs a fresh
 * confirmation, fresh limits, a fresh fee preview and a fresh approval. A unique constraint
 * allows one live retry chain per original row (I-28).
 */
export async function retryFailedRows(deps: Deps, ctx: AuthContext, parentId: string, rowIds: readonly string[] | undefined, newBatchId: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  const person = requirePerson(corporateCtx);
  const scoped = await loadScopedBatch(deps, corporateCtx, parentId);
  requirePermission(corporateCtx, createPermission(scoped.kind));
  requireAccountRight(corporateCtx, scoped.sourceAccountId, "debit");
  const now = deps.clock.now();
  const corporate = await deps.db.corporate.findUniqueOrThrow({ where: { id: corporateCtx.corporateId }, select: { shortCode: true } });
  const year = businessDateOf(now, deps.timeZone).slice(0, 4);
  const prefix = scoped.kind === "PAYROLL" ? "PYR" : "BLK";

  try {
    await inTx(
      deps.db,
      async (tx) => {
        const parent = await lockBatch(tx, parentId);
        if (!parent) throw notFound();
        if (parent.state !== "PARTIALLY_COMPLETED" && parent.state !== "FAILED") throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "Failed rows can be retried only after the batch has finished." });
        const candidates = await tx.batchRow.findMany({ where: { batchId: parentId, accepted: true, ...(rowIds ? { id: { in: [...rowIds] } } : { executionState: "FAILED" }) } });
        if (rowIds && candidates.length !== new Set(rowIds).size) throw notFound();
        if (candidates.length === 0) throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "There is no failed row to retry." });
        for (const row of candidates) {
          // Unknown rows wait for operations; settled and returned rows are never retried.
          if (row.executionState === "STATUS_UNKNOWN") throw new DomainError("STATUS_UNRESOLVED", { detail: "A selected row has an unknown result. It must be resolved by bank operations first." });
          if (row.executionState !== "FAILED") throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "Only rows that failed before posting can be retried." });
          if (row.activeBusinessKey === null) throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "A selected row is already part of another retry." });
        }
        const instructions = await tx.businessInstruction.findMany({ where: { id: { in: candidates.map((row) => row.instructionId as string) } } });
        if (instructions.some((instruction) => instruction.state !== "FAILED")) throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "Only rows that failed before posting can be retried." });

        const sequence = await nextSequence(tx, `${prefix}:${parent.corporateId}:${year}`);
        const reference = `${prefix}-${corporate.shortCode}-${year}-${sequence.toString().padStart(6, "0")}`;
        await tx.batch.create({
          data: {
            id: newBatchId,
            bankId: parent.bankId,
            corporateId: parent.corporateId,
            kind: parent.kind,
            reference,
            moduleId: parent.moduleId,
            sourceAccountId: parent.sourceAccountId,
            currency: parent.currency,
            rail: parent.rail,
            executionMode: "IMMEDIATE",
            state: "READY",
            fileName: parent.fileName,
            fileSha256: parent.fileSha256,
            fileSizeBytes: parent.fileSizeBytes,
            fileFormat: parent.fileFormat,
            templateVersion: parent.templateVersion,
            payPeriod: parent.payPeriod,
            isCorrection: parent.isCorrection,
            totalRows: candidates.length,
            validRows: candidates.length,
            parentBatchId: parent.id,
            makerPersonId: person.personId,
            makerMembershipId: corporateCtx.membershipId as string,
          },
        });
        const details = parent.kind === "PAYROLL" ? await tx.payrollRowDetail.findMany({ where: { batchRowId: { in: candidates.map((row) => row.id) } } }) : [];
        const detailByRow = new Map(details.map((detail) => [detail.batchRowId, detail]));
        let line = 0;
        for (const row of candidates.sort((a, b) => a.lineNumber - b.lineNumber)) {
          line += 1;
          const id = crypto.randomUUID();
          // The original row stops carrying the reference in the same transaction that the
          // retry row starts: two concurrent retries cannot both succeed.
          const released = await tx.batchRow.updateMany({ where: { id: row.id, activeBusinessKey: row.activeBusinessKey }, data: { activeBusinessKey: null } });
          if (released.count !== 1) throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "A selected row is already part of another retry." });
          await tx.batchRow.create({
            data: {
              id,
              batchId: newBatchId,
              corporateId: parent.corporateId,
              lineNumber: line,
              rowReference: row.rowReference,
              validationState: "VALID",
              amountMinor: row.amountMinor,
              currency: row.currency,
              beneficiaryName: row.beneficiaryName,
              accountScheme: row.accountScheme,
              accountReference: row.accountReference,
              purpose: row.purpose,
              beneficiaryReference: row.beneficiaryReference,
              businessKey: row.businessKey,
              activeBusinessKey: row.activeBusinessKey,
              instructionId: row.instructionId,
              retryOfRowId: row.id,
            },
          });
          const detail = detailByRow.get(row.id);
          if (detail) await tx.payrollRowDetail.create({ data: { ...detail, batchRowId: id, changeFlag: false } });
        }
        await addTimeline(tx, { at: now, bankId: parent.bankId, corporateId: parent.corporateId, aggregateType: "batch", aggregateId: newBatchId, code: "BATCH_RETRY_CREATED", toState: "READY", ...timelineActor(corporateCtx), reference });
        await writeAudit(tx, corporateCtx, { action: "batch.retry.created", targetType: "batch", targetId: newBatchId, changes: { reference, parentBatchId: parent.id, parentReference: parent.reference, rows: candidates.length } });
      },
      LONG_TX,
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("RETRY_NOT_ELIGIBLE", { detail: "A selected row is already part of another retry." });
    throw error;
  }
}

/** Ask for a blocked release again after the cause was fixed. Everything is re-checked. */
export async function retryBatchRelease(deps: Deps, ctx: AuthContext, batchId: string, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  const scoped = await loadScopedBatch(deps, corporateCtx, batchId);
  requirePermission(corporateCtx, createPermission(scoped.kind));
  requireAccountRight(corporateCtx, scoped.sourceAccountId, "debit");
  await inTx(deps.db, async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!batch) throw notFound();
    if (batch.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (batch.state !== "APPROVED" || batch.releaseBlockCode === null) throw conflict("This batch is not waiting on a blocked release.");
    await tx.batch.update({ where: { id: batchId }, data: { releaseBlockCode: null, version: { increment: 1 } } });
    await enqueueJob(tx, { type: JOB_BATCH_RELEASE, payload: { batchId }, dedupKey: `batch-release:${batchId}`, bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, correlationId: corporateCtx.correlationId });
    await addTimeline(tx, { at: deps.clock.now(), bankId: batch.bankId, corporateId: batch.corporateId, aggregateType: "batch", aggregateId: batchId, code: "RELEASE_RETRY_REQUESTED", fromState: "APPROVED", toState: "APPROVED", ...timelineActor(corporateCtx), reference: batch.reference });
    await writeAudit(tx, corporateCtx, { action: "batch.release.retry", targetType: "batch", targetId: batchId, proposalRevision: batch.revision });
  });
}

/** Used by the validation job to report a failure without leaking file content to logs. */
export function logValidationFailure(batchId: string, error: unknown): void {
  logWarn("batch", "validation could not be completed", { batchId, error: error instanceof Error ? error.name : "unknown" });
}
