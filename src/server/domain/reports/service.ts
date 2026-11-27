/**
 * Statements and deposit summaries as files (RPT-01).
 *
 * A report is authorized three times: when it is requested, when the worker generates it and
 * when it is downloaded. Generation and download use the requester's CURRENT rights, so a
 * person who lost report access after asking gets nothing — the artifact is never a bearer
 * token. Files use the same projections as the screens: a payroll run is one consolidated
 * statement line and no per-employee entry can reach a file.
 */
import { reportRequestSchema } from "@/contracts/reports";
import { DomainError, conflict, notFound } from "@/contracts/errors";
import { formatMinor, type Currency } from "@/contracts/money";
import { MESSAGES } from "@/i18n/messages";
import { daysBetween } from "@/lib/calendar";
import { writeAudit } from "@/server/audit/audit";
import { requireCorporate, requirePermission, requirePerson, rightsFor, type AuthContext, type CorporateContext } from "@/server/auth/context";
import { currentContextOf } from "@/server/auth/session";
import { inTx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { getStatement, type StatementLine } from "@/server/domain/accounts/service";
import { listDeposits, type DepositView } from "@/server/domain/collections/deposits";
import { toCsv } from "@/server/files/csv";
import { PdfBuilder } from "@/server/files/pdf";
import { downloadResponse, putPrivateFile, readPrivateFile } from "@/server/files/storage";
import { sha256Hex } from "@/server/hash";
import { enqueueJob } from "@/server/jobs/queue";
import type { Report } from "@/generated/prisma/client";

export const JOB_REPORT_GENERATE = "report.generate";
const MAX_RANGE_DAYS = 366;
const MAX_LINES = 5_000;
const VALIDITY_DAYS = 7;

export type ReportView = {
  id: string;
  type: Report["type"];
  format: Report["format"];
  state: Report["state"] | "EXPIRED";
  accounts: Array<{ id: string; name: string; nameAr: string; maskedNumber: string }>;
  fromDate: string;
  toDate: string;
  locale: string;
  rowCount: number | null;
  fileName: string | null;
  failureCode: string | null;
  downloadable: boolean;
  createdAt: string;
  expiresAt: string;
};

type Params = { fromDate: string; toDate: string; customerId: string | null };

/** The caller may export every requested account right now. */
function requireReportRights(ctx: CorporateContext, type: Report["type"], accountIds: readonly string[]): void {
  requirePermission(ctx, "reports.request");
  if (type === "DEPOSIT_SUMMARY") requirePermission(ctx, "deposits.read");
  // An account the caller cannot export answers like an account that does not exist.
  if (accountIds.some((id) => !rightsFor(ctx, id).report || !rightsFor(ctx, id).read)) throw notFound();
}

async function toViews(deps: Deps, reports: Report[], now: Date): Promise<ReportView[]> {
  const accounts = await deps.db.account.findMany({ where: { id: { in: [...new Set(reports.flatMap((report) => report.accountIds))] } }, select: { id: true, name: true, nameAr: true, maskedNumber: true } });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return reports.map((report) => {
    const params = report.params as Params;
    const expired = report.expiresAt.getTime() <= now.getTime();
    return {
      id: report.id,
      type: report.type,
      format: report.format,
      state: expired && report.state === "READY" ? "EXPIRED" : report.state,
      accounts: report.accountIds.map((id) => accountById.get(id)).filter((account): account is NonNullable<typeof account> => account !== undefined),
      fromDate: params.fromDate,
      toDate: params.toDate,
      locale: report.locale,
      rowCount: report.rowCount,
      fileName: report.fileName,
      failureCode: report.failureCode,
      downloadable: report.state === "READY" && !expired,
      createdAt: report.createdAt.toISOString(),
      expiresAt: report.expiresAt.toISOString(),
    };
  });
}

export async function requestReport(deps: Deps, ctx: AuthContext, rawInput: unknown, reportId: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  const person = requirePerson(corporateCtx);
  const input = reportRequestSchema.parse(rawInput);
  requireReportRights(corporateCtx, input.type, input.accountIds);
  const days = daysBetween(input.fromDate, input.toDate);
  if (days < 0 || days > MAX_RANGE_DAYS) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "fromDate", rule: "range", message: "Choose a range of at most 366 days." }] });
  // Named deferral: the deposit summary is produced as CSV only in this release.
  if (input.type === "DEPOSIT_SUMMARY" && input.format !== "CSV") throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "format", rule: "depositSummaryCsvOnly", message: "The deposit summary is available as CSV." }] });
  const now = deps.clock.now();
  await inTx(deps.db, async (tx) => {
    await tx.report.create({
      data: {
        id: reportId,
        bankId: corporateCtx.bankId,
        corporateId: corporateCtx.corporateId,
        type: input.type,
        format: input.format,
        params: { fromDate: input.fromDate, toDate: input.toDate, customerId: input.customerId ?? null },
        accountIds: [...new Set(input.accountIds)],
        locale: input.locale ?? "en",
        requestedByPersonId: person.personId,
        requestedByMembershipId: corporateCtx.membershipId as string,
        expiresAt: new Date(now.getTime() + VALIDITY_DAYS * 86_400_000),
        createdAt: now,
      },
    });
    await enqueueJob(tx, { type: JOB_REPORT_GENERATE, payload: { reportId }, dedupKey: `report:${reportId}`, bankId: corporateCtx.bankId, corporateId: corporateCtx.corporateId, aggregateType: "report", aggregateId: reportId, correlationId: corporateCtx.correlationId });
    await writeAudit(tx, corporateCtx, { action: "report.requested", targetType: "report", targetId: reportId, changes: { type: input.type, format: input.format, accounts: input.accountIds.length, fromDate: input.fromDate, toDate: input.toDate } });
  });
}

async function statementLines(deps: Deps, ctx: AuthContext, accountId: string, params: Params): Promise<{ account: { name: string; nameAr: string; maskedNumber: string; currency: string }; lines: StatementLine[] }> {
  const lines: StatementLine[] = [];
  let cursor: string | undefined;
  let account = { name: "", nameAr: "", maskedNumber: "", currency: "LYD" };
  do {
    const page = await getStatement(deps, ctx, accountId, { fromDate: params.fromDate, toDate: params.toDate, view: "all", limit: 100, ...(cursor ? { cursor } : {}) });
    account = page.account;
    lines.push(...page.lines);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && lines.length < MAX_LINES);
  return { account, lines };
}

async function allDeposits(deps: Deps, ctx: AuthContext, accountIds: readonly string[], params: Params): Promise<DepositView[]> {
  const out: DepositView[] = [];
  let cursor: string | undefined;
  do {
    const page = await listDeposits(deps, ctx, { fromDate: params.fromDate, toDate: params.toDate, limit: 100, ...(params.customerId ? { customerId: params.customerId } : {}), ...(cursor ? { cursor } : {}) });
    out.push(...page.items.filter((deposit) => accountIds.includes(deposit.creditAccount.id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && out.length < MAX_LINES);
  return out;
}

async function build(deps: Deps, ctx: AuthContext, report: Report): Promise<{ bytes: Uint8Array; rows: number }> {
  const params = report.params as Params;
  const locale = report.locale === "ar" ? "ar" : "en";
  const labels = MESSAGES[locale].reports.file;
  if (report.type === "DEPOSIT_SUMMARY") {
    const deposits = await allDeposits(deps, ctx, report.accountIds, params);
    const rows = deposits.map((deposit) => [deposit.intakeReference, deposit.createdAt.slice(0, 10), deposit.customer.code, deposit.customer.displayName, deposit.method, formatMinor(BigInt(deposit.amount.minor), deposit.amount.currency as Currency), deposit.amount.currency, deposit.state, deposit.businessDate ?? "", deposit.creditAccount.maskedNumber]);
    return { bytes: toCsv(["deposit_reference", "received_on", "customer_code", "customer_name", "method", "amount", "currency", "status", "posted_business_date", "account"], rows), rows: rows.length };
  }
  const sections = [];
  for (const accountId of report.accountIds) sections.push(await statementLines(deps, ctx, accountId, params));
  const count = sections.reduce((sum, section) => sum + section.lines.length, 0);
  const signed = (line: StatementLine) => `${line.amount.direction === "DEBIT" ? "-" : ""}${formatMinor(BigInt(line.amount.minor), line.amount.currency as Currency)}`;
  const kindLabel = (line: StatementLine) => labels.kinds[line.kind];
  if (report.format === "CSV") {
    const rows = sections.flatMap((section) => section.lines.map((line) => [section.account.maskedNumber, line.businessDate, line.kind, line.description, line.reference ?? line.groupRef ?? "", signed(line), line.amount.currency, line.itemCount]));
    return { bytes: toCsv(["account", "business_date", "kind", "description", "reference", "amount", "currency", "items"], rows), rows: count };
  }
  const pdf = new PdfBuilder({
    locale,
    title: labels.statementTitle,
    subtitle: `${params.fromDate} — ${params.toDate}`,
    simulatedStamp: MESSAGES[locale].common.sandbox.simulatedStamp,
    meta: [labels.generated.replace("{time}", deps.clock.now().toISOString())],
    footer: labels.footer,
  });
  for (const section of sections) {
    pdf.heading(`${locale === "ar" ? section.account.nameAr : section.account.name} · ${section.account.maskedNumber}`);
    if (section.lines.length === 0) pdf.text(labels.noLines);
    else {
      pdf.table(
        [
          { header: labels.date, width: 70, mono: true },
          { header: labels.kind, width: 90 },
          { header: labels.description, width: 215 },
          { header: labels.amount, width: 100, align: "end", mono: true },
        ],
        section.lines.map((line) => [line.businessDate, kindLabel(line), line.reference ? `${line.description} ${line.reference}` : line.description, `${signed(line)} ${line.amount.currency}`]),
      );
    }
    pdf.gap();
  }
  return { bytes: await pdf.finish(), rows: count };
}

/** Worker step: generate with the requester's CURRENT rights, or fail without a file. */
export async function generateReport(deps: Deps, reportId: string): Promise<void> {
  const report = await deps.db.report.findUnique({ where: { id: reportId } });
  if (!report || report.state !== "PENDING") return;
  const fail = (failureCode: string) => deps.db.report.updateMany({ where: { id: reportId, state: "PENDING" }, data: { state: "FAILED", failureCode } });
  const ctx = await currentContextOf(deps, report.requestedByMembershipId, `report_${reportId}`);
  if (!ctx || ctx.corporateId !== report.corporateId) {
    await fail("PERMISSION_DENIED");
    return;
  }
  try {
    requireReportRights(requireCorporate(ctx), report.type, report.accountIds);
  } catch {
    await fail("PERMISSION_DENIED");
    return;
  }
  let built;
  try {
    built = await build(deps, ctx, report);
  } catch (error) {
    if (error instanceof DomainError && error.code === "ADAPTER_UNAVAILABLE") throw error; // retried by the job runner
    await fail(error instanceof DomainError ? error.code : "INTERNAL_ERROR");
    return;
  }
  const extension = report.format === "PDF" ? "pdf" : "csv";
  const stored = await putPrivateFile(deps.storagePath, "reports", report.id, extension, built.bytes);
  const params = report.params as Params;
  const fileName = `${report.type === "STATEMENT" ? "statement" : "deposit-summary"}-${params.fromDate}-${params.toDate}`;
  await deps.db.report.updateMany({ where: { id: reportId, state: "PENDING" }, data: { state: "READY", storageKey: stored.key, checksum: sha256Hex(built.bytes), sizeBytes: built.bytes.byteLength, fileName, rowCount: built.rows } });
}

export async function listReports(deps: Deps, ctx: AuthContext): Promise<ReportView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "reports.request");
  const person = requirePerson(corporateCtx);
  // A person sees the reports they asked for in this workspace.
  const rows = await deps.db.report.findMany({ where: { corporateId: corporateCtx.corporateId, requestedByPersonId: person.personId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
  return toViews(deps, rows, deps.clock.now());
}

async function loadOwn(deps: Deps, ctx: AuthContext, reportId: string): Promise<{ report: Report; corporateCtx: CorporateContext }> {
  const corporateCtx = requireCorporate(ctx);
  const person = requirePerson(corporateCtx);
  const report = await deps.db.report.findFirst({ where: { id: reportId, corporateId: corporateCtx.corporateId, requestedByPersonId: person.personId } });
  if (!report) throw notFound();
  return { report, corporateCtx };
}

export async function getReport(deps: Deps, ctx: AuthContext, reportId: string): Promise<ReportView> {
  const { report, corporateCtx } = await loadOwn(deps, ctx, reportId);
  requirePermission(corporateCtx, "reports.request");
  return (await toViews(deps, [report], deps.clock.now()))[0] as ReportView;
}

/** Download with the caller's rights as they are NOW (I-42). */
export async function downloadReport(deps: Deps, ctx: AuthContext, reportId: string): Promise<Response> {
  const { report, corporateCtx } = await loadOwn(deps, ctx, reportId);
  requireReportRights(corporateCtx, report.type, report.accountIds);
  if (report.state !== "READY" || !report.storageKey) throw conflict("This report is not ready.");
  if (report.expiresAt.getTime() <= deps.clock.now().getTime()) throw new DomainError("RESOURCE_NOT_FOUND", { detail: "This report has expired. Request it again." });
  const bytes = await readPrivateFile(deps.storagePath, report.storageKey);
  await writeAudit(deps.db, corporateCtx, { action: "report.downloaded", targetType: "report", targetId: report.id, changes: { type: report.type, format: report.format, rows: report.rowCount ?? 0 } });
  return downloadResponse(bytes, report.format === "PDF" ? "pdf" : "csv", report.fileName ?? "report");
}
