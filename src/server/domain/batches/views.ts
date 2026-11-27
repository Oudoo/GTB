/**
 * Read models for batches (BAT-02, PYR-02, SEC-04).
 *
 * There are deliberately SEPARATE projections:
 *   - the batch summary and outcome counts are aggregates, safe for every permitted reader;
 *   - bulk rows show beneficiary, masked account and amount to bulk readers;
 *   - payroll rows are projected twice: a masked shell (line, state) for aggregate readers and
 *     the restricted detail only for a holder of the payroll-detail capability.
 * A reader without that capability cannot receive a name, an account, a component, a net
 * amount, a row reference or a row error for a payroll line — the masked projection has no
 * such fields to fill.
 */
import type { RowIssue, RowWarningCode } from "@/contracts/batches";
import { maskAccountReference } from "@/contracts/common";
import { DomainError, notFound } from "@/contracts/errors";
import { formatMinor, minorToJson, type Currency, type MoneyJson } from "@/contracts/money";
import { writeAudit } from "@/server/audit/audit";
import { requireCorporate, rightsFor, type AuthContext, type CorporateContext } from "@/server/auth/context";
import type { Prisma } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { getApproval, type ApprovalView } from "@/server/domain/approvals/service";
import { loadPayrollRowDetails, requirePayrollDetail, type PayrollRowDetailView } from "@/server/domain/payroll/detail";
import { toCsv } from "@/server/files/csv";
import { downloadResponse } from "@/server/files/storage";
import { TEMPLATES, templateFile } from "@/server/files/tabular";
import type { Batch, BatchRow } from "@/generated/prisma/client";
import { createPermission, loadScopedBatch, readPermission } from "./service";

export type BatchView = {
  id: string;
  kind: Batch["kind"];
  reference: string;
  state: Batch["state"];
  version: number;
  validationVersion: number;
  revision: number;
  sourceAccount: { id: string; name: string; nameAr: string; maskedNumber: string };
  currency: string;
  rail: string;
  executeAt: string | null;
  file: { name: string; format: string; sizeBytes: number; sha256: string };
  payPeriod: string | null;
  isCorrection: boolean;
  counts: { total: number; valid: number; invalid: number; duplicate: number; warnings: number; accepted: number };
  /** Aggregates of the accepted set. NULL until rows are confirmed. */
  accepted: { amount: MoneyJson; fee: MoneyJson; totalDebit: MoneyJson } | null;
  /** Aggregates of execution. NULL before release. */
  outcome: { settled: number; failed: number; unknown: number; returned: number; inFlight: number; settledAmount: MoneyJson } | null;
  validationErrorCode: string | null;
  releaseBlockCode: string | null;
  identicalTo: { id: string; reference: string } | null;
  parent: { id: string; reference: string } | null;
  maker: { personId: string; name: string };
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  actions: { accept: boolean; submit: boolean; cancel: boolean; retry: boolean; retryRelease: boolean; detail: boolean };
};

export type BatchDetail = BatchView & {
  approval: ApprovalView | null;
  retries: Array<{ id: string; reference: string; state: string }>;
  timeline: Array<{ at: string; code: string; fromState: string | null; toState: string | null; actor: string | null }>;
};

function kindsFor(ctx: CorporateContext): Batch["kind"][] {
  const out: Batch["kind"][] = [];
  if (ctx.permissions.has("batches.read") || ctx.permissions.has("batches.create")) out.push("BULK");
  if (ctx.permissions.has("payroll.aggregate.read") || ctx.permissions.has("payroll.detail")) out.push("PAYROLL");
  return out;
}

async function toViews(deps: Deps, ctx: CorporateContext, batches: Batch[]): Promise<BatchView[]> {
  if (batches.length === 0) return [];
  const accounts = await deps.db.account.findMany({ where: { id: { in: [...new Set(batches.map((batch) => batch.sourceAccountId))] } } });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const people = await deps.db.person.findMany({ where: { id: { in: [...new Set(batches.map((batch) => batch.makerPersonId))] } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  const linked = [...new Set(batches.flatMap((batch) => [batch.identicalToBatchId, batch.parentBatchId]).filter((id): id is string => id !== null))];
  const references = await deps.db.batch.findMany({ where: { id: { in: linked }, corporateId: ctx.corporateId }, select: { id: true, reference: true } });
  const referenceById = new Map(references.map((batch) => [batch.id, batch.reference]));
  const ids = batches.map((batch) => batch.id);
  const rowGroups = await deps.db.batchRow.groupBy({ by: ["batchId", "executionState"], where: { batchId: { in: ids }, accepted: true }, _count: { _all: true } });
  // Settled value comes from the instructions, so the aggregate is exact for payroll too.
  const settled = await deps.db.businessInstruction.groupBy({ by: ["batchId"], where: { batchId: { in: ids }, state: "SETTLED" }, _sum: { amountMinor: true } });
  const settledBy = new Map(settled.map((row) => [row.batchId, row._sum.amountMinor ?? 0n]));
  const person = ctx.principal.kind === "person" ? ctx.principal.personId : null;

  return batches.map((batch) => {
    const account = accountById.get(batch.sourceAccountId);
    const groups = rowGroups.filter((group) => group.batchId === batch.id);
    const of = (...states: BatchRow["executionState"][]) => groups.filter((group) => states.includes(group.executionState)).reduce((sum, group) => sum + group._count._all, 0);
    const started = ["PROCESSING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(batch.state) && batch.validationErrorCode === null;
    const owner = person !== null && person === batch.makerPersonId;
    const canCreate = ctx.permissions.has(createPermission(batch.kind)) && rightsFor(ctx, batch.sourceAccountId).debit;
    const link = (id: string | null) => (id && referenceById.has(id) ? { id, reference: referenceById.get(id) as string } : null);
    return {
      id: batch.id,
      kind: batch.kind,
      reference: batch.reference,
      state: batch.state,
      version: batch.version,
      validationVersion: batch.validationVersion,
      revision: batch.revision,
      sourceAccount: { id: batch.sourceAccountId, name: account?.name ?? "", nameAr: account?.nameAr ?? "", maskedNumber: account?.maskedNumber ?? "" },
      currency: batch.currency,
      rail: batch.rail,
      executeAt: batch.executeAt?.toISOString() ?? null,
      file: { name: batch.fileName, format: batch.fileFormat, sizeBytes: batch.fileSizeBytes, sha256: batch.fileSha256 },
      payPeriod: batch.payPeriod,
      isCorrection: batch.isCorrection,
      counts: { total: batch.totalRows, valid: batch.validRows, invalid: batch.invalidRows, duplicate: batch.duplicateRows, warnings: batch.warningRows, accepted: batch.acceptedCount },
      accepted: batch.acceptedRowsHash
        ? { amount: minorToJson(batch.acceptedTotalMinor, batch.currency), fee: minorToJson(batch.feeTotalMinor, batch.currency), totalDebit: minorToJson(batch.acceptedTotalMinor + batch.feeTotalMinor, batch.currency) }
        : null,
      outcome: started
        ? { settled: of("SETTLED"), failed: of("FAILED", "CANCELLED"), unknown: of("STATUS_UNKNOWN"), returned: of("RETURNED"), inFlight: of("NONE", "PENDING", "PROCESSING", "SUBMITTED"), settledAmount: minorToJson(settledBy.get(batch.id) ?? 0n, batch.currency) }
        : null,
      validationErrorCode: batch.validationErrorCode,
      releaseBlockCode: batch.releaseBlockCode,
      identicalTo: link(batch.identicalToBatchId),
      parent: link(batch.parentBatchId),
      maker: { personId: batch.makerPersonId, name: names.get(batch.makerPersonId) ?? "" },
      createdAt: batch.createdAt.toISOString(),
      submittedAt: batch.submittedAt?.toISOString() ?? null,
      finishedAt: batch.finishedAt?.toISOString() ?? null,
      actions: {
        accept: canCreate && owner && ["READY", "PENDING_APPROVAL", "SCHEDULED"].includes(batch.state),
        submit: canCreate && owner && batch.state === "READY" && batch.acceptedRowsHash !== null,
        cancel: canCreate && ["READY", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"].includes(batch.state),
        retry: canCreate && (batch.state === "PARTIALLY_COMPLETED" || batch.state === "FAILED") && batch.validationErrorCode === null && of("FAILED") > 0,
        retryRelease: canCreate && batch.state === "APPROVED" && batch.releaseBlockCode !== null,
        detail: batch.kind === "BULK" || ctx.permissions.has("payroll.detail"),
      },
    };
  });
}

export async function listBatches(
  deps: Deps,
  ctx: AuthContext,
  filter: { kind?: Batch["kind"] | undefined; state?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
): Promise<{ items: BatchView[]; nextCursor: string | null }> {
  const corporateCtx = requireCorporate(ctx);
  const kinds = kindsFor(corporateCtx).filter((kind) => !filter.kind || kind === filter.kind);
  if (kinds.length === 0) throw new DomainError("PERMISSION_DENIED");
  const readable = [...corporateCtx.grants.entries()].filter(([, rights]) => rights.read).map(([id]) => id);
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const rows = await deps.db.batch.findMany({
    where: { corporateId: corporateCtx.corporateId, kind: { in: kinds }, sourceAccountId: { in: readable }, ...(filter.state ? { state: filter.state as Batch["state"] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return { items: await toViews(deps, corporateCtx, page), nextCursor: rows.length > limit ? (page[page.length - 1] as Batch).id : null };
}

export async function getBatch(deps: Deps, ctx: AuthContext, batchId: string): Promise<BatchDetail> {
  const corporateCtx = requireCorporate(ctx);
  const batch = await loadScopedBatch(deps, corporateCtx, batchId);
  const [view] = await toViews(deps, corporateCtx, [batch]);
  const approval = batch.approvalRequestId ? await getApproval(deps, corporateCtx, batch.approvalRequestId).catch(() => null) : null;
  const retries = await deps.db.batch.findMany({ where: { parentBatchId: batch.id, corporateId: corporateCtx.corporateId }, select: { id: true, reference: true, state: true }, orderBy: { createdAt: "asc" } });
  const timeline = await deps.db.timelineEvent.findMany({ where: { aggregateType: "batch", aggregateId: batch.id }, orderBy: { id: "asc" } });
  const actors = await deps.db.person.findMany({ where: { id: { in: timeline.map((event) => event.actorPersonId).filter((id): id is string => id !== null) } }, select: { id: true, name: true } });
  const actorName = new Map(actors.map((actor) => [actor.id, actor.name]));
  return {
    ...(view as BatchView),
    approval,
    retries,
    timeline: timeline.map((event) => ({ at: event.at.toISOString(), code: event.code, fromState: event.fromState, toState: event.toState, actor: event.actorPersonId ? (actorName.get(event.actorPersonId) ?? null) : event.actorService })),
  };
}

type RowBase = { id: string; lineNumber: number; validationState: BatchRow["validationState"]; accepted: boolean; executionState: BatchRow["executionState"] };

/** A bulk row for a bulk reader. */
export type BulkRowView = RowBase & {
  projection: "BULK";
  rowReference: string | null;
  errors: RowIssue[];
  warnings: RowIssue<RowWarningCode>[];
  amount: MoneyJson | null;
  beneficiaryName: string | null;
  maskedAccount: string | null;
  purpose: string | null;
  failureCode: string | null;
  executionReference: string | null;
};

/** A payroll row for an aggregate reader: no identity, no amount, no reference, no errors. */
export type MaskedPayrollRowView = RowBase & { projection: "PAYROLL_MASKED"; maskedReference: string };

/** A payroll row for a holder of the payroll-detail capability. */
export type PayrollRowView = RowBase & {
  projection: "PAYROLL_DETAIL";
  rowReference: string | null;
  errors: RowIssue[];
  warnings: RowIssue<RowWarningCode>[];
  failureCode: string | null;
  executionReference: string | null;
  detail: PayrollRowDetailView | null;
};

export type BatchRowView = BulkRowView | MaskedPayrollRowView | PayrollRowView;

const ROW_FILTERS: Record<string, Prisma.BatchRowWhereInput> = {
  ALL: {},
  VALID: { validationState: "VALID" },
  INVALID: { validationState: { in: ["INVALID", "DUPLICATE"] } },
  ACCEPTED: { accepted: true },
  FAILED: { accepted: true, executionState: "FAILED" },
  UNKNOWN: { accepted: true, executionState: "STATUS_UNKNOWN" },
};

async function executionReferences(deps: Deps, rows: readonly BatchRow[]): Promise<Map<string, string>> {
  const attempts = await deps.db.executionAttempt.findMany({ where: { batchRowId: { in: rows.map((row) => row.id) } }, select: { batchRowId: true, executionReference: true, attemptNo: true }, orderBy: { attemptNo: "asc" } });
  return new Map(attempts.map((attempt) => [attempt.batchRowId as string, attempt.executionReference]));
}

export async function listBatchRows(
  deps: Deps,
  ctx: AuthContext,
  batchId: string,
  query: { filter?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
): Promise<{ items: BatchRowView[]; nextCursor: string | null; projection: BatchRowView["projection"] }> {
  const corporateCtx = requireCorporate(ctx);
  const batch = await loadScopedBatch(deps, corporateCtx, batchId);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await deps.db.batchRow.findMany({
    where: { batchId, ...(ROW_FILTERS[query.filter ?? "ALL"] ?? {}) },
    orderBy: [{ lineNumber: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1] as BatchRow).id : null;
  const base = (row: BatchRow): RowBase => ({ id: row.id, lineNumber: row.lineNumber, validationState: row.validationState, accepted: row.accepted, executionState: row.executionState });

  if (batch.kind === "BULK") {
    const references = await executionReferences(deps, page);
    return {
      projection: "BULK",
      nextCursor,
      items: page.map((row) => ({
        ...base(row),
        projection: "BULK",
        rowReference: row.rowReference,
        errors: row.errors as unknown as RowIssue[],
        warnings: row.warnings as unknown as RowIssue<RowWarningCode>[],
        amount: row.amountMinor !== null ? minorToJson(row.amountMinor, batch.currency) : null,
        beneficiaryName: row.beneficiaryName,
        maskedAccount: row.accountReference ? maskAccountReference(row.accountReference) : null,
        purpose: row.purpose,
        failureCode: row.failureCode,
        executionReference: references.get(row.id) ?? null,
      })),
    };
  }

  if (!corporateCtx.permissions.has("payroll.detail")) {
    // Aggregate readers (checker, finance, viewer): a shell per line and nothing else.
    return { projection: "PAYROLL_MASKED", nextCursor, items: page.map((row) => ({ ...base(row), projection: "PAYROLL_MASKED", maskedReference: `••••${String(row.lineNumber).padStart(3, "0")}` })) };
  }

  const cap = requirePayrollDetail(corporateCtx);
  const details = await loadPayrollRowDetails(deps.db, cap, page.map((row) => row.id));
  const references = await executionReferences(deps, page);
  // Reading salary detail is itself recorded (without the content).
  await writeAudit(deps.db, corporateCtx, { action: "payroll.detail.read", targetType: "batch", targetId: batchId, sensitiveRead: true, changes: { rows: page.length } });
  return {
    projection: "PAYROLL_DETAIL",
    nextCursor,
    items: page.map((row) => ({
      ...base(row),
      projection: "PAYROLL_DETAIL",
      rowReference: row.rowReference,
      errors: row.errors as unknown as RowIssue[],
      warnings: row.warnings as unknown as RowIssue<RowWarningCode>[],
      failureCode: row.failureCode,
      executionReference: references.get(row.id) ?? null,
      detail: details.get(row.id) ?? null,
    })),
  };
}

const issueCodes = (value: unknown): string => (Array.isArray(value) ? (value as RowIssue[]).map((issue) => `${issue.field}:${issue.code}`).join(" | ") : "");

/**
 * Row-level downloads. For payroll these contain employee detail, so they need the
 * payroll-detail capability; an aggregate reader is refused, not given a redacted file.
 */
async function rowExport(deps: Deps, ctx: AuthContext, batchId: string, kind: "errors" | "result"): Promise<Response> {
  const corporateCtx = requireCorporate(ctx);
  const batch = await loadScopedBatch(deps, corporateCtx, batchId);
  if (!corporateCtx.permissions.has(readPermission(batch.kind)) && !corporateCtx.permissions.has(createPermission(batch.kind))) throw new DomainError("PERMISSION_DENIED");
  const cap = batch.kind === "PAYROLL" ? requirePayrollDetail(corporateCtx) : null;
  const rows = await deps.db.batchRow.findMany({
    where: { batchId, ...(kind === "errors" ? { validationState: { in: ["INVALID", "DUPLICATE"] } } : { accepted: true }) },
    orderBy: { lineNumber: "asc" },
    take: 1_000,
  });
  const details = cap ? await loadPayrollRowDetails(deps.db, cap, rows.map((row) => row.id)) : new Map<string, PayrollRowDetailView>();
  const references = kind === "result" ? await executionReferences(deps, rows) : new Map<string, string>();
  const currency = batch.currency as Currency;
  const amountOf = (row: BatchRow): string => {
    const minor = batch.kind === "PAYROLL" ? details.get(row.id)?.netMinor : row.amountMinor?.toString();
    return minor ? formatMinor(BigInt(minor), currency) : "";
  };
  const data =
    kind === "errors"
      ? toCsv(["line", "row_reference", "state", "problems"], rows.map((row) => [row.lineNumber, row.rowReference ?? "", row.validationState, issueCodes(row.errors)]))
      : toCsv(
          ["line", "row_reference", batch.kind === "PAYROLL" ? "employee_code" : "beneficiary_name", "amount", "currency", "outcome", "failure_code", "execution_reference"],
          rows.map((row) => [row.lineNumber, row.rowReference ?? "", batch.kind === "PAYROLL" ? (details.get(row.id)?.employeeCode ?? "") : (row.beneficiaryName ?? ""), amountOf(row), batch.currency, row.executionState, row.failureCode ?? "", references.get(row.id) ?? ""]),
        );
  await writeAudit(deps.db, corporateCtx, { action: `batch.${kind}.exported`, targetType: "batch", targetId: batchId, sensitiveRead: batch.kind === "PAYROLL", changes: { rows: rows.length, reference: batch.reference } });
  return downloadResponse(data, "csv", `${batch.reference}-${kind}`);
}

export const batchErrorsCsv = (deps: Deps, ctx: AuthContext, batchId: string) => rowExport(deps, ctx, batchId, "errors");
export const batchResultCsv = (deps: Deps, ctx: AuthContext, batchId: string) => rowExport(deps, ctx, batchId, "result");

const EXAMPLES = {
  bulk: [{ row_reference: "DEMO-ROW-0001", beneficiary_name: "Tripoli Office Supplies Demo", account_scheme: "DEMO_DOMESTIC", account_reference: "DEMO-LY-900001", amount: "125.000", currency: "LYD", purpose: "Synthetic example row" }],
  payroll: [{ row_reference: "DEMO-PAY-0001", employee_code: "EMP-001", pay_period: "2026-11", component: "SALARY", basic: "1500.000", allowances: "200.000", deductions: "50.000", correction: "0.000", payslip_reference: "PS-2026-11-001", currency: "LYD" }],
  employees: [{ employee_code: "EMP-001", employee_name: "Demo Staff Amna", account_scheme: "DEMO_DOMESTIC", account_reference: "DEMO-LY-910001", active: "true" }],
} as const;

const INSTRUCTIONS = [
  "Synthetic sandbox template. Keep the header row exactly as provided.",
  "Enter amounts as text with a dot as decimal separator and no grouping, for example 125.000.",
  "Formulas, macros, links and extra sheets are rejected. Keep account references as text.",
];

/** Versioned template download. The payroll and employee templates need payroll rights. */
export function templateDownload(ctx: AuthContext, kind: "bulk" | "payroll" | "employees", format: "csv" | "xlsx"): Response {
  const corporateCtx = requireCorporate(ctx);
  const allowed = kind === "bulk" ? corporateCtx.permissions.has("batches.create") || corporateCtx.permissions.has("batches.read") : corporateCtx.permissions.has("payroll.detail");
  if (!allowed) throw notFound();
  const spec = TEMPLATES[kind];
  const data = templateFile(spec, format === "xlsx" ? "XLSX" : "CSV", [...EXAMPLES[kind]], INSTRUCTIONS);
  return downloadResponse(data, format, `al-qarib-${kind}-template-v${spec.version}`);
}
