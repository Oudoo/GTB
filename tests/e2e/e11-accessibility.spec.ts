/**
 * E-11 Accessibility, keyboard and direction (document 07; MOB-01, MOB-03, document 05).
 *
 *  - an automated axe scan (WCAG 2.0/2.1 A and AA rules) of the core screens of every
 *    workspace, in the layout and language of the project (English desktop, Arabic 390 px):
 *    zero serious or critical findings;
 *  - the document language and direction follow the locale; amounts and references stay
 *    left-to-right inside right-to-left pages;
 *  - sign-in and an approval are completed with the keyboard alone.
 *
 * This is Chromium emulation, not a screen-reader session and not a physical device.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { apiFrom, expect, test } from "./support/fixtures.ts";
import { ACTORS, E2E_PASSWORD, EMAIL_DOMAIN, type ActorKey } from "./support/constants.ts";

const SCREENS: Array<[ActorKey, string[]]> = [
  ["aMaker", ["/dashboard", "/accounts", "/payments", "/payments/new", "/beneficiaries", "/limits", "/batches", "/batches/new", "/agreement", "/products", "/more"]],
  ["aChecker1", ["/approvals", "/payroll", "/notifications"]],
  ["aPayroll", ["/payroll", "/payroll/new", "/payroll/employees"]],
  ["aFinance", ["/customers", "/deposits", "/reports"]],
  ["aAdmin", ["/admin/users", "/developer", "/audit"]],
  ["bankMaker", ["/bank", "/bank/corporates", "/bank/rail-parameters"]],
  ["bankChecker", ["/bank/approvals"]],
  ["ops", ["/bank/operations", "/bank/reconciliation", "/bank/simulator"]],
  ["teller1", ["/bank/teller"]],
  ["manager1", ["/bank/branch-approvals"]],
  ["compliance", ["/bank/audit"]],
];

type Finding = { screen: string; rule: string; impact: string | null | undefined; nodes: number; example: string };
/** Lesser findings (moderate, minor) are counted and reported, not hidden. */
const lesser = new Map<string, number>();

async function scan(page: Page, screen: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  // The scan really examined the page: a good number of rules applied and passed.
  expect(results.passes.length, `axe rules that ran on ${screen}`).toBeGreaterThan(10);
  for (const violation of results.violations) {
    if (violation.impact !== "serious" && violation.impact !== "critical") lesser.set(violation.id, (lesser.get(violation.id) ?? 0) + violation.nodes.length);
  }
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ screen, rule: violation.id, impact: violation.impact, nodes: violation.nodes.length, example: (violation.nodes[0]?.target ?? []).join(" ") }));
}

test("E-11a no serious or critical accessibility finding on the core screens", async ({ actor, path, page, appLocale }) => {
  test.setTimeout(240_000);
  const findings: Finding[] = [];
  let scanned = 0;

  await page.goto(path("/login"));
  await expect(page.locator("#email")).toBeVisible();
  findings.push(...(await scan(page, "/login")));
  scanned += 1;

  for (const [key, routes] of SCREENS) {
    const person = await actor(key);
    for (const route of routes) {
      await person.goto(path(route));
      await expect(person.locator("main#main")).toBeVisible();
      // The page is in the language and direction of its locale.
      await expect(person.locator("html")).toHaveAttribute("lang", appLocale);
      await expect(person.locator("html")).toHaveAttribute("dir", appLocale === "ar" ? "rtl" : "ltr");
      findings.push(...(await scan(person, `${key} ${route}`)));
      scanned += 1;
    }
  }
  expect(scanned).toBe(1 + SCREENS.reduce((sum, [, routes]) => sum + routes.length, 0));
  test.info().annotations.push({ type: "axe", description: `${scanned} screens scanned; moderate or minor findings: ${lesser.size === 0 ? "none" : [...lesser].map(([rule, nodes]) => `${rule} ×${nodes}`).join(", ")}` });
  expect(findings, `serious or critical findings:\n${findings.map((finding) => `${finding.screen}: ${finding.rule} (${finding.impact}, ${finding.nodes} nodes) ${finding.example}`).join("\n")}`).toEqual([]);
});

test("E-11b amounts and references keep their direction inside right-to-left pages", async ({ actor, path, appLocale }) => {
  const maker = await actor("aMaker");
  await maker.goto(path("/accounts"));
  const amount = maker.getByTestId("account-OPERATING").getByTestId("available").locator("[data-money]").first();
  await expect(amount).toBeVisible();
  // Digits are never mirrored: the amount is isolated and laid out left-to-right in both languages.
  expect(await amount.evaluate((node) => getComputedStyle(node).direction)).toBe("ltr");
  expect(await amount.evaluate((node) => node.tagName.toLowerCase() === "bdi" || node.closest("bdi") !== null || getComputedStyle(node).unicodeBidi.includes("isolate"))).toBe(true);
  expect(await maker.locator("body").evaluate((node) => getComputedStyle(node).direction)).toBe(appLocale === "ar" ? "rtl" : "ltr");
  // Western digits in both languages, so a figure reads the same on a statement and on screen.
  expect((await amount.innerText()).replace(/[\s ‎‏⁦-⁩]/g, "")).toMatch(/^[A-Z]{0,3}[\d,]+\.\d{3}[A-Z]{0,3}$/);
});

test("E-11c sign-in and an approval are completed with the keyboard alone", async ({ actor, path, browser, contextOptions, baseURL }) => {
  // A maker prepares a payment that needs one approval (through the API, to keep this short).
  const maker = await actor("aMaker");
  type Account = { id: string; kind: string };
  type Beneficiary = { id: string; displayName: string };
  const accounts = (await apiFrom<Account[]>(maker, "GET", "/accounts")).body.data ?? [];
  const beneficiaries = (await apiFrom<Beneficiary[]>(maker, "GET", "/beneficiaries")).body.data ?? [];
  const supplier = beneficiaries.find((entry) => entry.displayName === "Tripoli Office Supplies Demo") as Beneficiary;
  const created = await apiFrom<{ id: string; version: number }>(maker, "POST", "/payments", {
    idempotencyKey: crypto.randomUUID(),
    body: {
      moduleId: "1.1",
      transactionType: "INSTANT_ACCOUNT_CREDIT",
      sourceAccountId: (accounts.find((entry) => entry.kind === "OPERATING") as Account).id,
      beneficiaryId: supplier.id,
      amount: { currency: "LYD", minor: "15000" },
      purpose: "Keyboard approval check",
      clientReference: `E11-${Date.now()}`,
      execution: { mode: "IMMEDIATE" },
    },
  });
  expect(created.status).toBe(201);
  const submitted = await apiFrom<{ approval: { id: string } }>(maker, "POST", `/payments/${created.body.data?.id}/submit`, { body: {}, idempotencyKey: crypto.randomUUID(), ifMatch: created.body.data?.version as number });
  expect(submitted.status).toBe(202);
  const approvalId = submitted.body.data?.approval.id as string;

  // The checker never touches a pointer: Tab, typing and Enter only.
  const context = await browser.newContext({ ...contextOptions, baseURL });
  const checker = await context.newPage();
  await checker.goto(path("/login"));
  await expect(checker.locator("#email")).toBeVisible();
  const tabTo = async (selector: string, limit = 120) => {
    for (let presses = 0; presses < limit; presses += 1) {
      if (await checker.evaluate((target) => document.activeElement?.matches(target) ?? false, selector)) return;
      await checker.keyboard.press("Tab");
    }
    throw new Error(`keyboard focus never reached ${selector}`);
  };
  await tabTo("#email");
  await checker.keyboard.type(`${ACTORS.aChecker2}@${EMAIL_DOMAIN}`);
  await tabTo("#password");
  await checker.keyboard.type(E2E_PASSWORD);
  await checker.keyboard.press("Enter");
  await checker.waitForURL((url) => /\/dashboard(\/|$)/.test(url.pathname));

  await checker.goto(path(`/approvals/${approvalId}`));
  await expect(checker.getByTestId("approve")).toBeVisible();
  // The first stop is the skip link, and it leads to the main content.
  await checker.keyboard.press("Tab");
  expect(await checker.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("#main");
  await checker.keyboard.press("Enter");
  expect(await checker.evaluate(() => document.activeElement?.id ?? "")).toBe("main");
  await tabTo('[data-testid="approve"]');
  // Whatever has focus shows it.
  const focusStyle = await checker.evaluate(() => {
    const style = getComputedStyle(document.activeElement as Element);
    return { outline: style.outlineStyle, width: style.outlineWidth, shadow: style.boxShadow };
  });
  expect(focusStyle.outline !== "none" && focusStyle.width !== "0px" ? "outline" : focusStyle.shadow !== "none" ? "shadow" : "none").not.toBe("none");
  await checker.keyboard.press("Enter");
  await expect(checker.getByTestId("decision-closed")).toBeVisible();
  const decided = await apiFrom<{ state: string; approvalsCount: number }>(checker, "GET", `/approvals/${approvalId}`);
  expect(decided.body.data).toMatchObject({ state: "APPROVED", approvalsCount: 1 });
  await context.close();
});
