/**
 * Server-rendered views shared by bulk transfers (/batches) and payroll runs (/payroll).
 *
 * The pages call the same domain read models as the API, so what a person sees here is exactly
 * the projection their permissions allow: an aggregate reader of a payroll run gets a masked
 * shell per line and no employee detail anywhere in the HTML (SEC-04).
 */
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Badge, Callout, Card, CardHeader, Code, DataList, DetailList, EmptyState, LinkButton, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { Forbidden, LoadError } from "@/features/common/states";
import { Timeline } from "@/features/common/timeline";
import type { Locale } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { rightsFor, type AuthContext } from "@/server/auth/context";
import type { Deps } from "@/server/deps";
import { listAccounts } from "@/server/domain/accounts/service";
import { getBatch, listBatchRows, listBatches, type BatchRowView, type BatchView } from "@/server/domain/batches/views";
import { can, load } from "@/server/page";
import { AcceptRowsForm, AutoRefresh, BatchActions, BatchUploadForm } from "./client/batch-forms";

type Kind = "BULK" | "PAYROLL";
type PageProps = { kind: Kind; deps: Deps; ctx: AuthContext; locale: Locale };
/** Codes that come from the server are looked up loosely; static keys stay type-checked. */
type Translator = ((key: string, values?: Record<string, string | number>) => string) & { has: (key: string) => boolean };
const loose = (t: unknown) => t as Translator;

const base = (kind: Kind) => (kind === "PAYROLL" ? "/payroll" : "/batches");
const ns = (kind: Kind) => (kind === "PAYROLL" ? "payroll" : "bulk");
const canRead = (ctx: AuthContext, kind: Kind) => (kind === "PAYROLL" ? can(ctx, "payroll.aggregate.read") || can(ctx, "payroll.detail") : can(ctx, "batches.read") || can(ctx, "batches.create"));
const canCreate = (ctx: AuthContext, kind: Kind) => can(ctx, kind === "PAYROLL" ? "payroll.detail" : "batches.create");
const ROW_FILTERS = ["ALL", "VALID", "INVALID", "ACCEPTED", "FAILED", "UNKNOWN"] as const;

export async function BatchListView({ kind, deps, ctx, locale, cursor }: PageProps & { cursor?: string | undefined }) {
  const t = await getTranslations({ locale });
  if (!canRead(ctx, kind)) return <Forbidden />;
  const result = await load(() => listBatches(deps, ctx, { kind, ...(cursor ? { cursor } : {}), limit: 25 }));
  const mayCreate = canCreate(ctx, kind);
  const columns: Column<BatchView>[] = [
    {
      key: "reference",
      header: t("batches.list.reference"),
      primary: true,
      cell: (batch) => (
        <Link href={`${base(kind)}/${batch.id}`} className="text-accent hover:underline" data-testid="batch-link">
          <Code>{batch.reference}</Code>
        </Link>
      ),
    },
    kind === "PAYROLL" ? { key: "period", header: t("batches.list.period"), cell: (batch) => (batch.payPeriod ? <Code>{batch.payPeriod}</Code> : "—") } : { key: "file", header: t("batches.list.file"), cell: (batch) => <bdi>{batch.file.name}</bdi> },
    { key: "state", header: t("batches.list.state"), cell: (batch) => <StatusBadge family="batch" state={batch.state} /> },
    { key: "rows", header: t("batches.list.rows"), numeric: true, cell: (batch) => t("batches.list.rowsValue", { accepted: batch.counts.accepted, total: batch.counts.total }) },
    { key: "amount", header: t("batches.list.amount"), numeric: true, cell: (batch) => (batch.accepted ? <Money value={batch.accepted.amount} /> : "—") },
    { key: "created", header: t("batches.list.created"), cell: (batch) => <time dateTime={batch.createdAt}>{formatDateTime(batch.createdAt, locale, deps.timeZone)}</time> },
  ];

  return (
    <>
      <PageHeader
        title={t(`batches.${ns(kind)}.title`)}
        description={t(`batches.${ns(kind)}.description`)}
        actions={
          <span className="flex flex-wrap gap-2">
            {kind === "PAYROLL" && can(ctx, "payroll.detail") ? (
              <LinkButton href="/payroll/employees" variant="secondary" data-testid="employees-link">
                {t("batches.payroll.employees")}
              </LinkButton>
            ) : null}
            {mayCreate ? (
              <LinkButton href={`${base(kind)}/new`} data-testid="new-batch">
                {t(`batches.${ns(kind)}.new`)}
              </LinkButton>
            ) : null}
          </span>
        }
      />
      {kind === "PAYROLL" && !can(ctx, "payroll.detail") ? (
        <div className="mb-4">
          <Callout tone="info" testId="aggregate-only">
            {t("batches.payroll.aggregateOnly")}
          </Callout>
        </div>
      ) : null}
      <Card>
        {!result.ok ? (
          <div className="p-4">
            <LoadError code={result.code} />
          </div>
        ) : (
          <>
            <DataList
              rows={result.data.items}
              columns={columns}
              rowKey={(batch) => batch.id}
              caption={t("batches.list.caption")}
              empty={<EmptyState title={t(`batches.${ns(kind)}.empty`)} description={mayCreate ? t(`batches.${ns(kind)}.emptyHint`) : undefined} />}
            />
            {result.data.nextCursor ? (
              <div className="border-t border-border p-4 text-center">
                <LinkButton href={`${base(kind)}?cursor=${result.data.nextCursor}`} variant="secondary">
                  {t("common.actions.loadMore")}
                </LinkButton>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}

export async function BatchUploadView({ kind, deps, ctx, locale }: PageProps) {
  const t = await getTranslations({ locale });
  if (!canCreate(ctx, kind)) return <Forbidden />;
  const accounts = await load(() => listAccounts(deps, ctx, { withBalances: false }));
  if (!accounts.ok) return <LoadError code={accounts.code} />;
  const payable = accounts.data.filter((account) => rightsFor(ctx, account.id).debit).map((account) => ({ id: account.id, label: `${locale === "ar" ? account.nameAr : account.name} · ${account.maskedNumber}` }));
  return (
    <>
      <PageHeader
        title={t(`batches.${ns(kind)}.uploadTitle`)}
        description={t(`batches.${ns(kind)}.uploadDescription`)}
        back={
          <Link href={base(kind)} className="text-accent hover:underline">
            ← {t(`batches.${ns(kind)}.title`)}
          </Link>
        }
      />
      <Card>
        <div className="p-4 sm:p-5">
          {payable.length === 0 ? <Callout tone="warning">{t("batches.upload.noAccounts")}</Callout> : <BatchUploadForm kind={kind} accounts={payable} basePath={base(kind)} />}
        </div>
      </Card>
    </>
  );
}

function problems(t: Translator, row: { errors: Array<{ code: string; field: string }>; warnings: Array<{ code: string; field: string }> }): ReactNode {
  if (row.errors.length === 0 && row.warnings.length === 0) return "—";
  const label = (group: "rowError" | "rowWarning", issue: { code: string; field: string }) => {
    const key = `batches.${group}.${issue.code}`;
    const field = `batches.field.${issue.field}`;
    return `${t.has(field) ? t(field) : t("batches.field.other")}: ${t.has(key) ? t(key) : t("batches.rowError.OTHER")}`;
  };
  return (
    <ul className="flex flex-col gap-1 text-start">
      {row.errors.map((issue, index) => (
        <li key={`e${index}`} className="text-danger" data-problem={issue.code}>
          {label("rowError", issue)}
        </li>
      ))}
      {row.warnings.map((issue, index) => (
        <li key={`w${index}`} className="text-warning" data-warning={issue.code}>
          {label("rowWarning", issue)}
        </li>
      ))}
    </ul>
  );
}

function rowColumns(t: Translator, projection: BatchRowView["projection"], currency: string): Column<BatchRowView>[] {
  const failure = (row: BatchRowView) => {
    if (row.projection === "PAYROLL_MASKED" || !row.failureCode) return null;
    const key = `types.failure.${row.failureCode}`;
    return <span className="block text-sm text-danger">{t.has(key) ? t(key) : t("types.failure.OTHER")}</span>;
  };
  const state: Column<BatchRowView>[] = [
    { key: "validation", header: t("batches.rows.validation"), cell: (row) => <StatusBadge family="validation" state={row.validationState} /> },
    {
      key: "execution",
      header: t("batches.rows.execution"),
      cell: (row) =>
        row.accepted || row.executionState !== "NONE" ? (
          <span data-row-state={row.executionState}>
            <StatusBadge family="row" state={row.executionState} />
            {failure(row)}
          </span>
        ) : (
          "—"
        ),
    },
  ];
  if (projection === "PAYROLL_MASKED") {
    return [{ key: "line", header: t("batches.rows.masked"), primary: true, cell: (row) => <Code>{row.projection === "PAYROLL_MASKED" ? row.maskedReference : ""}</Code> }, ...state];
  }
  const line: Column<BatchRowView> = {
    key: "line",
    header: t("batches.rows.line"),
    primary: true,
    cell: (row) => (
      <span>
        {t("batches.rows.lineNo", { line: row.lineNumber })}
        {row.projection !== "PAYROLL_MASKED" && row.rowReference ? (
          <>
            {" · "}
            <Code>{row.rowReference}</Code>
          </>
        ) : null}
      </span>
    ),
  };
  const issues: Column<BatchRowView> = { key: "problems", header: t("batches.rows.problems"), cell: (row) => (row.projection === "PAYROLL_MASKED" ? "—" : problems(t, row)) };
  if (projection === "BULK") {
    return [
      line,
      { key: "beneficiary", header: t("batches.rows.beneficiary"), cell: (row) => (row.projection === "BULK" && row.beneficiaryName ? <bdi>{row.beneficiaryName}</bdi> : "—") },
      { key: "account", header: t("batches.rows.account"), cell: (row) => (row.projection === "BULK" && row.maskedAccount ? <Code>{row.maskedAccount}</Code> : "—") },
      { key: "amount", header: t("batches.rows.amount"), numeric: true, cell: (row) => (row.projection === "BULK" && row.amount ? <Money value={row.amount} /> : "—") },
      ...state,
      issues,
    ];
  }
  const money = (minor: string | null | undefined) => (minor ? <Money value={{ currency, minor }} /> : "—");
  return [
    line,
    {
      key: "employee",
      header: t("batches.rows.employee"),
      cell: (row) =>
        row.projection === "PAYROLL_DETAIL" && row.detail ? (
          <span>
            <Code>{row.detail.employeeCode}</Code>
            {row.detail.employeeName ? <bdi className="block">{row.detail.employeeName}</bdi> : null}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "component",
      header: t("batches.rows.component"),
      cell: (row) => {
        const component = row.projection === "PAYROLL_DETAIL" ? row.detail?.component : null;
        return component ? t(`batches.component.${component}`) : "—";
      },
    },
    { key: "net", header: t("batches.rows.net"), numeric: true, cell: (row) => money(row.projection === "PAYROLL_DETAIL" ? row.detail?.netMinor : null) },
    { key: "previous", header: t("batches.rows.previousNet"), numeric: true, cell: (row) => money(row.projection === "PAYROLL_DETAIL" && row.detail?.changeFlag ? row.detail.previousNetMinor : null) },
    ...state,
    issues,
  ];
}

export async function BatchDetailView({ kind, deps, ctx, locale, id, rowFilter }: PageProps & { id: string; rowFilter?: string | undefined }) {
  const t = await getTranslations({ locale });
  if (!canRead(ctx, kind)) return <Forbidden />;
  const result = await load(() => getBatch(deps, ctx, id));
  if (!result.ok) return <LoadError code={result.code} />;
  const batch = result.data;
  // A bulk batch is not shown under /payroll and the other way round.
  if (batch.kind !== kind) return <LoadError code="RESOURCE_NOT_FOUND" />;

  const filter = ROW_FILTERS.find((entry) => entry === rowFilter) ?? "ALL";
  const rows = batch.state === "VALIDATING" ? null : await load(() => listBatchRows(deps, ctx, id, { filter, limit: 200 }));
  // Rows the owner may leave out: only while the batch can still be (re)confirmed.
  const valid = batch.actions.accept ? await load(() => listBatchRows(deps, ctx, id, { filter: "VALID", limit: 200 })) : null;
  const approval = batch.approval;
  const notValid = batch.counts.invalid + batch.counts.duplicate;
  const transient = batch.state === "VALIDATING" || batch.state === "PROCESSING" || (batch.state === "APPROVED" && batch.releaseBlockCode === null);
  const tl = loose(t);
  const blockKey = batch.releaseBlockCode ? `errors.${batch.releaseBlockCode}` : null;
  const blockFallback = batch.releaseBlockCode ? `types.failure.${batch.releaseBlockCode}` : null;
  const validationKey = batch.validationErrorCode ? `errors.${batch.validationErrorCode}` : null;
  const hasAction = batch.actions.accept || batch.actions.submit || batch.actions.cancel || batch.actions.retry || batch.actions.retryRelease;
  const acceptLabel = (row: BatchRowView): string => {
    const line = t("batches.rows.lineNo", { line: row.lineNumber });
    if (row.projection === "BULK") return `${line} · ${row.rowReference ?? ""} · ${row.beneficiaryName ?? ""}`;
    if (row.projection === "PAYROLL_DETAIL") return `${line} · ${row.detail?.employeeCode ?? ""} · ${row.detail?.employeeName ?? ""}`;
    return line;
  };
  const acceptForm = (items: BatchRowView[]) => (
    <AcceptRowsForm
      batchId={batch.id}
      version={batch.version}
      validationVersion={batch.validationVersion}
      rows={items.map((row) => ({ id: row.id, line: row.lineNumber, label: acceptLabel(row), warning: row.projection !== "PAYROLL_MASKED" && row.warnings.length > 0 }))}
      notValid={notValid}
      revising={batch.state !== "READY"}
    />
  );

  return (
    <>
      {transient ? <AutoRefresh /> : null}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {t(`batches.${ns(kind)}.detailTitle`)} <Code>{batch.reference}</Code>
            </span>
            <StatusBadge family="batch" state={batch.state} />
          </span>
        }
        back={
          <Link href={base(kind)} className="text-accent hover:underline">
            ← {t(`batches.${ns(kind)}.title`)}
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        {batch.state === "VALIDATING" ? (
          <Callout tone="info" role="status" testId="batch-validating">
            {t("batches.detail.validating")}
          </Callout>
        ) : null}
        {batch.state === "PROCESSING" ? (
          <Callout tone="info" role="status">
            {t("batches.detail.processing")}
          </Callout>
        ) : null}
        {batch.validationErrorCode ? (
          <Callout tone="danger" role="alert" title={t("batches.detail.validationFailed")} testId="batch-validation-failed">
            <span data-code={batch.validationErrorCode}>
              {batch.validationErrorCode === "NO_VALID_ROWS" ? t("batches.detail.validationCode.NO_VALID_ROWS") : validationKey && tl.has(validationKey) ? tl(validationKey) : t("batches.detail.validationCode.OTHER")}
            </span>
          </Callout>
        ) : null}
        {batch.releaseBlockCode ? (
          <Callout tone="warning" role="alert" title={t("batches.detail.blockedTitle")} testId="batch-blocked">
            <p data-code={batch.releaseBlockCode}>{blockKey && tl.has(blockKey) ? tl(blockKey) : blockFallback && tl.has(blockFallback) ? tl(blockFallback) : t("types.failure.OTHER")}</p>
            <p className="mt-1">{t("batches.detail.blockedBody")}</p>
          </Callout>
        ) : null}
        {batch.outcome && batch.outcome.unknown > 0 ? (
          <Callout tone="warning" role="alert" title={t("batches.detail.unknownTitle")} testId="batch-unknown">
            {t("batches.detail.unknownBody")}
          </Callout>
        ) : null}
        {batch.identicalTo ? (
          <Callout tone="warning" testId="batch-identical">
            {t("batches.detail.identical", { reference: batch.identicalTo.reference })}{" "}
            <Link href={`${base(kind)}/${batch.identicalTo.id}`} className="text-accent underline">
              {t("common.actions.view")}
            </Link>
          </Callout>
        ) : null}
        {batch.parent ? (
          <Callout tone="info">
            {t("batches.detail.parent", { reference: batch.parent.reference })}{" "}
            <Link href={`${base(kind)}/${batch.parent.id}`} className="text-accent underline">
              {t("common.actions.view")}
            </Link>
          </Callout>
        ) : null}
        {kind === "PAYROLL" && !batch.actions.detail ? (
          <Callout tone="info" testId="aggregate-only">
            {t("batches.payroll.aggregateOnly")}
          </Callout>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t("batches.detail.summary")} />
            <div className="p-4 sm:p-5">
              <DetailList
                items={[
                  { label: t("batches.detail.file"), value: <bdi>{batch.file.name}</bdi>, wide: true },
                  { label: t("batches.detail.sourceAccount"), value: <span>{locale === "ar" ? batch.sourceAccount.nameAr : batch.sourceAccount.name} · <Code>{batch.sourceAccount.maskedNumber}</Code></span> },
                  { label: t("batches.detail.rail"), value: batch.rail === "ACH" ? t("batches.upload.railACH") : t("batches.upload.railLYPAY") },
                  { label: t("batches.detail.when"), value: batch.executeAt ? <time dateTime={batch.executeAt}>{formatDateTime(batch.executeAt, locale, deps.timeZone)}</time> : t("batches.detail.immediately") },
                  ...(batch.payPeriod ? [{ label: t("batches.detail.payPeriod"), value: <Code>{batch.payPeriod}</Code> }] : []),
                  ...(batch.isCorrection ? [{ label: t("batches.detail.correctionRun"), value: <Badge tone="warning">{t("batches.approval.yes")}</Badge> }] : []),
                  { label: t("batches.detail.maker"), value: batch.maker.name },
                  { label: t("batches.detail.created"), value: <time dateTime={batch.createdAt}>{formatDateTime(batch.createdAt, locale, deps.timeZone)}</time> },
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("batches.detail.counts")} />
            <div className="p-4 sm:p-5" data-testid="batch-counts">
              <DetailList
                items={[
                  { label: t("batches.detail.total"), value: batch.counts.total, testId: "count-total" },
                  { label: t("batches.detail.valid"), value: batch.counts.valid, testId: "count-valid" },
                  { label: t("batches.detail.invalid"), value: batch.counts.invalid, testId: "count-invalid" },
                  { label: t("batches.detail.duplicate"), value: batch.counts.duplicate, testId: "count-duplicate" },
                  ...(batch.counts.warnings > 0 ? [{ label: t("batches.detail.warnings"), value: batch.counts.warnings, testId: "count-warnings" }] : []),
                  { label: t("batches.detail.accepted"), value: batch.accepted ? batch.counts.accepted : t("batches.detail.notConfirmed"), testId: "count-accepted" },
                  ...(batch.accepted
                    ? [
                        { label: t("batches.detail.acceptedAmount"), value: <Money value={batch.accepted.amount} />, testId: "accepted-amount" },
                        { label: t("batches.detail.fees"), value: <Money value={batch.accepted.fee} />, testId: "accepted-fee" },
                        { label: t("batches.detail.totalDebit"), value: <Money value={batch.accepted.totalDebit} className="font-semibold" />, testId: "accepted-total" },
                      ]
                    : []),
                ]}
              />
            </div>
          </Card>
        </div>

        {batch.outcome ? (
          <Card>
            <CardHeader title={t("batches.detail.outcome")} />
            <div className="p-4 sm:p-5" data-testid="batch-outcome">
              <DetailList
                items={[
                  { label: t("batches.detail.settled"), value: batch.outcome.settled, testId: "outcome-settled" },
                  { label: t("batches.detail.failed"), value: batch.outcome.failed, testId: "outcome-failed" },
                  { label: t("batches.detail.unknown"), value: batch.outcome.unknown, testId: "outcome-unknown" },
                  { label: t("batches.detail.returned"), value: batch.outcome.returned },
                  { label: t("batches.detail.inFlight"), value: batch.outcome.inFlight, testId: "outcome-inflight" },
                  { label: t("batches.detail.settledAmount"), value: <Money value={batch.outcome.settledAmount} className="font-semibold" />, testId: "outcome-amount" },
                ]}
              />
            </div>
          </Card>
        ) : null}

        {hasAction ? (
          <Card>
            <CardHeader title={t("batches.detail.actions")} />
            <div className="flex flex-col gap-5 p-4 sm:p-5">
              {batch.actions.accept && valid?.ok && !batch.accepted ? acceptForm(valid.data.items) : null}
              <BatchActions batchId={batch.id} version={batch.version} basePath={base(kind)} actions={batch.actions} />
              {batch.actions.accept && valid?.ok && batch.accepted ? (
                <details className="rounded-lg border border-border">
                  <summary className="min-h-11 cursor-pointer px-3 py-2.5 font-semibold" data-testid="change-rows">
                    {t("batches.accept.change")}
                  </summary>
                  <div className="border-t border-border p-3">{acceptForm(valid.data.items)}</div>
                </details>
              ) : null}
            </div>
          </Card>
        ) : null}

        {approval ? (
          <Card>
            <CardHeader
              title={t("batches.detail.approval")}
              description={t("batches.detail.approvalsCount", { count: approval.approvalsCount, required: approval.requiredApprovals })}
              action={
                <LinkButton href={`/approvals/${approval.id}`} variant={approval.canAct ? "primary" : "secondary"} data-testid="review-approval">
                  {approval.canAct ? t("batches.detail.review") : t("batches.detail.viewApproval")}
                </LinkButton>
              }
            />
          </Card>
        ) : null}

        {batch.actions.detail && (notValid > 0 || batch.outcome) ? (
          <Card>
            <CardHeader title={t("batches.detail.downloads")} />
            <p className="flex flex-wrap gap-x-5 gap-y-2 p-4 sm:p-5">
              {notValid > 0 ? (
                <a className="text-accent underline" href={`/api/v1/batches/${batch.id}/errors`} download data-testid="download-errors">
                  {t("batches.detail.errorsFile")}
                </a>
              ) : null}
              {batch.outcome ? (
                <a className="text-accent underline" href={`/api/v1/batches/${batch.id}/result`} download data-testid="download-result">
                  {t("batches.detail.resultFile")}
                </a>
              ) : null}
            </p>
          </Card>
        ) : null}

        {rows ? (
          <Card>
            <CardHeader title={t("batches.rows.title")} description={rows.ok && rows.data.projection === "PAYROLL_MASKED" ? t("batches.rows.maskedHelp") : undefined} />
            <nav className="flex flex-wrap gap-2 border-b border-border px-4 py-3 sm:px-5" aria-label={t("batches.rows.title")}>
              {ROW_FILTERS.map((entry) => (
                <Link
                  key={entry}
                  href={`${base(kind)}/${batch.id}?rows=${entry}`}
                  aria-current={entry === filter ? "page" : undefined}
                  className={`min-touch inline-flex items-center rounded-full border px-3 text-sm ${entry === filter ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border text-ink"}`}
                  data-testid={`rows-${entry}`}
                >
                  {t(`batches.rows.filter.${entry}`)}
                </Link>
              ))}
            </nav>
            {!rows.ok ? (
              <div className="p-4">
                <LoadError code={rows.code} />
              </div>
            ) : (
              <div data-testid="batch-rows" data-projection={rows.data.projection}>
                <DataList
                  rows={rows.data.items}
                  columns={rowColumns(loose(t), rows.data.projection, batch.currency)}
                  rowKey={(row) => row.id}
                  caption={t("batches.rows.title")}
                  empty={<EmptyState title={t("batches.rows.empty")} />}
                />
                {rows.data.nextCursor ? <p className="border-t border-border p-4 text-sm text-muted">{t("batches.rows.more", { count: rows.data.items.length })}</p> : null}
              </div>
            )}
          </Card>
        ) : null}

        {batch.retries.length > 0 ? (
          <Card>
            <CardHeader title={t("batches.detail.retries")} />
            <ul className="flex flex-col gap-2 p-4 sm:p-5">
              {batch.retries.map((retry) => (
                <li key={retry.id} className="flex flex-wrap items-center gap-3">
                  <Link href={`${base(kind)}/${retry.id}`} className="text-accent hover:underline" data-testid="retry-link">
                    <Code>{retry.reference}</Code>
                  </Link>
                  <StatusBadge family="batch" state={retry.state} />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card>
          <CardHeader title={t("common.labels.timeline")} />
          <div className="p-4 sm:p-5">
            <Timeline entries={batch.timeline.map((entry) => ({ ...entry, reference: null, detail: null }))} timeZone={deps.timeZone} />
          </div>
        </Card>
      </div>
    </>
  );
}
