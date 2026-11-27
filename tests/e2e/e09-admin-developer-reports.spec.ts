/**
 * E-09 Breadth journeys for the remaining workspaces, through the real screens:
 * administration (invitation approved by a second person, accepted once), developer surface
 * (token shown once and held to its scopes), reports (statement prepared by the worker and
 * downloaded by its requester only), alerts, and every branch/operations screen rendering for
 * the role it belongs to. An uncaught client error or any 5xx fails the journey.
 * Requirements: ADM-01, API-01, RPT-01, ALT-01, MOB-01, MOB-03.
 */
import { apiFrom, expect, test } from "./support/fixtures.ts";

test("E-09a administration: an invitation is proposed, approved by someone else and accepted once", async ({ actor, path, appLocale, browser, baseURL, contextOptions }) => {
  const email = `e9.${appLocale}.viewer@demo.alqarib.test`;
  const admin = await actor("aAdmin");
  await admin.goto(path("/admin/users"));
  await expect(admin.getByTestId("member-list")).toContainText("a.maker@demo.alqarib.test");
  // The administrator cannot edit their own access: there is no control for it.
  await expect(admin.getByTestId("manage-a.admin")).toHaveCount(0);

  await admin.locator("#invite-email").fill(email);
  await admin.locator("#invite-name").fill(`Invited Viewer ${appLocale.toUpperCase()} (Demo)`);
  await admin.locator("#invite-reason").fill("New analyst joins the finance team");
  await admin.getByTestId("invite-submit").click();
  await expect(admin.getByTestId("invite-sent")).toBeVisible();
  type Proposal = { status: string; target: { email: string }; approval: { id: string } | null };
  const proposals = (await apiFrom<Proposal[]>(admin, "GET", "/admin/user-proposals")).body.data ?? [];
  const approvalId = proposals.find((entry) => entry.target.email === email)?.approval?.id as string;
  expect(approvalId).toBeTruthy();
  // No link before the approval, and the proposer cannot approve.
  await admin.goto(path(`/approvals/${approvalId}`));
  await expect(admin.getByTestId("cannot-decide")).toBeVisible();

  const checker = await actor("aChecker2");
  await checker.goto(path(`/approvals/${approvalId}`));
  await expect(checker.getByTestId("admin-approval-summary")).toHaveAttribute("data-change", "INVITE");
  await expect(checker.getByTestId("change-member")).toContainText(email);
  await checker.getByTestId("approve").click();
  await expect(checker.getByTestId("decision-closed")).toBeVisible();

  await admin.goto(path("/admin/users"));
  const link = admin.getByTestId("local-inbox").locator(`[data-email="${email}"]`).getByTestId("invitation-link");
  const href = (await link.getAttribute("href")) as string;
  expect(href).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);

  // The invited person opens the link in their own browser.
  const context = await browser.newContext({ ...contextOptions, baseURL });
  const invited = await context.newPage();
  await invited.goto(href);
  await expect(invited.getByTestId("invite-intro")).toContainText(email);
  await invited.locator("#invite-password").fill("Invited-Person-Password-01");
  await invited.locator("#invite-confirm").fill("Invited-Person-Password-02");
  await expect(invited.getByTestId("invite-accept")).toBeDisabled();
  await invited.locator("#invite-confirm").fill("Invited-Person-Password-01");
  await invited.getByTestId("invite-accept").click();
  await expect(invited.getByTestId("invite-done")).toBeVisible();
  // The link is used up.
  await invited.goto(href);
  await expect(invited.getByTestId("invite-invalid")).toBeVisible();
  await invited.goto(path("/login"));
  await invited.locator("#email").fill(email);
  await invited.locator("#password").fill("Invited-Person-Password-01");
  await invited.getByTestId("sign-in").click();
  await invited.waitForURL(/\/dashboard/);
  // A viewer gets no payment or administration entry.
  await invited.goto(path("/admin/users"));
  await expect(invited.getByTestId("forbidden")).toBeVisible();
  await context.close();

  await admin.goto(path("/admin/approval-rules"));
  await expect(admin.getByTestId("unavailable")).toBeVisible();
});

test("E-09b developer: a token is shown once and held to its scopes", async ({ actor, path, appLocale }) => {
  const admin = await actor("aAdmin");
  await admin.goto(path("/developer"));
  await expect(admin.getByTestId("openapi-link")).toBeVisible();
  await admin.locator("#credential-name").fill(`E2E integration ${appLocale}`);
  await admin.getByTestId("credential-create").click();
  const shown = admin.getByTestId("new-token");
  await expect(shown).toBeVisible();
  const token = ((await shown.locator("bdi").last().textContent()) ?? "").trim();
  expect(token).toMatch(/^aqsb_/);
  // After a reload the token is gone for good; only its prefix remains.
  await admin.reload();
  await expect(admin.getByTestId("new-token")).toHaveCount(0);
  expect(await admin.content()).not.toContain(token);
  await expect(admin.getByTestId("credential-list")).toContainText(`E2E integration ${appLocale}`);

  // The token reads accounts (its only scope) and nothing else.
  // A separate client with no cookies: the token is its only credential.
  const api = await (await import("@playwright/test")).request.newContext({ baseURL: new URL(admin.url()).origin, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  expect((await api.get("/api/v1/accounts")).status()).toBe(200);
  expect((await api.get("/api/v1/payments")).status()).toBe(403);
  expect((await api.get("/api/v1/payroll/employees")).status()).toBe(403);
  expect((await api.get("/api/v1/approvals")).status()).toBe(403);
  expect((await api.get("/api/v1/bank/operations/executions")).status()).toBe(403);
  expect((await api.post("/api/v1/developer/credentials", { data: { name: "nested", scopes: ["accounts:read"], accountIds: [], expiresInDays: 1 }, headers: { "idempotency-key": crypto.randomUUID() } })).status()).toBe(403);
  // The published contract is reachable without a session.
  const openapi = await api.get("/api/v1/openapi.json");
  expect(openapi.status()).toBe(200);
  expect(((await openapi.json()) as { openapi: string }).openapi).toBe("3.1.0");
  await api.dispose();

  // A webhook to a private address is refused in the page language.
  await admin.locator("#webhook-url").fill("https://169.254.169.254/latest/meta-data");
  await admin.getByTestId("webhook-create").click();
  await expect(admin.getByTestId("problem")).toBeVisible();
  await expect(admin.getByTestId("new-secret")).toHaveCount(0);
});

test("E-09c reports, alerts and the branch and operations screens render for their roles", async ({ actor, path }) => {
  const finance = await actor("aFinance");
  await finance.goto(path("/reports"));
  await finance.getByTestId("report-request").click();
  // The worker prepares the file; the page refreshes itself until the link appears.
  const download = finance.getByTestId("report-download").filter({ visible: true }).first();
  await expect(download).toBeVisible({ timeout: 45_000 });
  const reports = (await apiFrom<Array<{ id: string; state: string }>>(finance, "GET", "/reports")).body.data ?? [];
  const ready = reports.find((report) => report.state === "READY") as { id: string };
  const file = await finance.request.get(`/api/v1/reports/${ready.id}/download`);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("text/csv");
  // Another person of the same company cannot use that report.
  const viewer = await actor("aViewer");
  expect((await viewer.request.get(`/api/v1/reports/${ready.id}/download`)).status()).toBe(404);

  for (const route of ["/notifications", "/customers", "/deposits", "/batches", "/payroll"]) {
    await finance.goto(path(route));
    await expect(finance.locator("h1").first()).toBeVisible();
  }
  const treasurer = await actor("aTreasurer");
  await treasurer.goto(path("/notifications"));
  await expect(treasurer.getByTestId("alert-rules")).toBeVisible();

  const teller = await actor("teller1");
  await teller.goto(path("/bank/teller"));
  await expect(teller.getByTestId("teller-lookup-form")).toBeVisible();
  // A teller has no operations or governance screens.
  await teller.goto(path("/bank/operations"));
  await expect(teller.getByTestId("forbidden")).toBeVisible();
  const manager = await actor("manager1");
  await manager.goto(path("/bank/branch-approvals"));
  await expect(manager.getByTestId("branch-queue")).toBeVisible();
  const ops = await actor("ops");
  for (const route of ["/bank/simulator", "/bank/operations", "/bank/reconciliation"]) {
    await ops.goto(path(route));
    await expect(ops.locator("h1").first()).toBeVisible();
  }
  await ops.goto(path("/bank/simulator"));
  await expect(ops.getByTestId("sim-cheques")).toBeVisible();
});
