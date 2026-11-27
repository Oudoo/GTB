/**
 * E-02 Domestic payment with distinct people (document 07; the first major demonstration).
 *
 * A corporate maker submits LYD 125.000 to a name-matched supplier from the documented fixture.
 * A DIFFERENT checker reviews the exact recipient, amount and fee, then approves. The worker —
 * a separate process — settles through the simulated core. The test then proves:
 *   - the source balance fell by exactly LYD 125.500 (principal + fee);
 *   - outgoing limit usage rose by exactly LYD 125.000 (fees do not count);
 *   - the statement, the timeline and the audit trail refer to the same instruction;
 *   - repeating the approval request with the same identity produces no second effect.
 * Runs in English desktop and Arabic phone layout (RTL).
 * Requirements: PAY-01, PAY-02, APR-01, APR-02, LIM-02, LIM-04, EVT-01, SEC-05, MOB-04.
 */
import { apiFrom, expect, minorOf, test, waitForState } from "./support/fixtures.ts";

const PRINCIPAL = 125_000n;
const FEE = 500n;

type Account = { id: string; kind: string };
type Beneficiary = { id: string; displayName: string };
type UsageRow = { level: string; moduleId: string | null; period: string; consumed: { minor: string } | null; reserved: { minor: string } | null };
type Usage = { rows: UsageRow[] };
type PaymentDetail = { id: string; reference: string; state: string; executionReference: string | null; approval: { id: string; approvalsCount: number; state: string } | null };
type StatementLine = { kind: string; reference: string | null; signedMinor: string };

const consumed = (usage: Usage, level: string, moduleId: string | null, period: string): bigint =>
  BigInt(usage.rows.find((row) => row.level === level && row.moduleId === moduleId && row.period === period)?.consumed?.minor ?? "0");

test("E-02 domestic payment: maker submits, a different checker approves, the worker settles exactly once", async ({ actor, path }) => {
  const maker = await actor("aMaker");

  // --- Starting position, read from the bank (never assumed) -----------------------------
  const accounts = await apiFrom<Account[]>(maker, "GET", "/accounts");
  const operating = accounts.body.data?.find((account) => account.kind === "OPERATING") as Account;
  const beneficiaries = await apiFrom<Beneficiary[]>(maker, "GET", "/beneficiaries");
  const supplier = beneficiaries.body.data?.find((entry) => entry.displayName === "Tripoli Office Supplies Demo") as Beneficiary;
  expect(operating && supplier, "fixture account and beneficiary exist").toBeTruthy();

  await maker.goto(path("/accounts"));
  const availableBefore = await minorOf(maker.getByTestId("account-OPERATING").getByTestId("available"));
  const usageBefore = (await apiFrom<Usage>(maker, "GET", "/limits/usage")).body.data as Usage;

  // --- Maker: five-step proposal ----------------------------------------------------------
  await maker.goto(path("/payments/new"));
  await maker.locator(`input[name="source"][value="${operating.id}"]`).check();
  await maker.getByTestId("wizard-next").click();
  await maker.locator("#beneficiary").selectOption(supplier.id);
  await expect(maker.getByTestId("recipient-check").getByTestId("status")).toHaveAttribute("data-state", "MATCHED");
  await maker.getByTestId("wizard-next").click();

  // Client-side validation in the page language before anything is sent.
  await maker.getByTestId("wizard-next").click();
  await expect(maker.locator("#amount-error")).toBeVisible();
  await maker.locator("#amount").fill("125.000");
  await maker.locator("#purpose").fill("Office supplies invoice INV-2026-1101");
  await maker.getByTestId("wizard-next").click();

  const review = maker.getByTestId("payment-review");
  await expect(review).toBeVisible();
  expect(await minorOf(maker.getByTestId("preview-principal"))).toBe(PRINCIPAL);
  expect(await minorOf(maker.getByTestId("preview-fee"))).toBe(FEE);
  expect(await minorOf(maker.getByTestId("preview-total"))).toBe(PRINCIPAL + FEE);
  await expect(maker.getByTestId("estimate-note")).toBeVisible();
  await maker.getByTestId("wizard-next").click();
  await maker.getByTestId("submit-for-approval").click();
  await maker.waitForURL(/\/payments\/[0-9a-f-]{36}$/);
  const paymentId = new URL(maker.url()).pathname.split("/").pop() as string;
  await expect(maker.getByTestId("status").first()).toHaveAttribute("data-state", "PENDING_APPROVAL");

  // Nothing has moved yet: a proposal is not a debit.
  const pendingDetail = (await apiFrom<PaymentDetail>(maker, "GET", `/payments/${paymentId}`)).body.data as PaymentDetail;
  const approvalId = pendingDetail.approval?.id as string;
  expect(approvalId).toBeTruthy();

  // --- The maker cannot approve their own proposal ----------------------------------------
  await maker.goto(path(`/approvals/${approvalId}`));
  await expect(maker.getByTestId("cannot-decide")).toBeVisible();
  await expect(maker.getByTestId("approve")).toHaveCount(0);

  // --- A different person reviews the exact recipient, amount and fee, then approves -----
  const checker = await actor("aChecker1");
  await checker.goto(path("/approvals"));
  await checker.locator(`a[href$="/approvals/${approvalId}"]`).filter({ visible: true }).first().click();
  await expect(checker.getByTestId("decision-form")).toBeVisible();
  expect(await minorOf(checker.getByTestId("review-amount"))).toBe(PRINCIPAL);
  expect(await minorOf(checker.getByTestId("review-fee"))).toBe(FEE);
  expect(await minorOf(checker.getByTestId("review-total"))).toBe(PRINCIPAL + FEE);
  await expect(checker.getByTestId("review-recipient")).toContainText("Tripoli Office Supplies Demo");
  await expect(checker.getByTestId("review-recipient")).toContainText("0001");

  // Capture the exact request the Approve button sends so it can be repeated verbatim.
  let sent: { headers: Record<string, string>; body: string } | null = null;
  await checker.route(`**/api/v1/approvals/${approvalId}/approve`, async (route) => {
    sent = { headers: route.request().headers(), body: route.request().postData() ?? "" };
    await route.continue();
  });
  await checker.getByTestId("approve").click();
  await expect(checker.getByTestId("decision-closed")).toBeVisible();
  await checker.unroute(`**/api/v1/approvals/${approvalId}/approve`);
  expect(sent, "the approve request was observed").not.toBeNull();
  const captured = sent as unknown as { headers: Record<string, string>; body: string };
  expect(captured.headers["idempotency-key"]).toBeTruthy();
  expect(captured.headers["if-match"]).toBeTruthy();

  // --- The worker settles (another OS process) --------------------------------------------
  await maker.goto(path(`/payments/${paymentId}`));
  await waitForState(maker, ["SETTLED"]);
  const settled = (await apiFrom<PaymentDetail>(maker, "GET", `/payments/${paymentId}`)).body.data as PaymentDetail;
  expect(settled.state).toBe("SETTLED");
  const executionReference = settled.executionReference as string;
  expect(executionReference).toMatch(/^AQ[0-9A-F]{32}A1$/);
  await expect(maker.getByTestId("execution-reference")).toContainText(executionReference);
  await expect(maker.getByTestId("timeline")).toContainText(executionReference);

  // --- Repeating the same approval request has no second effect ---------------------------
  const replay = await checker.evaluate(
    async ({ route, headers, body }) => {
      const response = await fetch(route, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-alqarib-request": "1",
          "idempotency-key": headers["idempotency-key"] as string,
          "if-match": headers["if-match"] as string,
        },
        body,
      });
      return { status: response.status, replayed: response.headers.get("idempotency-replayed"), body: await response.json() };
    },
    { route: `/api/v1/approvals/${approvalId}/approve`, headers: captured.headers, body: captured.body },
  );
  expect(replay.status).toBe(200);
  const afterReplay = (await apiFrom<PaymentDetail>(maker, "GET", `/payments/${paymentId}`)).body.data as PaymentDetail;
  expect(afterReplay.approval?.approvalsCount).toBe(1);
  expect(afterReplay.state).toBe("SETTLED");

  // --- Balance: down by exactly principal + fee -------------------------------------------
  await maker.goto(path("/accounts"));
  const availableAfter = await minorOf(maker.getByTestId("account-OPERATING").getByTestId("available"));
  expect(availableBefore - availableAfter).toBe(PRINCIPAL + FEE);

  // --- Limits: usage up by exactly the principal at every level; nothing left reserved ----
  const usageAfter = (await apiFrom<Usage>(maker, "GET", "/limits/usage")).body.data as Usage;
  for (const [level, moduleId, period] of [
    ["CORPORATE", null, "DAY"],
    ["CORPORATE", null, "MONTH"],
    ["MODULE", "1.1", "DAY"],
    ["MODULE", "1.1", "MONTH"],
    ["USER", null, "DAY"],
  ] as const) {
    expect(consumed(usageAfter, level, moduleId, period) - consumed(usageBefore, level, moduleId, period), `${level} ${moduleId ?? ""} ${period}`).toBe(PRINCIPAL);
  }
  expect(usageAfter.rows.every((row) => row.reserved === null || row.reserved.minor === "0")).toBe(true);
  await maker.goto(path("/limits"));
  expect(await minorOf(maker.locator('[data-usage="CORPORATE::DAY"]').filter({ visible: true }))).toBe(consumed(usageAfter, "CORPORATE", null, "DAY"));

  // --- Statement: exactly one principal debit and one fee debit under that reference ------
  const statement = await apiFrom<{ lines: StatementLine[] }>(maker, "GET", `/accounts/${operating.id}/statements?reference=${executionReference}`);
  const lines = (statement.body.data?.lines ?? []).filter((line) => line.reference === executionReference);
  expect(lines.map((line) => `${line.kind}:${line.signedMinor}`).sort()).toEqual([`FEE:-${FEE}`, `PAYMENT:-${PRINCIPAL}`]);
  await maker.goto(path(`/accounts/${operating.id}?reference=${executionReference}`));
  await expect(maker.locator(`[data-line="PAYMENT"][data-reference="${executionReference}"]`).filter({ visible: true })).toHaveCount(1);
  await expect(maker.locator(`[data-line="FEE"][data-reference="${executionReference}"]`).filter({ visible: true })).toHaveCount(1);

  // --- Audit: the same instruction, found by payment reference AND by execution reference -
  const auditor = await actor("aAdmin");
  const expected = ["payment.created", "payment.submitted", "approval.approved", "payment.execution.processing", "payment.execution.submitted", "payment.execution.settled"];
  for (const term of [settled.reference, executionReference]) {
    await auditor.goto(path(`/audit?q=${encodeURIComponent(term)}`));
    const events = auditor.getByTestId("audit-events");
    for (const action of expected) {
      await expect(events.locator(`[data-action="${action}"]`).filter({ visible: true }), `${action} found by ${term}`).toHaveCount(1);
    }
    await expect(events.locator(`[data-target="${paymentId}"]`).filter({ visible: true })).toHaveCount(expected.length);
    await expect(events.locator('[data-field="reference"]').filter({ visible: true, hasText: executionReference }).first()).toBeVisible();
  }
  // The audit trail names two different people for proposal and approval.
  const audit = await apiFrom<Array<{ action: string; actor: { name: string | null } }>>(auditor, "GET", `/audit-events?q=${encodeURIComponent(settled.reference)}`);
  const who = (action: string) => audit.body.data?.find((event) => event.action === action)?.actor.name;
  expect(who("payment.submitted")).toBeTruthy();
  expect(who("approval.approved")).toBeTruthy();
  expect(who("payment.submitted")).not.toBe(who("approval.approved"));
});
