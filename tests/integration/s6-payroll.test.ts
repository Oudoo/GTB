/**
 * S6 payroll (PYR-01, PYR-02, SEC-04; I-29, I-30, I-51): the officer sees employee detail; a
 * checker approves the aggregate without ever receiving a name, an account or a salary through
 * JSON, downloads, statements, audit, notifications, events or logs — nor does an API token, a
 * report file, a statement PDF or a webhook subscriber.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatMinor } from "@/contracts/money";
import { businessDateOf } from "@/lib/calendar";
import type { WebhookRequest, WebhookResponse, WebhookTransport } from "@/server/adapters/webhooks/transport";
import { PdfBuilder } from "@/server/files/pdf";
import { setLogSinkForTests } from "@/server/logging";
import { ACCOUNTS, CORPORATES, EMPLOYEES_A, NEW_STAFF_A } from "@/server/seed/fixtures";
import { accept, acceptSubmitApprove, employeesFile, getBatch, netMinorOf, payRow, payrollFile, rowsOf, submit, upload, uploadAndValidate, type BatchData, type PayRow } from "./support/batches";
import { approve, coreBalance } from "./support/payments";
import { pdfText } from "./support/pdf-text";
import { Actor, createWorld, type World } from "./support/world";

const PAYROLL = ACCOUNTS.A_PAYROLL;
const FEE = 100n; // LYD 0.100 per line (module 2.2 tariff of the demo agreement)
const NON_OFFICERS = ["aChecker1", "aChecker2", "aFinance", "aViewer", "aAdmin", "aMaker", "aTreasurer"] as const;

type Employee = { id: string; employeeCode: string; name: string; accountReference: string; accountMatchStatus: string; active: boolean; payable: boolean; version: number };
type ImportView = { id: string; state: string; totalRows: number; validRows: number; invalidRows: number; acceptedHash: string; version: number; rows: Array<{ line: number; employeeCode: string; state: string; action: string | null; errors: Array<{ code: string }> }> };

async function drainAll(world: World): Promise<void> {
  while ((await world.drain(2_000)) > 0) {
    /* until no job is due */
  }
}

/** Run the worker, let the synthetic ACH rail settle, and run it again. */
async function settle(world: World): Promise<void> {
  await drainAll(world);
  world.clock.advanceMs(6 * 60_000);
  await drainAll(world);
}

/** Everything about an employee or a line that only a payroll officer may ever receive. */
function secretsOf(rows: readonly PayRow[]): string[] {
  const secrets = new Set<string>();
  for (const row of rows) {
    const employee = [...EMPLOYEES_A, ...NEW_STAFF_A].find((entry) => entry.code === row.employee_code);
    if (employee) {
      secrets.add(employee.name);
      secrets.add(employee.reference);
    }
    secrets.add(row.employee_code);
    secrets.add(row.row_reference);
    secrets.add(row.payslip_reference);
    if (row.basic !== "0.000") secrets.add(row.basic);
    const net = netMinorOf(row);
    if (net > 0n) {
      secrets.add(net.toString());
      secrets.add(formatMinor(net, "LYD"));
    }
  }
  return [...secrets];
}

/** A subscriber's endpoint: keeps every request the application actually sent. */
class Subscriber implements WebhookTransport {
  readonly received: WebhookRequest[] = [];
  async send(request: WebhookRequest): Promise<WebhookResponse> {
    this.received.push(request);
    return { status: 204, snippet: "" };
  }
}

/**
 * The same check for a PDF: its text is read back run by run. Words are drawn separately, so a
 * name is looked for word by word ("Demo" and "Staff" alone identify nobody).
 */
function expectNoSecretInPdf(bytes: Uint8Array, secrets: readonly string[], where: string): string[] {
  const { runs } = pdfText(bytes);
  const generic = new Set(["Demo", "Staff"]);
  for (const secret of secrets) {
    for (const word of secret.split(" ").filter((part) => part.length > 0 && !generic.has(part))) {
      const hit = runs.find((run) => run.includes(word));
      if (hit !== undefined) throw new Error(`payroll detail leaked in ${where}: found "${word}" in "${hit}"`);
    }
  }
  return runs;
}

function expectNoSecret(text: string, secrets: readonly string[], where: string): void {
  for (const secret of secrets) {
    if (text.includes(secret)) throw new Error(`payroll detail leaked in ${where}: found "${secret}"`);
  }
}

describe("S6 payroll", () => {
  let world: World;
  const subscriber = new Subscriber();
  const logLines: string[] = [];
  const previousLevel = process.env["LOG_LEVEL"];
  beforeAll(async () => {
    // Capture what the application would really log (the suite is silent by default).
    process.env["LOG_LEVEL"] = "info";
    setLogSinkForTests((line) => logLines.push(line));
    world = await createWorld({ webhooks: { transport: subscriber, resolver: async (host) => (host === "hooks.example.test" ? [{ address: "93.184.216.34", family: 4 }] : []) } });
    await world.activateAgreement("A");
    // An integration subscribed to every event type before any payroll is run.
    const hook = await (await world.as("aAdmin")).post("/developer/webhooks", { url: "https://hooks.example.test/payroll-probe", events: ["payment.status_changed", "batch.finished", "deposit.posted", "limit.threshold_reached"] });
    if (hook.status !== 201) throw new Error(`webhook registration failed: ${hook.status} ${hook.text}`);
  });
  afterAll(async () => {
    await world.close();
    process.env["LOG_LEVEL"] = previousLevel;
    setLogSinkForTests(undefined);
  });

  const november: PayRow[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => payRow(n));
  const allowance = payRow(2, { row_reference: "PAY-2026-11-EMP-002-ALW", component: "ALLOWANCE", basic: "0.000", allowances: "313.131", deductions: "0.000", payslip_reference: "PS-2026-11-EMP-002-ALW" });
  const badRows: PayRow[] = [
    payRow(1, { row_reference: "PAY-2026-11-EMP-001-AGAIN" }),
    { ...payRow(1), row_reference: "PAY-2026-11-GHOST", employee_code: "EMP-999", payslip_reference: "PS-GHOST", basic: "4321.987" },
    payRow(3, { row_reference: "PAY-2026-11-EMP-003-NEG", component: "ALLOWANCE", basic: "-77.123", payslip_reference: "PS-NEG" }),
  ];
  const accepted = [...november, allowance];
  const total = accepted.reduce((sum, row) => sum + netMinorOf(row), 0n);
  let runId = "";
  let runReference = "";
  let approvalId = "";

  it("lets the officer run payroll and a checker approve the aggregate; settled totals match the statement (E-07, PYR-01)", async () => {
    const officer = await world.as("aPayroll");
    const before = await coreBalance(world, PAYROLL.ref);

    const uploaded = await upload(world, "aPayroll", payrollFile([...november, allowance, ...badRows]), { kind: "PAYROLL", fileName: "november-salaries.csv" });
    expect(uploaded.status).toBe(202);
    expect(uploaded.data).toMatchObject({ kind: "PAYROLL", state: "VALIDATING", counts: { total: 12 } });
    expect(uploaded.data.reference).toMatch(/^PYR-[A-Z0-9]+-2026-\d{6}$/);
    runId = uploaded.data.id;
    runReference = uploaded.data.reference;
    await drainAll(world);

    let run = await getBatch(world, runId, "aPayroll");
    expect(run).toMatchObject({ state: "READY", payPeriod: "2026-11", counts: { total: 12, valid: 9, invalid: 2, duplicate: 1, warnings: 0 } });
    expect(run.actions).toMatchObject({ accept: true, detail: true });

    // The officer sees every line in full.
    const detail = await rowsOf(world, runId, "aPayroll");
    expect(detail.projection).toBe("PAYROLL_DETAIL");
    expect(detail.items).toHaveLength(12);
    expect(detail.items[0]?.detail).toMatchObject({ employeeCode: "EMP-001", employeeName: "Demo Staff Amna", netMinor: netMinorOf(november[0] as PayRow).toString(), component: "SALARY", payslipReference: "PS-2026-11-EMP-001" });
    const problems = detail.items.filter((row) => row.validationState !== "VALID").map((row) => [row.lineNumber, row.validationState, row.errors?.[0]?.code]);
    expect(problems).toEqual([
      [11, "DUPLICATE", "DUPLICATE_SALARY"],
      [12, "INVALID", "EMPLOYEE_UNKNOWN"],
      [13, "INVALID", "NEGATIVE_COMPONENT"],
    ]);
    const errorsFile = await officer.get(`/batches/${runId}/errors`);
    expect(errorsFile.status).toBe(200);
    expect(errorsFile.text).toContain("employee_code:EMPLOYEE_UNKNOWN");
    // Problem codes never echo a value from the file, even for the officer.
    expect(errorsFile.text).not.toContain("4321.987");
    expect(errorsFile.text).not.toContain("-77.123");

    const acceptedRun = await accept(world, "aPayroll", run, { confirmExcludeInvalid: true });
    expect(acceptedRun.status).toBe(200);
    run = acceptedRun.data;
    expect(run.counts.accepted).toBe(9);
    expect(run.accepted).toMatchObject({ amount: { minor: total.toString() }, fee: { minor: (9n * FEE).toString() }, totalDebit: { minor: (total + 9n * FEE).toString() } });

    const submitted = await submit(world, "aPayroll", run);
    expect(submitted.status).toBe(202);
    run = submitted.data;
    const approval = run.approval as NonNullable<BatchData["approval"]>;
    approvalId = approval.id;
    expect(approval).toMatchObject({ state: "PENDING", requiredApprovals: 1 });
    expect(approval.summary).toMatchObject({ kind: "PAYROLL", reference: runReference, count: 9, payPeriod: "2026-11", changeFlagCount: 0, amount: { minor: total.toString() }, fee: { minor: "900" } });
    expect(Object.keys(approval.summary).sort()).toEqual(["amount", "changeFlagCount", "count", "executeAt", "fee", "isCorrection", "kind", "linkPath", "payPeriod", "rail", "reference", "sourceAccount", "title", "totalDebit"]);

    // The officer cannot approve; a checker approves the aggregate without detail rights.
    expect([403, 404]).toContain((await approve(world, approvalId, "aPayroll")).status);
    const checkerView = await (await world.as("aChecker1")).get<{ canAct: boolean; summary: Record<string, unknown> }>(`/approvals/${approvalId}`);
    expect(checkerView.status).toBe(200);
    expect(checkerView.data.canAct).toBe(true);
    expect((await approve(world, approvalId, "aChecker1")).status).toBe(200);
    expect((await getBatch(world, runId, "aPayroll")).state).toBe("APPROVED");
    expect(await coreBalance(world, PAYROLL.ref)).toBe(before);

    await drainAll(world);
    // Submitted to the synthetic ACH rail: accepted is not settled.
    expect((await getBatch(world, runId, "aPayroll")).state).toBe("PROCESSING");
    await settle(world);
    run = await getBatch(world, runId, "aPayroll");
    expect(run.state).toBe("COMPLETED");
    expect(run.outcome).toMatchObject({ settled: 9, failed: 0, unknown: 0, settledAmount: { minor: total.toString() } });
    expect(await coreBalance(world, PAYROLL.ref)).toBe(before - total - 9n * FEE);

    // The source-account statement shows ONE consolidated line for the run.
    type Line = { kind: string; description: string; reference: string | null; signedMinor: string; itemCount: number; includedFee: { minor: string } | null; groupRef: string | null };
    const statement = await (await world.as("aFinance")).get<{ lines: Line[] }>(`/accounts/${PAYROLL.id}/statements`);
    expect(statement.status).toBe(200);
    const runLines = statement.data.lines.filter((line) => line.groupRef === runReference);
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toMatchObject({ kind: "PAYROLL_RUN", reference: null, itemCount: 9, signedMinor: `-${total + 9n * FEE}`, includedFee: { minor: "900" } });
    expect(statement.data.lines.filter((line) => line.kind === "PAYMENT" || line.kind === "FEE")).toHaveLength(0);
    // The ledger itself holds one debit per line: the projection groups, it does not net.
    expect(await world.db.businessInstruction.count({ where: { batchId: runId, state: "SETTLED", confidential: true } })).toBe(9);

    // The officer's result file names employees; the read is recorded without its content.
    const result = await officer.get(`/batches/${runId}/result`);
    expect(result.status).toBe(200);
    expect(result.text).toContain("EMP-001");
    expect(result.text.trim().split("\r\n")).toHaveLength(10);
    const sensitive = await world.db.auditEvent.findMany({ where: { targetId: runId, sensitiveRead: true } });
    expect(sensitive.map((event) => event.action)).toEqual(expect.arrayContaining(["payroll.detail.read", "batch.errors.exported", "batch.result.exported"]));
  });

  it("never gives a checker, finance, viewer, administrator, maker, another tenant or the bank any employee detail (I-30, SEC-04, PYR-02)", async () => {
    const secrets = secretsOf([...accepted, ...badRows]);
    expect(secrets.length).toBeGreaterThan(40);

    for (const key of NON_OFFICERS) {
      const actor = await world.as(key);
      const summary = await actor.get<BatchData>(`/batches/${runId}`);
      if (summary.status === 200) {
        expect(summary.data.actions).toMatchObject({ detail: false, accept: false, submit: false, retry: false });
        expectNoSecret(summary.text, secrets, `${key} GET /batches/{id}`);
        // Rows are a masked shell: line, state and nothing else.
        const rows = await actor.get<{ projection: string; items: Array<Record<string, unknown>> }>(`/batches/${runId}/rows?limit=200`);
        expect(rows.status).toBe(200);
        expect(rows.data.projection).toBe("PAYROLL_MASKED");
        for (const row of rows.data.items) expect(Object.keys(row).sort()).toEqual(["accepted", "executionState", "id", "lineNumber", "maskedReference", "projection", "validationState"]);
        expectNoSecret(rows.text, secrets, `${key} GET /batches/{id}/rows`);
        for (const filter of ["VALID", "INVALID", "ACCEPTED", "FAILED"]) expectNoSecret((await actor.get(`/batches/${runId}/rows?filter=${filter}`)).text, secrets, `${key} rows ${filter}`);
      } else {
        expect([403, 404]).toContain(summary.status);
      }
      // Row-level downloads are refused outright, not redacted.
      for (const download of ["errors", "result"]) {
        const response = await actor.get(`/batches/${runId}/${download}`);
        expect([403, 404]).toContain(response.status);
        expectNoSecret(response.text, secrets, `${key} GET /batches/{id}/${download}`);
      }
      // The employee master, its import and the payroll templates are closed to them.
      expect((await actor.get("/payroll/employees")).status).toBe(403);
      expect((await actor.post("/payroll/employees", { employeeCode: "EMP-777", name: "Not Allowed", accountScheme: "DEMO_DOMESTIC", accountReference: "DEMO-LY-910009" })).status).toBe(403);
      expect([403, 404]).toContain((await actor.get("/templates/payroll")).status);
      expect([403, 404]).toContain((await actor.get("/templates/employees")).status);
      // Uploading a payroll file needs the payroll-detail permission.
      expect((await upload(world, key, payrollFile([payRow(1, {}, "2027-01")]), { kind: "PAYROLL", source: "A_PAYROLL" })).status).toBe(403);

      // Every other surface they can reach.
      for (const path of ["/batches", "/batches?kind=PAYROLL", "/approvals", `/approvals/${approvalId}`, "/dashboard", `/accounts/${PAYROLL.id}/statements`, `/accounts/${PAYROLL.id}/statements?view=all&limit=100`, `/accounts/${PAYROLL.id}/balance`, "/audit-events", `/audit-events?q=${runReference}`, "/audit-events?action=batch.", "/payments", "/notifications"]) {
        const response = await actor.get(path);
        expectNoSecret(response.text, secrets, `${key} GET ${path}`);
      }
    }

    // Another corporate and bank staff: the run does not exist for them.
    for (const key of ["bMaker", "bChecker", "bankMaker", "compliance"]) {
      const actor = await world.as(key);
      for (const path of [`/batches/${runId}`, `/batches/${runId}/rows`, `/batches/${runId}/result`, `/approvals/${approvalId}`]) {
        const response = await actor.get(path);
        expect([403, 404]).toContain(response.status);
        expectNoSecret(response.text, secrets, `${key} GET ${path}`);
      }
    }
    // Bank operations see an opaque reference and a state — no amount, no name, no account.
    type Execution = { executionReference: string; instruction: { confidential: boolean; amount: unknown; fee: unknown; destinationName: unknown; destinationMasked: string | null } };
    for (const key of ["ops", "payrollSupport"]) {
      const actor = await world.as(key);
      const list = await actor.get<{ items: Execution[] }>("/bank/operations/executions?category=ALL&limit=100");
      expect(list.status).toBe(200);
      const payrollRows = list.data.items.filter((entry) => entry.instruction.confidential);
      expect(payrollRows.length).toBe(9);
      for (const entry of payrollRows) {
        expect(entry.instruction).toMatchObject({ amount: null, fee: null, destinationName: null });
        // Only the seeded payroll-support role gets a masked account as a diagnostic.
        if (key === "ops") expect(entry.instruction.destinationMasked).toBeNull();
        else expect(entry.instruction.destinationMasked).toMatch(/•/);
      }
      expectNoSecret(list.text, secrets.filter((secret) => !secret.startsWith("DEMO-LY-")), `${key} executions`);
      for (const employee of EMPLOYEES_A) expect(list.text).not.toContain(employee.reference);
      const audit = await actor.get("/bank/audit-events");
      expectNoSecret(audit.text, secrets, `${key} bank audit`);
    }

    // A reconciliation break on a payroll line records THAT it differs, never by how much.
    const ops = await world.as("ops");
    const day = businessDateOf(world.clock.now(), "Africa/Tripoli");
    const [first, second] = await world.db.executionAttempt.findMany({ where: { instruction: { batchId: runId } }, orderBy: { executionReference: "asc" }, take: 2 });
    expect((await ops.post("/bank/simulator/recon-overlays", { businessDate: day, executionReference: first?.executionReference, kind: "AMOUNT_OVERRIDE", amountMinor: "1", reason: "payroll break fixture" })).status).toBe(201);
    expect((await ops.post("/bank/simulator/recon-overlays", { businessDate: day, executionReference: second?.executionReference, kind: "HIDE", reason: "payroll break fixture" })).status).toBe(201);
    const started = await ops.post<{ run: { id: string } }>("/bank/reconciliation-runs", { businessDate: day });
    expect(started.status).toBe(202);
    await drainAll(world);
    const recon = await ops.get<{ run: { state: string; breakCount: number }; breaks: Array<{ kind: string; executionReference: string; expected: Record<string, unknown> | null; actual: Record<string, unknown> | null }> }>(`/bank/reconciliation-runs/${started.data.run.id}`);
    expect(recon.data.run).toMatchObject({ state: "COMPLETED", breakCount: 2 });
    expect(recon.data.breaks.map((entry) => [entry.kind, entry.executionReference, entry.expected])).toEqual(
      expect.arrayContaining([
        ["AMOUNT_MISMATCH", first?.executionReference, { confidential: true, source: "EXECUTION" }],
        ["MISSING_IN_CORE", second?.executionReference, { confidential: true, source: "EXECUTION" }],
      ]),
    );
    expect(recon.data.breaks.find((entry) => entry.kind === "AMOUNT_MISMATCH")?.actual).toEqual({ confidential: true, kind: expect.any(String) });
    expectNoSecret(recon.text, secrets, "reconciliation run");
    expectNoSecret(JSON.stringify(await world.db.reconciliationBreak.findMany()), secrets, "stored reconciliation breaks");

    // Stored side channels: audit, timeline, notifications, outbox events, approval records,
    // idempotency records and job payloads hold aggregates and identifiers only.
    const corporateId = CORPORATES.A.id;
    const stores: Array<[string, unknown]> = [
      ["audit", await world.db.auditEvent.findMany({ where: { corporateId } })],
      ["timeline", await world.db.timelineEvent.findMany({ where: { corporateId } })],
      ["notifications", await world.db.notification.findMany({ where: { corporateId } })],
      ["outbox", await world.db.outboxEvent.findMany({ where: { corporateId } })],
      ["approvals", await world.db.approvalRequest.findMany({ where: { corporateId } })],
      ["idempotency", await world.db.idempotencyRecord.findMany()],
      ["jobs", await world.db.job.findMany({ where: { corporateId } })],
      ["batch", await world.db.batch.findMany({ where: { corporateId } })],
    ];
    const json = (value: unknown) => JSON.stringify(value, (_key, inner) => (typeof inner === "bigint" ? inner.toString() : inner));
    for (const [name, rows] of stores) expectNoSecret(json(rows), secrets.filter((secret) => name !== "batch" || !/^\d+$/.test(secret)), `stored ${name}`);
    // The public row shell of a payroll line holds no booking fact at all.
    const shells = await world.db.batchRow.findMany({ where: { batchId: runId } });
    for (const shell of shells) expect([shell.amountMinor, shell.beneficiaryName, shell.accountReference, shell.purpose]).toEqual([null, null, null, null]);

    // Nothing in the captured application log either (I-51).
    expectNoSecret(logLines.join("\n"), secrets, "application log");
  });

  it("keeps employee detail out of API tokens, report files, statement PDFs and webhook deliveries (PYR-02, SEC-04, API-01, RPT-01, EVT-01)", async () => {
    const secrets = secretsOf([...accepted, ...badRows]);
    const day = businessDateOf(world.clock.now(), "Africa/Tripoli");
    const totalDebit = formatMinor(total + 9n * FEE, "LYD");
    type Line = { kind: string; groupRef: string | null; itemCount: number; signedMinor: string };

    // --- An API token holding every read scope and the payroll account -----------------------
    const admin = await world.as("aAdmin");
    const created = await admin.post<{ token: string }>("/developer/credentials", {
      name: "Payroll leak probe (synthetic)",
      scopes: ["accounts:read", "payments:read", "batches:read", "collections:read", "agreements:read", "webhooks:manage"],
      accountIds: [PAYROLL.id, ACCOUNTS.A_OPERATING.id],
      expiresInDays: 1,
    });
    expect(created.status).toBe(201);
    const token = new Actor(world, "credential");
    token.bearer = created.data.token;
    // Payroll is not part of any token scope: the run, its rows and its files do not exist.
    for (const path of [`/batches/${runId}`, `/batches/${runId}/rows`, `/batches/${runId}/rows?filter=ACCEPTED`, `/batches/${runId}/result`, `/batches/${runId}/errors`, "/batches?kind=PAYROLL", `/approvals/${approvalId}`, "/approvals", "/payroll/employees", "/templates/payroll", "/templates/employees", "/audit-events", "/notifications", "/reports", "/dashboard"]) {
      const response = await token.get(path);
      expect([401, 403, 404], `token GET ${path}`).toContain(response.status);
      expectNoSecret(response.text, secrets, `token GET ${path}`);
    }
    const listed = await token.get<Array<{ kind: string; reference: string }>>("/batches?limit=100");
    expect(listed.status).toBe(200);
    expect(listed.data.filter((batch) => batch.kind === "PAYROLL" || batch.reference === runReference)).toEqual([]);
    expectNoSecret(listed.text, [...secrets, runReference], "token GET /batches");
    // What a token may read of the payroll account is the consolidated line.
    const viaToken = await token.get<{ lines: Line[] }>(`/accounts/${PAYROLL.id}/statements?view=all&limit=100`);
    expect(viaToken.status).toBe(200);
    expect(viaToken.data.lines.filter((line) => line.groupRef === runReference)).toMatchObject([{ kind: "PAYROLL_RUN", itemCount: 9, signedMinor: `-${total + 9n * FEE}` }]);
    expect(viaToken.data.lines.filter((line) => line.kind === "PAYMENT" || line.kind === "FEE")).toHaveLength(0);
    expectNoSecret(viaToken.text, secrets, "token statement");
    for (const path of ["/accounts", `/accounts/${PAYROLL.id}`, `/accounts/${PAYROLL.id}/balance`, "/payments?limit=100", "/beneficiaries", "/limits/usage", "/agreement", "/customers", "/deposits", "/developer/webhooks"]) {
      const response = await token.get(path);
      expect(response.status, `token GET ${path}`).toBe(200);
      expectNoSecret(response.text, secrets, `token GET ${path}`);
    }
    // A token cannot upload payroll, add an employee or vote.
    expect([401, 403, 404]).toContain((await token.post("/payroll/employees", { employeeCode: "EMP-778", name: "Not Allowed", accountScheme: "DEMO_DOMESTIC", accountReference: "DEMO-LY-910010" })).status);
    expect([401, 403, 404]).toContain((await token.post(`/approvals/${approvalId}/approve`, { proposalVersion: 1, proposalHash: "0".repeat(64) }, { ifMatch: 1 })).status);

    // --- Report files of the payroll account --------------------------------------------------
    const finance = await world.as("aFinance");
    const report = async (format: "CSV" | "PDF", locale: "en" | "ar") => {
      const requested = await finance.post<{ id: string }>("/reports", { type: "STATEMENT", format, accountIds: [PAYROLL.id], fromDate: day, toDate: day, locale });
      expect(requested.status).toBe(202);
      await drainAll(world);
      const file = await finance.get(`/reports/${requested.data.id}/download`);
      expect(file.status).toBe(200);
      return file;
    };
    const csv = await report("CSV", "en");
    const csvLines = csv.text.trim().split("\r\n").filter((line) => line.includes(",PAYROLL_RUN,"));
    expect(csvLines).toHaveLength(1);
    expect(csvLines[0]).toContain(runReference);
    expect(csvLines[0]).toContain(`-${totalDebit}`);
    expect(csvLines[0]?.endsWith(",9")).toBe(true);
    expectNoSecret(csv.text, secrets, "statement report CSV");

    const statementLines = (await finance.get<{ lines: Line[] }>(`/accounts/${PAYROLL.id}/statements?view=all&limit=100&fromDate=${day}&toDate=${day}`)).data.lines.length;
    expect(statementLines).toBeGreaterThanOrEqual(1);
    expect(statementLines).toBeLessThan(9);
    for (const locale of ["en", "ar"] as const) {
      const pdf = await report("PDF", locale);
      expect(pdf.headers.get("content-type")).toContain("application/pdf");
      const runs = expectNoSecretInPdf(pdf.bytes, secrets, `statement report PDF (${locale})`);
      // The reader really sees the document: its date, its stamp and the run total are there…
      expect(runs).toContain(day);
      expect(runs.some((run) => run.includes(totalDebit))).toBe(true);
      // …once: the page has as many dated rows as the statement has lines (the period heading
      // prints the date twice), not one per employee.
      expect(runs.filter((run) => run === day)).toHaveLength(2 + statementLines);
    }
    // The reader used above does find a name when one is printed: the officer's own result file
    // is a CSV, so the proof is a document built the same way that does carry one.
    const control = new PdfBuilder({ locale: "ar", title: "control", simulatedStamp: "SIMULATED", meta: [] });
    control.table([{ header: "A", width: 200 }, { header: "B", width: 100, align: "end", mono: true }], [[`${EMPLOYEES_A[0].name} ${EMPLOYEES_A[0].reference}`, `-${formatMinor(netMinorOf(november[0] as PayRow), "LYD")} LYD`]]);
    expect(() => expectNoSecretInPdf(new Uint8Array(0), secrets, "empty")).toThrow(/not a PDF/);
    const controlBytes = await control.finish();
    expect(() => expectNoSecretInPdf(controlBytes, [EMPLOYEES_A[0].name], "control")).toThrow(/found "Amna"/);
    expect(() => expectNoSecretInPdf(controlBytes, [EMPLOYEES_A[0].reference], "control")).toThrow(/DEMO-LY-910001/);
    expect(() => expectNoSecretInPdf(controlBytes, [formatMinor(netMinorOf(november[0] as PayRow), "LYD")], "control")).toThrow(/leaked/);

    // Everyone else: either no report at all, or the very same projection — in both formats.
    const allowed: string[] = [];
    for (const key of [...NON_OFFICERS, "aPayroll"]) {
      const actor = await world.as(key);
      for (const format of ["CSV", "PDF"] as const) {
        const requested = await actor.post<{ id: string }>("/reports", { type: "STATEMENT", format, accountIds: [PAYROLL.id], fromDate: day, toDate: day });
        if (requested.status !== 202) {
          expect([403, 404], `${key} POST /reports`).toContain(requested.status);
          continue;
        }
        allowed.push(`${key}:${format}`);
        await drainAll(world);
        const file = await actor.get(`/reports/${requested.data.id}/download`);
        expect(file.status, `${key} report download`).toBe(200);
        if (format === "CSV") {
          expectNoSecret(file.text, secrets, `${key} statement report CSV`);
          expect(file.text.split("\r\n").filter((line) => line.includes(",PAYROLL_RUN,"))).toHaveLength(1);
        } else {
          expectNoSecretInPdf(file.bytes, secrets, `${key} statement report PDF`);
        }
        // A file belongs to its requester: nobody else can fetch it, with or without report rights.
        for (const otherKey of ["aChecker1", "aFinance", "aViewer"].filter((entry) => entry !== key)) {
          const refused = await (await world.as(otherKey)).get(`/reports/${requested.data.id}/download`);
          expect([403, 404], `${otherKey} fetching ${key}'s report`).toContain(refused.status);
          expect(refused.headers.get("content-type") ?? "").not.toMatch(/csv|pdf/);
        }
      }
    }
    // The payroll officer holds no report right; a viewer does and is among those checked.
    expect(allowed).toContain("aViewer:CSV");
    expect(allowed).toContain("aViewer:PDF");
    expect(allowed.filter((entry) => entry.startsWith("aPayroll"))).toEqual([]);

    // --- What a webhook subscriber was actually sent ------------------------------------------
    await drainAll(world);
    type Sent = { id: string; type: string; corporateReference: string; data: Record<string, unknown> };
    const sent = subscriber.received.map((request) => JSON.parse(request.body) as Sent);
    const finished = sent.filter((event) => event.type === "batch.finished" && event.data["reference"] === runReference);
    expect(finished.length).toBeGreaterThanOrEqual(1);
    const last = finished[finished.length - 1] as Sent;
    expect(last.data).toMatchObject({ resourceId: runId, kind: "PAYROLL", state: "COMPLETED" });
    // Identifiers of the lines never leave: no event names a payroll line or its posting.
    const lineIds = new Set<string>();
    for (const row of await world.db.batchRow.findMany({ where: { batchId: runId }, select: { id: true } })) lineIds.add(row.id);
    for (const instruction of await world.db.businessInstruction.findMany({ where: { batchId: runId }, select: { id: true } })) lineIds.add(instruction.id);
    for (const attempt of await world.db.executionAttempt.findMany({ where: { instruction: { batchId: runId } }, select: { id: true, executionReference: true } })) {
      lineIds.add(attempt.id);
      lineIds.add(attempt.executionReference);
    }
    expect(lineIds.size).toBeGreaterThanOrEqual(9 * 3);
    for (const request of subscriber.received) {
      expectNoSecret(request.body, [...secrets, ...lineIds], "webhook delivery body");
      expectNoSecret(JSON.stringify(request.headers), [...secrets, ...lineIds], "webhook delivery headers");
      expectNoSecret(request.url.toString(), [...secrets, ...lineIds], "webhook delivery url");
    }
    expect(sent.filter((event) => event.type === "payment.status_changed")).toEqual([]);
    const deliveries = await token.get(`/developer/webhooks`);
    expectNoSecret(deliveries.text, [...secrets, ...lineIds], "webhook list through the token");
    expectNoSecret(JSON.stringify(await world.db.webhookDelivery.findMany()), [...secrets, ...lineIds], "stored webhook deliveries");

    // Nothing of the above reached the log either.
    expectNoSecret(logLines.join("\n"), secrets, "application log after reports and deliveries");
  });

  it("blocks the same salary in another file and keeps detail out of error paths and logs (I-29, I-51)", async () => {
    // Same employee, period and component under a new file name and a new idempotency key.
    const again = await uploadAndValidate(world, "aPayroll", payrollFile([payRow(1, { row_reference: "RESEND-1", payslip_reference: "PS-RESEND-1" }), payRow(4, { row_reference: "RESEND-4", payslip_reference: "PS-RESEND-4" })]), { kind: "PAYROLL", fileName: "november-again.csv", idempotencyKey: crypto.randomUUID() });
    expect(again).toMatchObject({ state: "FAILED", validationErrorCode: "NO_VALID_ROWS", counts: { valid: 0, duplicate: 2 } });
    const rows = await rowsOf(world, again.id, "aPayroll");
    expect(rows.items.map((row) => row.errors?.[0]?.code)).toEqual(["DUPLICATE_SALARY", "DUPLICATE_SALARY"]);
    expect(await world.db.businessInstruction.count({ where: { batchId: again.id } })).toBe(0);
    // A checker sees that the file failed — and why — without a line of it.
    const checker = await (await world.as("aChecker1")).get<BatchData>(`/batches/${again.id}`);
    expect(checker.data).toMatchObject({ state: "FAILED", validationErrorCode: "NO_VALID_ROWS" });

    // A failure in the worker itself: the stored upload disappears before validation runs.
    const secret = payRow(5, { row_reference: "LOST-5", basic: "5123.457", payslip_reference: "PS-LOST-5" }, "2026-12");
    const lost = await upload(world, "aPayroll", payrollFile([secret]), { kind: "PAYROLL", fileName: "lost.csv" });
    expect(lost.status).toBe(202);
    const stored = await world.db.batch.findUniqueOrThrow({ where: { id: lost.data.id }, select: { storageKey: true } });
    const { deletePrivateFile } = await import("@/server/files/storage");
    await deletePrivateFile(world.deps.storagePath, stored.storageKey as string);
    await drainAll(world);
    expect((await getBatch(world, lost.data.id, "aPayroll")).state).toBe("VALIDATING");
    const failedJob = await world.db.job.findFirstOrThrow({ where: { type: "batch.validate", aggregateId: lost.data.id } });
    expect(failedJob.attempts).toBeGreaterThan(0);
    expectNoSecret(JSON.stringify(failedJob), ["5123.457", "LOST-5", "PS-LOST-5", "Demo Staff Eman"], "failed job record");
    const log = logLines.join("\n");
    expect(log).toContain("validation could not be completed");
    expectNoSecret(log, ["5123.457", "5273457", "LOST-5", "PS-LOST-5", "Demo Staff", "DEMO-LY-9100", ...secretsOf(accepted)], "application log");

    // A malformed upload answers with a problem document that does not echo the cell.
    const malformed = await upload(world, "aPayroll", new TextEncoder().encode('row_reference,employee_code,pay_period\r\n"unterminated,EMP-001,7777.123\r\n'), { kind: "PAYROLL", fileName: "broken.csv" });
    expect(malformed.status).toBe(400);
    expect(malformed.text).not.toContain("7777.123");
    expect(logLines.join("\n")).not.toContain("7777.123");
  });

  it("flags a salary change for acknowledgment, pays a correction once and refuses unverified or inactive employees (PYR-01)", async () => {
    const officer = await world.as("aPayroll");
    // December: one employee up 25%, one up 19.9%, one unchanged.
    const novemberNet = (n: number) => netMinorOf(november[n - 1] as PayRow);
    const basicFor = (net: bigint) => formatMinor(net - 150_000n, "LYD");
    const raised = (novemberNet(1) * 125n) / 100n;
    const nudged = (novemberNet(2) * 1199n) / 1000n;
    const december = [payRow(1, { basic: basicFor(raised) }, "2026-12"), payRow(2, { basic: basicFor(nudged) }, "2026-12"), payRow(3, {}, "2026-12")];
    let run = await uploadAndValidate(world, "aPayroll", payrollFile(december), { kind: "PAYROLL", fileName: "december.csv" });
    expect(run).toMatchObject({ state: "READY", payPeriod: "2026-12", counts: { valid: 3, warnings: 1 } });
    const flagged = (await rowsOf(world, run.id, "aPayroll")).items.filter((row) => (row.warnings ?? []).length > 0);
    expect(flagged.map((row) => [row.lineNumber, row.warnings?.[0]?.code, row.detail?.["previousNetMinor"]])).toEqual([[2, "SALARY_CHANGE", novemberNet(1).toString()]]);
    // The change must be acknowledged; the approver learns only how many lines changed.
    expect((await accept(world, "aPayroll", run)).status).toBe(400);
    const acknowledged = await accept(world, "aPayroll", run, { acknowledgeWarnings: true });
    expect(acknowledged.status).toBe(200);
    const submitted = await submit(world, "aPayroll", acknowledged.data);
    expect(submitted.status).toBe(202);
    expect((submitted.data.approval as NonNullable<BatchData["approval"]>).summary).toMatchObject({ changeFlagCount: 1, count: 3, payPeriod: "2026-12" });
    expectNoSecret((await (await world.as("aChecker1")).get(`/approvals/${(submitted.data.approval as { id: string }).id}`)).text, secretsOf(december), "checker approval view");
    expect((await approve(world, (submitted.data.approval as { id: string }).id, "aChecker1")).status).toBe(200);
    await settle(world);
    expect((await getBatch(world, run.id, "aPayroll")).state).toBe("COMPLETED");

    // A correction for November is its own instruction, named by its reference, paid once.
    const correction = payRow(1, { row_reference: "CORR-ROW-1", basic: "0.000", allowances: "0.000", deductions: "0.000", correction: "25.125", correction_reference: "CORR-2026-11-001", payslip_reference: "PS-CORR-1" });
    const missingReference = await uploadAndValidate(world, "aPayroll", payrollFile([{ ...correction, row_reference: "CORR-ROW-0", correction_reference: "" }]), { kind: "PAYROLL", fileName: "correction-missing.csv", correction: true });
    expect(missingReference).toMatchObject({ state: "FAILED", validationErrorCode: "NO_VALID_ROWS" });
    run = await uploadAndValidate(world, "aPayroll", payrollFile([correction]), { kind: "PAYROLL", fileName: "correction.csv", correction: true });
    expect(run).toMatchObject({ state: "READY", counts: { valid: 1 } });
    const paid = await acceptSubmitApprove(world, "aPayroll", run);
    expect((paid.approval as NonNullable<BatchData["approval"]>).summary).toMatchObject({ isCorrection: true, amount: { minor: "25125" } });
    await settle(world);
    expect((await getBatch(world, run.id, "aPayroll")).state).toBe("COMPLETED");
    const repeated = await uploadAndValidate(world, "aPayroll", payrollFile([{ ...correction, row_reference: "CORR-ROW-2" }]), { kind: "PAYROLL", fileName: "correction-again.csv", correction: true });
    expect(repeated).toMatchObject({ state: "FAILED", validationErrorCode: "NO_VALID_ROWS", counts: { duplicate: 1 } });
    expect(await world.db.businessInstruction.count({ where: { corporateId: CORPORATES.A.id, kind: "PAYROLL_ROW", state: "SETTLED" } })).toBe(9 + 3 + 1);

    // Employee master: a wrong name is stored but cannot be paid until it is corrected.
    const [idris, jamila] = NEW_STAFF_A;
    const wrong = await officer.post<Employee>("/payroll/employees", { employeeCode: "emp-009", name: "Somebody Else", accountScheme: "DEMO_DOMESTIC", accountReference: idris.reference });
    expect(wrong.status).toBe(201);
    expect(wrong.data).toMatchObject({ employeeCode: "EMP-009", accountMatchStatus: "MISMATCH", payable: false });
    expect((await officer.post("/payroll/employees", { employeeCode: "EMP-009", name: idris.name, accountScheme: "DEMO_DOMESTIC", accountReference: idris.reference })).status).toBe(409);
    expect((await officer.post("/payroll/employees", { employeeCode: "EMP-020", name: idris.name, accountScheme: "IBAN", accountReference: idris.reference })).status).toBe(400);
    expect((await officer.post("/payroll/employees", { employeeCode: "EMP-020", name: idris.name, accountScheme: "DEMO_DOMESTIC", accountReference: idris.reference, nationalId: "1234567890" })).status).toBe(400);
    const january = (overrides: Partial<PayRow> = {}) => payRow(9, { basic: "1000.000", ...overrides }, "2027-01");
    const blocked = await uploadAndValidate(world, "aPayroll", payrollFile([january()]), { kind: "PAYROLL", fileName: "january-unverified.csv" });
    expect(blocked).toMatchObject({ state: "FAILED", counts: { invalid: 1 } });
    expect((await rowsOf(world, blocked.id, "aPayroll")).items[0]?.errors?.[0]?.code).toBe("EMPLOYEE_ACCOUNT_UNVERIFIED");

    expect((await officer.patch(`/payroll/employees/${wrong.data.id}`, { name: idris.name }, { ifMatch: wrong.data.version + 5 })).status).toBe(412);
    const fixed = await officer.patch<Employee>(`/payroll/employees/${wrong.data.id}`, { name: idris.name }, { ifMatch: wrong.data.version });
    expect(fixed.status).toBe(200);
    expect(fixed.data).toMatchObject({ accountMatchStatus: "MATCHED", payable: true, version: wrong.data.version + 1 });
    const inactive = await officer.patch<Employee>(`/payroll/employees/${wrong.data.id}`, { active: false }, { ifMatch: fixed.data.version });
    expect(inactive.data).toMatchObject({ active: false, payable: false });
    const stopped = await uploadAndValidate(world, "aPayroll", payrollFile([january({ row_reference: "PAY-2027-01-EMP-009-B" })]), { kind: "PAYROLL", fileName: "january-inactive.csv" });
    expect((await rowsOf(world, stopped.id, "aPayroll")).items[0]?.errors?.[0]?.code).toBe("EMPLOYEE_INACTIVE");

    // Import: preview changes nothing; commit persists exactly the previewed valid rows.
    const masterBefore = await world.db.payrollEmployee.count({ where: { corporateId: CORPORATES.A.id } });
    const form = new FormData();
    form.set("templateVersion", "1");
    form.set(
      "file",
      new File(
        [
          employeesFile([
            { employee_code: "EMP-010", employee_name: jamila.name, account_scheme: "DEMO_DOMESTIC", account_reference: jamila.reference, active: "true" },
            { employee_code: "EMP-001", employee_name: EMPLOYEES_A[0].name, account_scheme: "DEMO_DOMESTIC", account_reference: EMPLOYEES_A[0].reference, active: "true" },
            { employee_code: "EMP-011", employee_name: "Wrong Person", account_scheme: "DEMO_DOMESTIC", account_reference: NEW_STAFF_A[2].reference, active: "true" },
            { employee_code: "EMP-010", employee_name: jamila.name, account_scheme: "DEMO_DOMESTIC", account_reference: jamila.reference, active: "true" },
            { employee_code: "EMP-012", employee_name: NEW_STAFF_A[3].name, account_scheme: "DEMO_DOMESTIC", account_reference: "DEMO-LY-999999", active: "maybe" },
          ]) as BlobPart,
        ],
        "staff.csv",
      ),
    );
    const preview = await officer.post<ImportView>("/payroll/employees/import", undefined, { form });
    expect(preview.status).toBe(201);
    expect(preview.data).toMatchObject({ state: "PREVIEWED", totalRows: 5, validRows: 2, invalidRows: 3 });
    expect(preview.data.rows.map((row) => [row.line, row.state, row.action, row.errors[0]?.code ?? null])).toEqual([
      [2, "VALID", "CREATE", null],
      [3, "VALID", "UNCHANGED", null],
      [4, "INVALID", null, "NAME_MISMATCH"],
      [5, "INVALID", null, "DUPLICATE_CODE"],
      [6, "INVALID", null, "ACTIVE_FORMAT"],
    ]);
    expect(await world.db.payrollEmployee.count({ where: { corporateId: CORPORATES.A.id } })).toBe(masterBefore);
    // Only an officer of the same corporate can read or commit the preview.
    expect((await (await world.as("aChecker1")).get(`/payroll/employees/imports/${preview.data.id}`)).status).toBe(403);
    expect((await (await world.as("aAdmin")).post(`/payroll/employees/imports/${preview.data.id}/commit`, { acceptedHash: preview.data.acceptedHash, confirmExcludeInvalid: true }, { ifMatch: preview.data.version })).status).toBe(403);
    expect((await officer.post(`/payroll/employees/imports/${preview.data.id}/commit`, { acceptedHash: preview.data.acceptedHash }, { ifMatch: preview.data.version })).status).toBe(400);
    expect((await officer.post(`/payroll/employees/imports/${preview.data.id}/commit`, { acceptedHash: "0".repeat(64), confirmExcludeInvalid: true }, { ifMatch: preview.data.version })).status).toBe(412);
    const committed = await officer.post<ImportView>(`/payroll/employees/imports/${preview.data.id}/commit`, { acceptedHash: preview.data.acceptedHash, confirmExcludeInvalid: true }, { ifMatch: preview.data.version });
    expect(committed.status).toBe(200);
    expect(committed.data.state).toBe("COMMITTED");
    expect(await world.db.payrollEmployee.count({ where: { corporateId: CORPORATES.A.id } })).toBe(masterBefore + 1);
    expect((await officer.post(`/payroll/employees/imports/${preview.data.id}/commit`, { acceptedHash: preview.data.acceptedHash, confirmExcludeInvalid: true }, { ifMatch: committed.data.version })).status).toBe(409);

    const master = await officer.get<{ items: Employee[]; counts: { total: number; active: number; unverified: number } }>("/payroll/employees?limit=200");
    expect(master.status).toBe(200);
    expect(master.data.counts).toEqual({ total: masterBefore + 1, active: masterBefore, unverified: 0 });
    expect(master.data.items.find((employee) => employee.employeeCode === "EMP-010")).toMatchObject({ name: jamila.name, accountReference: jamila.reference, accountMatchStatus: "MATCHED", payable: true });
    // Another corporate's employee is invisible even with a guessed id.
    const foreign = await world.db.payrollEmployee.create({ data: { bankId: (await world.db.corporate.findUniqueOrThrow({ where: { id: CORPORATES.B.id } })).bankId, corporateId: CORPORATES.B.id, employeeCode: "EMP-001", name: "Other Tenant Staff", accountScheme: "DEMO_DOMESTIC", accountReference: "DEMO-LY-910001" } });
    expect((await officer.patch(`/payroll/employees/${foreign.id}`, { active: false }, { ifMatch: 1 })).status).toBe(404);
    expect(master.text).not.toContain("Other Tenant Staff");

    // Audit rows of the master record that something happened, never who or what.
    const audit = await world.db.auditEvent.findMany({ where: { corporateId: CORPORATES.A.id, action: { startsWith: "payroll.employee" } } });
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(["payroll.employee.created", "payroll.employee.updated", "payroll.employees.import.previewed", "payroll.employees.import.committed", "payroll.employees.read"]));
    expectNoSecret(JSON.stringify(audit), [idris.name, idris.reference, jamila.name, jamila.reference, "EMP-009", "EMP-010", "Somebody Else", "Wrong Person"], "employee audit rows");
    expectNoSecret(logLines.join("\n"), [idris.name, idris.reference, jamila.name, "Somebody Else", "Wrong Person"], "application log");
  });
});
