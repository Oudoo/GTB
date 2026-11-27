/**
 * E-08 Collections with distinct people, through the real screens.
 *
 * Finance registers a customer and an invoice reference. A teller names the company AND the
 * customer code, confirms what the bank found and captures cash above the manager threshold.
 * Nothing is credited until a DIFFERENT branch manager approves; the worker then credits once.
 * Finance finds the posted deposit, downloads the receipt and allocates it to the invoice.
 * A cheque is acknowledged but credited only after the simulated clearing event.
 * Requirements: COL-01, COL-02, COL-03, APR-01, MOB-01, MOB-05.
 */
import { apiFrom, expect, minorOf, test, waitForState } from "./support/fixtures.ts";

const idOf = (url: string) => new URL(url).pathname.split("/").pop() as string;

test("E-08 collections: teller capture, manager approval above the threshold, posted receipt, allocation, cheque clearing", async ({ actor, path, appLocale }) => {
  const code = `E8${appLocale.toUpperCase()}`;
  const finance = await actor("aFinance");

  // --- Finance: customer and invoice reference ---------------------------------------------
  await finance.goto(path("/accounts"));
  const availableBefore = await minorOf(finance.getByTestId("account-OPERATING").getByTestId("available"));
  await finance.goto(path("/customers"));
  await finance.locator("#customer-code").fill(code);
  await finance.locator("#customer-name").fill(`Collections Demo ${code}`);
  await finance.locator("#customer-company").fill(`Collections Demo ${code} LLC`);
  await finance.locator("#customer-mobile").fill("+218912340088");
  await finance.getByTestId("customer-add").click();
  await expect(finance.getByTestId("customer-list")).toContainText(code);
  await finance.getByTestId("customer-link").filter({ hasText: code }).filter({ visible: true }).first().click();
  await finance.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
  const customerId = idOf(finance.url());
  await finance.locator("#invoice-reference").fill(`INV-${code}-1`);
  await finance.locator("#invoice-amount").fill("600.000");
  await finance.locator("#invoice-due").fill("2026-12-31");
  await finance.getByTestId("invoice-add").click();
  await expect(finance.getByTestId(`invoice-status-INV-${code}-1`).filter({ visible: true }).first()).toHaveAttribute("data-state", "OPEN");

  // --- Teller: company + code, confirm, capture --------------------------------------------
  const teller = await actor("teller1");
  const corporates = (await apiFrom<Array<{ id: string }>>(teller, "GET", "/bank/teller/corporates")).body.data ?? [];
  let corporateId = "";
  for (const corporate of corporates) {
    if ((await apiFrom(teller, "GET", `/bank/teller/customer-lookup?corporateId=${corporate.id}&customerCode=${code}`)).status === 200) corporateId = corporate.id;
  }
  expect(corporateId, "exactly the company that registered the code resolves it").toBeTruthy();
  await teller.goto(path("/bank/teller"));
  await expect(teller.getByTestId("teller-branch")).toContainText("BR1");
  // A code that does not exist for the chosen company is refused.
  await teller.locator("#teller-corporate").selectOption(corporateId);
  await teller.locator("#teller-code").fill("NO-SUCH-CODE");
  await teller.getByTestId("teller-lookup").click();
  await expect(teller.getByTestId("lookup-failed")).toBeVisible();
  await teller.locator("#teller-code").fill(code);
  await teller.getByTestId("teller-lookup").click();
  await expect(teller.getByTestId("confirm-customer")).toContainText(`Collections Demo ${code}`);
  await teller.locator("#teller-amount").fill("2500.000");
  await teller.locator("#teller-depositor").fill(`SLIP-${code}-1`);
  await teller.getByTestId("teller-capture").click();
  await teller.waitForURL(/\/bank\/deposits\/[0-9a-f-]{36}$/);
  const depositId = idOf(teller.url());
  await expect(teller.getByTestId("status").first()).toHaveAttribute("data-state", "PENDING_MANAGER");
  await expect(teller.getByTestId("deposit-receipt")).toHaveAttribute("data-kind", "PENDING_ACKNOWLEDGMENT");
  // The teller cannot decide, and nothing has been credited.
  await expect(teller.getByTestId("cannot-decide")).toBeVisible();
  await expect(teller.getByTestId("approve")).toHaveCount(0);
  await finance.goto(path("/accounts"));
  expect(await minorOf(finance.getByTestId("account-OPERATING").getByTestId("available"))).toBe(availableBefore);

  // --- A different manager of the same branch approves --------------------------------------
  const manager = await actor("manager1");
  await manager.goto(path("/bank/branch-approvals"));
  await manager.locator(`a[href$="/bank/deposits/${depositId}"]`).filter({ visible: true }).first().click();
  expect(await minorOf(manager.getByTestId("deposit-amount"))).toBe(2_500_000n);
  await expect(manager.getByTestId("deposit-customer")).toContainText(code);
  await manager.getByTestId("approve").click();
  await waitForState(manager, ["POSTED"]);
  await expect(manager.getByTestId("deposit-receipt")).toHaveAttribute("data-kind", "POSTED");

  // --- Finance: the deposit is credited once, the receipt downloads, the invoice is settled -
  await finance.goto(path("/accounts"));
  expect(await minorOf(finance.getByTestId("account-OPERATING").getByTestId("available"))).toBe(availableBefore + 2_500_000n);
  await finance.goto(path(`/deposits?customerId=${customerId}`));
  await finance.getByTestId("deposit-link").filter({ visible: true }).first().click();
  await expect(finance.getByTestId("status").first()).toHaveAttribute("data-state", "POSTED");
  await expect(finance.getByTestId("deposit-posting-reference")).toContainText(/AQ[0-9A-F]{32}D1/);
  // No branch staff name reaches the corporate.
  expect(await finance.content()).not.toContain("Teller BR1");
  const receipt = await finance.request.get(`/api/v1/deposits/${depositId}/receipt?locale=${appLocale}`);
  expect(receipt.status()).toBe(200);
  expect(receipt.headers()["content-type"]).toContain("application/pdf");
  expect((await receipt.body()).subarray(0, 4).toString()).toBe("%PDF");

  await finance.goto(path(`/customers/${customerId}`));
  await finance.locator("#allocate-amount").fill("600.000");
  await finance.getByTestId("allocate").click();
  await expect(finance.getByTestId(`invoice-status-INV-${code}-1`).filter({ visible: true }).first()).toHaveAttribute("data-state", "PAID");
  expect(await minorOf(finance.getByTestId("customer-due"))).toBe(0n);
  // More than what is left of the deposit cannot be allocated to a second invoice.
  await finance.locator("#invoice-reference").fill(`INV-${code}-2`);
  await finance.locator("#invoice-amount").fill("5000.000");
  await finance.locator("#invoice-due").fill("2026-12-31");
  await finance.getByTestId("invoice-add").click();
  await expect(finance.getByTestId(`invoice-status-INV-${code}-2`).filter({ visible: true }).first()).toHaveAttribute("data-state", "OPEN");
  await finance.locator("#allocate-amount").fill("1900.001");
  await finance.getByTestId("allocate").click();
  await expect(finance.getByTestId("problem")).toBeVisible();

  // --- A cheque is acknowledged, but credited only after clearing ---------------------------
  await teller.goto(path("/bank/teller"));
  await teller.locator("#teller-corporate").selectOption(corporateId);
  await teller.locator("#teller-code").fill(code);
  await teller.getByTestId("teller-lookup").click();
  await teller.locator("#teller-method").selectOption("CHEQUE");
  await teller.locator("#teller-amount").fill("300.000");
  await teller.locator("#teller-depositor").fill(`SLIP-${code}-2`);
  await teller.locator("#teller-cheque").fill(`CHQ-${code}-1`);
  await teller.getByTestId("teller-capture").click();
  await teller.waitForURL((url) => /\/bank\/deposits\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(depositId));
  const chequeId = idOf(teller.url());
  await expect(teller.getByTestId("status").first()).toHaveAttribute("data-state", "ACCEPTED_PENDING_CLEARING");
  await finance.goto(path("/accounts"));
  expect(await minorOf(finance.getByTestId("account-OPERATING").getByTestId("available"))).toBe(availableBefore + 2_500_000n);

  const ops = await actor("ops");
  await ops.goto(path("/bank/simulator"));
  await ops.getByTestId(`cheque-clear-${chequeId}`).click();
  await teller.goto(path(`/bank/deposits/${chequeId}`));
  await waitForState(teller, ["POSTED"]);
  await finance.goto(path("/accounts"));
  expect(await minorOf(finance.getByTestId("account-OPERATING").getByTestId("available"))).toBe(availableBefore + 2_800_000n);
});
