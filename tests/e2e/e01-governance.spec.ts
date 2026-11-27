/**
 * E-01 Bank governance (document 07): a bank admin maker proposes a signed agreement revision,
 * cannot approve it themselves, a DIFFERENT bank admin reviews the diff and approves, and the
 * corporate then reads the effective policy. Runs in English desktop and Arabic phone layout.
 * Requirements: AGR-01, AGR-02, AGR-03, GOV-002, APR-01, SEC-01.
 */
import { randomUUID } from "node:crypto";
import { apiFrom, expect, test } from "./support/fixtures.ts";

type CorporateRow = { id: string; legalName: string; state: string };
type Approval = { id: string; targetRevision: number; payloadHash: string; version: number; state: string };

test("E-01 bank governance: propose, self-approval denied, a different admin activates, corporate reads policy", async ({ actor, path }) => {
  const maker = await actor("bankMaker");
  await expect(maker.getByTestId("sandbox-indicator").first()).toBeVisible();

  const corporates = await apiFrom<CorporateRow[]>(maker, "GET", "/bank/corporates");
  expect(corporates.status).toBe(200);
  const corporate = corporates.body.data?.find((row) => row.legalName === "Qarib Trading Demo");
  expect(corporate, "Corporate A is in the maker's bank").toBeTruthy();
  const corporateId = (corporate as CorporateRow).id;
  // Another bank's corporate is not listed for this bank (SEC-01).
  expect(corporates.body.data?.some((row) => row.legalName === "Boundary Imports Demo")).toBe(false);

  await maker.goto(path("/bank/corporates"));
  await maker.getByTestId(`open-agreement-${corporateId}`).filter({ visible: true }).click();
  await expect(maker.getByTestId("agreement-state")).toBeVisible();

  // --- Maker proposes a full signed revision ---------------------------------------------
  await maker.getByTestId("propose-revision").click();
  await expect(maker.getByTestId("agreement-editor")).toBeVisible();
  // A delivered module can be enabled; a deferred one has no control at all (AGR-03).
  await expect(maker.locator('[data-module="1.1"] input[type="checkbox"]').first()).toBeChecked();
  await expect(maker.locator('[data-module="1.3"]')).toBeVisible();
  await expect(maker.locator('[data-module="1.3"] input')).toHaveCount(0);
  await expect(maker.locator('[data-module="6.1"] input')).toHaveCount(0);

  // Client validation: a revision without signature evidence or reason is not sent.
  await maker.getByTestId("propose-agreement").click();
  await expect(maker.getByTestId("editor-issues")).toBeVisible();

  await maker.locator("#evidence").fill(`SIM-SIGN-${Date.now()}`);
  await maker.locator("#change-reason").fill("Signed sandbox agreement for the end-to-end run");
  await maker.getByTestId("propose-agreement").click();
  await expect(maker.getByTestId("proposal-created")).toBeVisible();
  await expect(maker.getByTestId("pending-revision")).toBeVisible();
  // Only one open revision per agreement: the propose action is gone while one is pending.
  await expect(maker.getByTestId("propose-revision")).toHaveCount(0);

  // --- The maker cannot approve their own proposal: in the UI … --------------------------
  await maker.getByTestId("open-pending-approval").click();
  await expect(maker.getByTestId("cannot-decide")).toBeVisible();
  await expect(maker.locator('[data-eligibility="OWN_PROPOSAL"]')).toBeVisible();
  await expect(maker.getByTestId("approve")).toHaveCount(0);

  // --- … and at the API, with a hand-built request ---------------------------------------
  const approvalId = new URL(maker.url()).pathname.split("/").pop() as string;
  const approval = await apiFrom<Approval>(maker, "GET", `/approvals/${approvalId}`);
  expect(approval.status).toBe(200);
  const pending = approval.body.data as Approval;
  const forged = await apiFrom(maker, "POST", `/approvals/${approvalId}/approve`, {
    body: { proposalVersion: pending.targetRevision, proposalHash: pending.payloadHash },
    idempotencyKey: randomUUID(),
    ifMatch: pending.version,
  });
  expect(forged.status).toBe(403);
  expect(forged.body.code).toBe("SELF_APPROVAL_FORBIDDEN");
  const still = await apiFrom<Approval>(maker, "GET", `/approvals/${approvalId}`);
  expect(still.body.data?.state).toBe("PENDING");

  // --- A different bank admin reviews the diff and approves ------------------------------
  const checker = await actor("bankChecker");
  await checker.goto(path(`/bank/approvals/${approvalId}`));
  await expect(checker.getByTestId("decision-form")).toBeVisible();
  await expect(checker.getByTestId("immutable-note")).toBeVisible();
  await checker.locator('a[href*="/bank/agreement-versions/"]').click();
  await expect(checker.getByTestId("terms-diff")).toBeVisible();
  await expect(checker.getByTestId("terms-view")).toBeVisible();
  await checker.getByTestId("open-approval").click();
  await checker.getByTestId("approve").click();
  await expect(checker.getByTestId("decision-closed")).toBeVisible();

  // The maker's screen shows the decided state after a reload; nothing is cached client-side.
  await maker.goto(path(`/bank/corporates/${corporateId}/agreement`));
  await expect(maker.getByTestId("agreement-state").getByTestId("status")).toHaveAttribute("data-state", "ACTIVE");
  await expect(maker.getByTestId("pending-revision")).toHaveCount(0);

  // --- The corporate reads the effective policy and cannot change it ----------------------
  const viewer = await actor("aViewer");
  await viewer.goto(path("/agreement"));
  await expect(viewer.getByTestId("agreement-state").getByTestId("status")).toHaveAttribute("data-state", "ACTIVE");
  await expect(viewer.locator('[data-testid="terms-view"] [data-module="1.1"]')).toBeVisible();
  // Bank operations do not exist for a corporate session (SEC-01).
  const crossWorkspace = await apiFrom(viewer, "GET", "/bank/corporates");
  expect(crossWorkspace.status).toBe(404);
  const proposeAsCorporate = await apiFrom(viewer, "POST", `/bank/corporates/${corporateId}/suspend`, {
    body: { reason: "attempt from a corporate session" },
    idempotencyKey: randomUUID(),
    ifMatch: 1,
  });
  expect(proposeAsCorporate.status).toBe(404);
});
