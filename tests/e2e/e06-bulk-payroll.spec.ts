/**
 * E-06 Bulk transfer and E-07 Payroll, through the real screens with distinct people.
 *
 * E-06: a maker uploads a file from the phone-or-desktop file picker, excludes the invalid row
 * with an explicit confirmation, inspects the accepted total and fees, a DIFFERENT checker
 * approves the aggregate, the worker pays each row once, the result is partial and the
 * failed-only retry creates a new batch that needs its own approval.
 * E-07: a payroll officer uploads salaries and sees employee detail; the checker approves
 * totals and never receives a name, an employee code or a single salary in the page; the
 * statement shows one consolidated line.
 * Requirements: BAT-01..04, PYR-01, PYR-02, SEC-04, APR-01, MOB-04, MOB-05.
 */
import { apiFrom, expect, minorOf, test, waitForState } from "./support/fixtures.ts";

const csv = (headers: string[], rows: string[][]) => Buffer.from(`﻿${[headers, ...rows].map((row) => row.join(",")).join("\r\n")}\r\n`, "utf8");
const supplier = (n: number) => `Bulk Demo Supplier ${String(n).padStart(3, "0")}`;
const account = (n: number) => `DEMO-LY-92${String(n).padStart(4, "0")}`;
const idOf = (url: string) => new URL(url).pathname.split("/").pop() as string;

type Batch = { id: string; reference: string; state: string; approval: { id: string } | null };
type Approval = { version: number; targetRevision: number; payloadHash: string };

test("E-06 bulk transfer: upload, exclude the invalid row, approve the aggregate, partial result, failed-only retry", async ({ actor, path, appLocale }) => {
  const tag = `E6${appLocale.toUpperCase()}`;
  const row = (n: number, amount = "10.000") => [`${tag}-${n}`, supplier(n), "DEMO_DOMESTIC", account(n), amount, "LYD", `Synthetic invoice ${n}`];
  const file = csv(["row_reference", "beneficiary_name", "account_scheme", "account_reference", "amount", "currency", "purpose"], [row(1), row(2), row(3), row(4, "ten"), row(91)]);

  const maker = await actor("aMaker");
  await maker.goto(path("/batches"));
  await maker.getByTestId("new-batch").click();
  await expect(maker.getByTestId("batch-upload-form")).toBeVisible();
  // Nothing is sent without a file.
  await maker.getByTestId("batch-upload-submit").click();
  await expect(maker.locator("#batch-file-error")).toBeVisible();
  await maker.getByTestId("batch-file").setInputFiles({ name: `suppliers-${tag}.csv`, mimeType: "text/csv", buffer: file });
  await maker.getByTestId("batch-upload-submit").click();
  await maker.waitForURL(/\/batches\/[0-9a-f-]{36}$/);
  const batchId = idOf(maker.url());

  // The worker validates; the page shows what will and will not be paid.
  await waitForState(maker, ["READY"]);
  await expect(maker.getByTestId("count-valid")).toHaveText("4");
  await expect(maker.getByTestId("count-invalid")).toHaveText("1");
  await maker.getByTestId("rows-INVALID").click();
  await expect(maker.locator('[data-problem="AMOUNT_FORMAT"]').filter({ visible: true }).first()).toBeVisible();
  await expect(maker.getByTestId("download-errors")).toBeVisible();

  // Invalid rows are left out only with an explicit confirmation.
  await expect(maker.getByTestId("accept-rows")).toBeDisabled();
  await maker.getByTestId("confirm-exclude-invalid").check();
  await maker.getByTestId("accept-rows").click();
  await expect(maker.getByTestId("count-accepted")).toHaveText("4");
  expect(await minorOf(maker.getByTestId("accepted-amount"))).toBe(40_000n);
  expect(await minorOf(maker.getByTestId("accepted-fee"))).toBe(1_000n);
  expect(await minorOf(maker.getByTestId("accepted-total"))).toBe(41_000n);

  await maker.getByTestId("submit-batch").click();
  await expect(maker.getByTestId("status").first()).toHaveAttribute("data-state", "PENDING_APPROVAL");
  const pending = (await apiFrom<Batch>(maker, "GET", `/batches/${batchId}`)).body.data as Batch;
  const approvalId = pending.approval?.id as string;
  expect(approvalId).toBeTruthy();

  // The maker cannot approve their own batch — not in the page and not with a forged request.
  await maker.goto(path(`/approvals/${approvalId}`));
  await expect(maker.getByTestId("cannot-decide")).toBeVisible();
  await expect(maker.getByTestId("approve")).toHaveCount(0);
  const own = (await apiFrom<Approval>(maker, "GET", `/approvals/${approvalId}`)).body.data as Approval;
  const forged = await apiFrom(maker, "POST", `/approvals/${approvalId}/approve`, { body: { proposalVersion: own.targetRevision, proposalHash: own.payloadHash }, ifMatch: own.version, idempotencyKey: crypto.randomUUID() });
  expect(forged.status).toBe(403);

  // A different person approves the frozen aggregate.
  const checker = await actor("aChecker1");
  await checker.goto(path(`/approvals/${approvalId}`));
  const summary = checker.getByTestId("batch-approval-summary");
  await expect(summary).toHaveAttribute("data-kind", "BULK");
  await expect(checker.getByTestId("batch-count")).toHaveText("4");
  expect(await minorOf(checker.getByTestId("batch-amount"))).toBe(40_000n);
  expect(await minorOf(checker.getByTestId("batch-fee"))).toBe(1_000n);
  expect(await minorOf(checker.getByTestId("batch-total-debit"))).toBe(41_000n);
  await checker.getByTestId("approve").click();
  await expect(checker.getByTestId("decision-closed")).toBeVisible();

  // Three rows settle, the blocked recipient fails before posting: a partial result.
  await maker.goto(path(`/batches/${batchId}`));
  await waitForState(maker, ["PARTIALLY_COMPLETED"]);
  await expect(maker.getByTestId("outcome-settled")).toHaveText("3");
  await expect(maker.getByTestId("outcome-failed")).toHaveText("1");
  expect(await minorOf(maker.getByTestId("outcome-amount"))).toBe(30_000n);
  await maker.getByTestId("rows-FAILED").click();
  await expect(maker.locator('[data-row-state="FAILED"]').filter({ visible: true }).first()).toBeVisible();
  await expect(maker.getByTestId("download-result")).toBeVisible();

  // Retry takes only the failed row into a NEW batch that needs its own confirmation.
  await maker.getByTestId("retry-failed").click();
  await maker.waitForURL((url) => /\/batches\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(batchId));
  const retryId = idOf(maker.url());
  await expect(maker.getByTestId("status").first()).toHaveAttribute("data-state", "READY");
  await expect(maker.getByTestId("count-total")).toHaveText("1");
  const retry = (await apiFrom<Batch & { parent: { id: string } | null }>(maker, "GET", `/batches/${retryId}`)).body.data as Batch & { parent: { id: string } | null };
  expect(retry.parent?.id).toBe(batchId);
  expect(retry.approval).toBeNull();
  // The settled rows cannot be retried and the original cannot spawn a second retry.
  const again = await apiFrom(maker, "POST", `/batches/${batchId}/retry`, { body: {}, idempotencyKey: crypto.randomUUID() });
  expect(again.status).toBe(409);
});

test("E-07 payroll: the officer sees employee detail, the checker approves totals without it", async ({ actor, path, appLocale }) => {
  const period = appLocale === "ar" ? "2027-02" : "2027-01";
  const line = (n: number) => [`PAY-${period}-EMP-00${n}`, `EMP-00${n}`, period, "SALARY", "1000.000", "0.000", "0.000", "0.000", `PS-${period}-00${n}`, "LYD", ""];
  const file = csv(["row_reference", "employee_code", "pay_period", "component", "basic", "allowances", "deductions", "correction", "payslip_reference", "currency", "correction_reference"], [line(1), line(2), line(3)]);

  const officer = await actor("aPayroll");
  await officer.goto(path("/payroll"));
  await officer.getByTestId("employees-link").click();
  await expect(officer.getByTestId("employee-list")).toContainText("Demo Staff Amna");
  await officer.goto(path("/payroll/new"));
  await officer.getByTestId("batch-file").setInputFiles({ name: `salaries-${period}.csv`, mimeType: "text/csv", buffer: file });
  await officer.getByTestId("batch-upload-submit").click();
  await officer.waitForURL(/\/payroll\/[0-9a-f-]{36}$/);
  const runId = idOf(officer.url());
  await waitForState(officer, ["READY"]);
  await expect(officer.getByTestId("batch-rows")).toHaveAttribute("data-projection", "PAYROLL_DETAIL");
  await expect(officer.getByTestId("batch-rows")).toContainText("Demo Staff Amna");
  await officer.getByTestId("accept-rows").click();
  await expect(officer.getByTestId("count-accepted")).toHaveText("3");
  expect(await minorOf(officer.getByTestId("accepted-amount"))).toBe(3_000_000n);
  expect(await minorOf(officer.getByTestId("accepted-fee"))).toBe(300n);
  await officer.getByTestId("submit-batch").click();
  await expect(officer.getByTestId("status").first()).toHaveAttribute("data-state", "PENDING_APPROVAL");
  const run = (await apiFrom<Batch>(officer, "GET", `/batches/${runId}`)).body.data as Batch;
  const approvalId = run.approval?.id as string;

  // The checker sees totals only — in the approval and on the run page itself.
  const checker = await actor("aChecker1");
  const leaked = async (where: string) => {
    const html = await checker.content();
    for (const secret of ["Demo Staff", "EMP-00", "DEMO-LY-9100", 'data-money="1000000"', `PS-${period}`, `PAY-${period}`]) expect(html, `${where} must not contain ${secret}`).not.toContain(secret);
  };
  await checker.goto(path(`/approvals/${approvalId}`));
  await expect(checker.getByTestId("batch-approval-summary")).toHaveAttribute("data-kind", "PAYROLL");
  await expect(checker.getByTestId("batch-count")).toHaveText("3");
  expect(await minorOf(checker.getByTestId("batch-amount"))).toBe(3_000_000n);
  expect(await minorOf(checker.getByTestId("batch-total-debit"))).toBe(3_000_300n);
  await expect(checker.getByTestId("batch-pay-period")).toContainText(period);
  await leaked("approval page");
  await checker.goto(path(`/payroll/${runId}`));
  await expect(checker.getByTestId("aggregate-only")).toBeVisible();
  await expect(checker.getByTestId("batch-rows")).toHaveAttribute("data-projection", "PAYROLL_MASKED");
  await expect(checker.getByTestId("download-result")).toHaveCount(0);
  await leaked("payroll run page");
  await checker.goto(path("/payroll/employees"));
  await expect(checker.getByTestId("forbidden")).toBeVisible();
  await leaked("employees page");
  for (const route of [`/batches/${runId}/rows`, `/batches/${runId}/result`, "/payroll/employees"]) {
    const reply = await apiFrom(checker, "GET", route);
    for (const secret of ["Demo Staff", "EMP-00", "DEMO-LY-9100"]) expect(JSON.stringify(reply.body)).not.toContain(secret);
  }
  expect((await apiFrom(checker, "GET", `/batches/${runId}/result`)).status).toBe(403);

  await checker.goto(path(`/approvals/${approvalId}`));
  await checker.getByTestId("approve").click();
  await expect(checker.getByTestId("decision-closed")).toBeVisible();

  // Submitted to the synthetic ACH rail: accepted is not settled until the rail confirms.
  await officer.goto(path(`/payroll/${runId}`));
  await waitForState(officer, ["PROCESSING"]);
  const ops = await actor("ops");
  const advanced = await apiFrom(ops, "POST", "/bank/simulator/clock", { body: { advanceMinutes: 6, reason: "E-07 ACH settlement delay" }, idempotencyKey: crypto.randomUUID() });
  expect(advanced.status).toBe(200);
  await waitForState(officer, ["COMPLETED"]);
  await expect(officer.getByTestId("outcome-settled")).toHaveText("3");
  expect(await minorOf(officer.getByTestId("outcome-amount"))).toBe(3_000_000n);

  // One consolidated statement line for the run; no per-employee entry reaches the checker.
  type Line = { kind: string; groupRef: string | null; itemCount: number; signedMinor: string };
  const accounts = (await apiFrom<Array<{ id: string; kind: string }>>(checker, "GET", "/accounts")).body.data ?? [];
  const payrollAccount = accounts.find((entry) => entry.kind === "PAYROLL") as { id: string };
  const statement = await apiFrom<{ lines: Line[] }>(checker, "GET", `/accounts/${payrollAccount.id}/statements?limit=100`);
  const lines = (statement.body.data?.lines ?? []).filter((entry) => entry.groupRef === run.reference);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ kind: "PAYROLL_RUN", itemCount: 3, signedMinor: "-3000300" });
  expect(JSON.stringify(statement.body)).not.toContain("Demo Staff");

  // After settlement too: every page the checker can open shows the run as a total, never a
  // name, an employee code, an account or one person's pay (with or without its fee).
  for (const route of [`/payroll/${runId}`, "/payroll", `/accounts/${payrollAccount.id}`, "/accounts", "/dashboard", "/notifications", "/approvals", `/approvals/${approvalId}`, "/audit", "/limits"]) {
    await checker.goto(path(route));
    await expect(checker.locator("main").first()).toBeVisible();
    await leaked(`${route} after settlement`);
    expect(await checker.content(), `${route} must not show a single salary`).not.toMatch(/data-money="-?1000[01]00"/);
  }
  await checker.goto(path(`/accounts/${payrollAccount.id}`));
  await expect(checker.getByTestId("payroll-line").filter({ visible: true }).first()).toBeVisible();
  await expect(checker.locator('[data-signed-minor="-3000300"]').filter({ visible: true }).first()).toBeVisible();
  for (const single of ["-1000000", "-1000100", "-100"]) await expect(checker.locator(`[data-signed-minor="${single}"]`)).toHaveCount(0);
});
