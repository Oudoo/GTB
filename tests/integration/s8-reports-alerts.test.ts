/**
 * S8 reports and alerts (RPT-01, ALT-01; I-41, I-42, I-50): statement files use the same
 * payroll-masked projection as the screens, a report is authorized at request, generation and
 * download, exports are formula-safe, and an alert fires once per rule and window.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatMinor } from "@/contracts/money";
import { evaluateAlertRules } from "@/server/domain/alerts/service";
import { fixtureUuid } from "@/server/hash";
import { ACCOUNTS, BRANCHES, CORPORATES, EMPLOYEES_A } from "@/server/seed/fixtures";
import { acceptSubmitApprove, netMinorOf, payRow, payrollFile, uploadAndValidate, type PayRow } from "./support/batches";
import { payAndApprove } from "./support/payments";
import { createWorld, race, type World } from "./support/world";

type Report = { id: string; type: string; format: string; state: string; rowCount: number | null; failureCode: string | null; downloadable: boolean };
type Note = { id: string; kind: string; read: boolean; params: Record<string, unknown>; linkPath: string | null };

const TODAY = "2026-11-23";
const body = (overrides: Record<string, unknown> = {}) => ({ type: "STATEMENT", format: "CSV", accountIds: [ACCOUNTS.A_PAYROLL.id, ACCOUNTS.A_OPERATING.id], fromDate: TODAY, toDate: TODAY, ...overrides });

async function drainAll(world: World): Promise<void> {
  while ((await world.drain(2_000)) > 0) {
    /* until no job is due */
  }
}

describe("S8 reports and alerts", () => {
  let world: World;
  const salaries: PayRow[] = [1, 2, 3].map((n) => payRow(n));
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
    await world.activateAgreement("B");
    // Activity to report on: one supplier payment and one settled payroll run.
    await payAndApprove(world, { minor: "125000" });
    const run = await uploadAndValidate(world, "aPayroll", payrollFile(salaries), { kind: "PAYROLL", fileName: "salaries.csv" });
    await acceptSubmitApprove(world, "aPayroll", run);
    await drainAll(world);
    world.clock.advanceMs(6 * 60_000);
    await drainAll(world);
  });
  afterAll(async () => world.close());

  it("produces statement files with the payroll run as one total line and no employee detail (RPT-01, PYR-02)", async () => {
    const finance = await world.as("aFinance");
    const requested = await finance.post<Report>("/reports", body());
    expect(requested.status).toBe(202);
    expect(requested.data).toMatchObject({ state: "PENDING", downloadable: false });
    // Not ready yet: nothing can be downloaded.
    expect((await finance.get(`/reports/${requested.data.id}/download`)).status).toBe(409);
    await drainAll(world);
    const ready = await finance.get<Report>(`/reports/${requested.data.id}`);
    expect(ready.data).toMatchObject({ state: "READY", downloadable: true });
    expect(ready.data.rowCount).toBeGreaterThanOrEqual(3);

    const file = await finance.get(`/reports/${requested.data.id}/download`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("text/csv");
    expect(file.headers.get("content-disposition")).toContain("statement-2026-11-23-2026-11-23");
    expect(file.headers.get("cache-control")).toContain("no-store");
    const lines = file.text.trim().split("\r\n");
    const total = salaries.reduce((sum, row) => sum + netMinorOf(row), 0n);
    // One consolidated payroll line: total of the run plus its fees, three items.
    const payrollLines = lines.filter((line) => line.includes(",PAYROLL_RUN,"));
    expect(payrollLines).toHaveLength(1);
    expect(payrollLines[0]).toContain(`-${formatMinor(total + 300n, "LYD")}`);
    expect(payrollLines[0]?.endsWith(",3")).toBe(true);
    expect(lines.some((line) => line.includes(",PAYMENT,") && line.includes("-125.000"))).toBe(true);
    for (const row of salaries) {
      const employee = EMPLOYEES_A.find((entry) => entry.code === row.employee_code);
      for (const secret of [row.employee_code, row.payslip_reference, row.row_reference, employee?.name ?? "", employee?.reference ?? "", formatMinor(netMinorOf(row), "LYD")]) expect(file.text).not.toContain(secret);
    }

    // The PDF is the same projection in Arabic, with the simulated stamp.
    const pdf = await finance.post<Report>("/reports", body({ format: "PDF", locale: "ar" }));
    await drainAll(world);
    const pdfFile = await finance.get(`/reports/${pdf.data.id}/download`);
    expect(pdfFile.status).toBe(200);
    expect(pdfFile.headers.get("content-type")).toContain("application/pdf");
    expect(pdfFile.text.startsWith("%PDF")).toBe(true);

    // Each request and each download is audited without content.
    const audit = await world.db.auditEvent.findMany({ where: { targetType: "report", targetId: requested.data.id }, orderBy: { id: "asc" } });
    expect(audit.map((event) => event.action)).toEqual(["report.requested", "report.downloaded"]);
    expect(JSON.stringify(audit)).not.toContain("Demo Staff");
  });

  it("authorizes a report at request, at generation and at download — not once for ever (I-42, SEC-01)", async () => {
    const finance = await world.as("aFinance");
    // Request-time: range, account scope, format.
    expect((await finance.post("/reports", body({ fromDate: "2025-01-01" }))).status).toBe(400);
    expect((await finance.post("/reports", body({ fromDate: "2026-11-24" }))).status).toBe(400);
    expect((await finance.post("/reports", body({ accountIds: [ACCOUNTS.B_OPERATING.id] }))).status).toBe(404);
    expect((await finance.post("/reports", body({ accountIds: [ACCOUNTS.A_OPERATING.id, ACCOUNTS.B_OPERATING.id] }))).status).toBe(404);
    expect((await finance.post("/reports", body({ type: "DEPOSIT_SUMMARY", format: "PDF" }))).status).toBe(400);
    expect((await finance.post("/reports", body({ type: "PAYROLL_DETAIL" }))).status).toBe(400);
    expect((await finance.post("/reports", body({ requestedByPersonId: crypto.randomUUID() }))).status).toBe(400);
    // A maker has no report permission; a payroll officer has no report right on these accounts.
    expect((await (await world.as("aMaker")).post("/reports", body())).status).toBe(403);
    expect([403, 404]).toContain((await (await world.as("aPayroll")).post("/reports", body())).status);

    const report = await finance.post<Report>("/reports", body({ accountIds: [ACCOUNTS.A_OPERATING.id] }));
    await drainAll(world);
    expect((await finance.get(`/reports/${report.data.id}/download`)).status).toBe(200);
    // Somebody else — even with report rights on the same account — cannot use the artifact.
    for (const key of ["aViewer", "aTreasurer", "bFinance", "ops"]) {
      const other = await world.as(key);
      expect((await other.get(`/reports/${report.data.id}/download`)).status).toBe(404);
      expect((await other.get(`/reports/${report.data.id}`)).status).toBe(404);
    }
    expect((await world.anonymous().get(`/reports/${report.data.id}/download`)).status).toBe(401);

    // The requester loses the report right on the account: the finished file is refused.
    const membership = await world.db.membership.findFirstOrThrow({ where: { corporateId: CORPORATES.A.id, person: { email: { startsWith: "a.finance@" } } } });
    const grant = { membershipId_accountId: { membershipId: membership.id, accountId: ACCOUNTS.A_OPERATING.id } };
    // A second request is still waiting for the worker when the right is removed.
    const waiting = await finance.post<Report>("/reports", body({ accountIds: [ACCOUNTS.A_OPERATING.id], format: "PDF" }));
    expect(waiting.status).toBe(202);
    await world.db.accountGrant.update({ where: grant, data: { canReport: false } });
    const refreshed = await world.signIn("aFinance");
    expect((await refreshed.get(`/reports/${report.data.id}/download`)).status).toBe(404);
    expect((await refreshed.post("/reports", body({ accountIds: [ACCOUNTS.A_OPERATING.id] }))).status).toBe(404);
    // Generation re-checks too: no file is produced for the waiting request.
    await drainAll(world);
    const failed = await refreshed.get<Report>(`/reports/${waiting.data.id}`);
    expect(failed.data).toMatchObject({ state: "FAILED", failureCode: "PERMISSION_DENIED", downloadable: false });
    expect(await world.db.report.count({ where: { id: waiting.data.id, storageKey: { not: null } } })).toBe(0);
    // Right restored: the earlier file is available again; an expired one is not.
    await world.db.accountGrant.update({ where: grant, data: { canReport: true } });
    const restored = await world.signIn("aFinance");
    expect((await restored.get(`/reports/${report.data.id}/download`)).status).toBe(200);
    await world.db.report.update({ where: { id: report.data.id }, data: { expiresAt: new Date(world.clock.now().getTime() - 1_000) } });
    expect((await restored.get(`/reports/${report.data.id}/download`)).status).toBe(404);
    expect((await restored.get<Report>(`/reports/${report.data.id}`)).data).toMatchObject({ state: "EXPIRED", downloadable: false });
  });

  it("exports a deposit summary that a spreadsheet cannot execute (I-41)", async () => {
    const finance = await world.as("aFinance");
    const customer = await finance.post<{ id: string }>("/customers", { code: "CUST-FX", displayName: "=HYPERLINK(1+1)", company: "+SUM(A1) Trading", mobile: "+218912340001" });
    expect(customer.status).toBe(201);
    const teller = await world.as("teller1");
    const deposit = await teller.post<{ id: string }>("/bank/deposits", { corporateId: CORPORATES.A.id, customerCode: "CUST-FX", creditAccountId: ACCOUNTS.A_OPERATING.id, branchId: BRANCHES.BR1.id, method: "CASH", amount: { currency: "LYD", minor: "150000" }, depositorReference: "SLIP-FX" });
    expect(deposit.status).toBe(202);
    await drainAll(world);
    const report = await finance.post<Report>("/reports", body({ type: "DEPOSIT_SUMMARY", accountIds: [ACCOUNTS.A_OPERATING.id] }));
    expect(report.status).toBe(202);
    await drainAll(world);
    const file = await finance.get(`/reports/${report.data.id}/download`);
    expect(file.status).toBe(200);
    const row = file.text.split("\r\n").find((line) => line.includes("CUST-FX")) as string;
    expect(row).toContain("'=HYPERLINK(1+1)");
    expect(row).not.toMatch(/,=HYPERLINK/);
    expect(row).toContain(",150.000,LYD,POSTED,");
    // Another corporate's deposits are never in the file.
    expect(file.text).not.toContain("Sabha Stores Demo");
  });

  it("raises one alert per rule and window, for the right people only (I-50, ALT-01)", async () => {
    const lowBalance = fixtureUuid("alert:A:lowBalance");
    const usage = fixtureUuid("alert:A:limitUsage");
    // Seeded thresholds are not breached by the fixture.
    expect(await evaluateAlertRules(world.deps)).toBe(0);
    expect(await world.db.notification.count({ where: { kind: { startsWith: "alert." } } })).toBe(0);

    // Make both rules breach, then let two workers evaluate at the same time, twice.
    await world.db.alertRule.update({ where: { id: lowBalance }, data: { thresholdMinor: 900_000_000n } });
    await world.db.alertRule.update({ where: { id: usage }, data: { thresholdBps: 1 } });
    const raised = await race([() => evaluateAlertRules(world.deps), () => evaluateAlertRules(world.deps)]);
    await evaluateAlertRules(world.deps);
    expect(raised.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(2);
    const alerts = await world.db.notification.findMany({ where: { kind: { startsWith: "alert." } } });
    const perRecipient = new Map<string, number>();
    for (const alert of alerts) perRecipient.set(`${alert.recipientPersonId}|${alert.kind}`, (perRecipient.get(`${alert.recipientPersonId}|${alert.kind}`) ?? 0) + 1);
    expect([...perRecipient.values()].every((count) => count === 1)).toBe(true);
    expect(await world.db.outboxEvent.count({ where: { type: "limit.threshold_reached" } })).toBe(1);

    // The treasurer sees their own alerts with safe parameters and a link they may open.
    const treasurer = await world.as("aTreasurer");
    const inbox = await treasurer.get<{ items: Note[]; unreadCount: number }>("/notifications");
    expect(inbox.status).toBe(200);
    const mine = inbox.data.items.filter((item) => item.kind.startsWith("alert."));
    expect(mine.map((item) => item.kind).sort()).toEqual(["alert.limitUsage", "alert.lowBalance"]);
    expect(mine.find((item) => item.kind === "alert.lowBalance")).toMatchObject({ read: false, linkPath: "/accounts" });
    expect(JSON.stringify(inbox.body)).not.toContain(ACCOUNTS.A_OPERATING.ref);
    // People without the alert permission, another corporate and the bank get none of them.
    for (const key of ["aMaker", "bFinance", "ops"]) expect(((await (await world.as(key)).get<{ items: Note[] }>("/notifications")).data.items ?? []).filter((item) => item.kind.startsWith("alert."))).toEqual([]);

    // Read state is per person, and nobody can touch another person's alert.
    const target = mine[0] as Note;
    expect((await (await world.as("aFinance")).post(`/notifications/${target.id}/read`)).status).toBe(404);
    const read = await treasurer.post<Note>(`/notifications/${target.id}/read`);
    expect(read.status).toBe(200);
    expect(read.data.read).toBe(true);
    const unread = await treasurer.get<{ items: Note[]; unreadCount: number }>("/notifications?unread=true");
    expect(unread.data.items.some((item) => item.id === target.id)).toBe(false);
    expect(unread.data.unreadCount).toBe(inbox.data.unreadCount - 1);

    // The next business day is a new window for the balance rule: one more alert, once.
    const before = await world.db.notification.count({ where: { kind: "alert.lowBalance" } });
    world.clock.advanceMs(24 * 3_600_000);
    await evaluateAlertRules(world.deps);
    await evaluateAlertRules(world.deps);
    const after = await world.db.notification.count({ where: { kind: "alert.lowBalance" } });
    expect(after).toBe(before * 2);
    // Rules are visible to permitted readers; an inactive rule raises nothing.
    const rules = await treasurer.get<Array<{ id: string; kind: string }>>("/alert-rules");
    expect(rules.data.map((rule) => rule.kind).sort()).toEqual(["LIMIT_USAGE", "LOW_BALANCE"]);
    expect((await (await world.as("aMaker")).get("/alert-rules")).status).toBe(403);
    await world.db.alertRule.updateMany({ data: { active: false } });
    world.clock.advanceMs(24 * 3_600_000);
    expect(await evaluateAlertRules(world.deps)).toBe(0);
  });
});
