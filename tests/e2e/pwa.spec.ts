/**
 * PWA and mobile checks from document 12 (P-01, P-04..P-08, P-10, P-11) against the PRODUCTION
 * build with the real service worker.
 *
 * These are Chromium results — desktop and phone EMULATION. They are not physical-device
 * results: installation on Android Chrome and iOS Safari (P-02, P-03) and other engines (P-12)
 * are recorded separately as pending in docs/audit/IMPLEMENTATION-STATUS.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { apiFrom, expect, test } from "./support/fixtures.ts";

test.use({ serviceWorkers: "allow" });

const ALLOWLIST = (JSON.parse(readFileSync(new URL("../../src/pwa/precache-allowlist.json", import.meta.url), "utf8")) as string[]).sort();

/** Wait until the page is controlled by the active service worker. */
async function controlled(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 20_000 }).toBe(true);
}

test("P-01 manifest: stable identity, standalone display, icons present, no sensitive launch parameters", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  const manifest = (await response.json()) as { id: string; name: string; short_name: string; start_url: string; scope: string; display: string; icons: Array<{ src: string; sizes: string; purpose?: string; type: string }> };
  expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
  expect(manifest.name).toContain("Sandbox");
  expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  for (const value of [manifest.id, manifest.start_url, manifest.scope]) expect(value).not.toMatch(/[?#]|token|corporate|tenant/i);
  expect(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose ?? "any"}`).sort()).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
  for (const icon of manifest.icons) {
    const file = await request.get(icon.src);
    expect(file.status(), icon.src).toBe(200);
    expect(file.headers()["content-type"]).toContain("image/png");
  }
  // The worker script itself is never cached by the browser HTTP cache and is fully built.
  const worker = await request.get("/sw.js");
  expect(worker.status()).toBe(200);
  const source = await worker.text();
  expect(source).not.toMatch(/__BUILD_ID__|__PRECACHE__/);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // It can skip waiting only when the page asks after the person confirmed (PWA-07).
  expect(code.match(/skipWaiting\(\)/g)).toHaveLength(1);
  expect(code).toContain('data.type === "SKIP_WAITING"');
  // No background sync, no IndexedDB, no write of a fetched response into a cache.
  expect(code).not.toMatch(/addEventListener\("(sync|periodicsync|push)"|indexedDB|\.put\(|\.add\(/);
});

test("P-04, P-11 the worker caches only the public allowlist; banking requests are network-only and nothing sensitive is stored", async ({ actor, path }) => {
  const page = await actor("aMaker");
  await page.goto(path("/dashboard"));
  await controlled(page);
  // Use the application the way a person would, with the worker in control.
  for (const route of ["/accounts", "/payments", "/approvals", "/batches", "/limits"]) {
    await page.goto(path(route));
    await expect(page.locator("h1").first()).toBeVisible();
  }
  expect((await apiFrom(page, "GET", "/accounts")).status).toBe(200);
  expect((await apiFrom(page, "GET", "/payments")).status).toBe(200);

  const storage = await page.evaluate(async () => {
    const names = await caches.keys();
    const entries: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) entries.push(new URL(request.url).pathname + new URL(request.url).search);
    }
    const databases = "databases" in indexedDB ? (await indexedDB.databases()).map((database) => database.name ?? "") : [];
    return { names, entries: entries.sort(), databases, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), cookies: document.cookie };
  });
  expect(storage.names).toHaveLength(1);
  expect(storage.names[0]).toMatch(/^alqarib-public-/);
  expect(storage.entries).toEqual(ALLOWLIST);
  expect(storage.databases).toEqual([]);
  // No banking data, identity or token in script-readable storage; the session cookie is HttpOnly.
  for (const dump of [storage.local, storage.session, storage.cookies]) {
    expect(dump).not.toMatch(/DEMO-LY|balance|minor|payment|token|session|a\.maker/i);
  }
  // No response of an API, a page or an RSC payload is in any cache under any key.
  const cachedSensitive = await page.evaluate(async (routes) => {
    const hits: string[] = [];
    for (const route of routes) if (await caches.match(route, { ignoreSearch: true, ignoreVary: true })) hits.push(route);
    return hits;
  }, ["/api/v1/accounts", "/api/v1/payments", "/api/v1/session", path("/accounts"), path("/dashboard"), path("/payments")]);
  expect(cachedSensitive).toEqual([]);

  // Offline: a navigation shows the generic offline document — nothing about this person.
  await page.context().setOffline(true);
  await page.goto(path("/accounts"), { waitUntil: "domcontentloaded" });
  expect(await page.title()).toContain("Offline");
  const offlineHtml = await page.content();
  for (const secret of ["DEMO-LY", "Mona Maker", "a.maker", "LYD"]) expect(offlineHtml).not.toContain(secret);
  // An API call fails outright: there is no cached banking answer and no queue.
  const offlineCall = await page.evaluate(() =>
    fetch("/api/v1/accounts", { credentials: "same-origin" }).then(
      (response) => `status:${response.status}`,
      () => "network-error",
    ),
  );
  expect(offlineCall).toBe("network-error");
  const offlineWrite = await page.evaluate(() =>
    fetch("/api/v1/payments", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-alqarib-request": "1", "idempotency-key": crypto.randomUUID() }, body: "{}" }).then(
      (response) => `status:${response.status}`,
      () => "network-error",
    ),
  );
  expect(offlineWrite).toBe("network-error");
  await page.context().setOffline(false);
  await page.goto(path("/accounts"));
  await expect(page.getByTestId("account-OPERATING")).toBeVisible();
  // Nothing was queued while offline: no payment draft appeared.
  const after = await page.evaluate(async () => (await caches.keys()).length);
  expect(after).toBe(1);
});

test("P-05 losing the connection on an open page masks financial content and disables actions", async ({ actor, path }) => {
  const page = await actor("aMaker");
  await page.goto(path("/accounts"));
  await expect(page.getByTestId("account-OPERATING")).toBeVisible();
  await page.context().setOffline(true);
  const mask = page.getByTestId("connection-mask");
  await expect(mask).toBeVisible({ timeout: 20_000 });
  await expect(mask).toHaveAttribute("data-state", "offline");
  // The balances are no longer shown as current and the subtree takes no input.
  await expect(page.locator('[data-masked="true"]')).toHaveCount(1);
  expect(await page.locator('[data-masked="true"]').evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await expect(page.getByTestId("account-OPERATING")).not.toBeVisible();
  // It comes back only after a verified round-trip to the bank.
  await page.context().setOffline(false);
  await expect(mask).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("account-OPERATING")).toBeVisible();
});

test("P-06 a lost response after the bank decided is checked, not repeated: one approval, one debit", async ({ actor, path }) => {
  const maker = await actor("aMaker");
  type Account = { id: string; kind: string };
  type Balance = { available: { minor: string } };
  const accounts = (await apiFrom<Account[]>(maker, "GET", "/accounts")).body.data ?? [];
  const operating = accounts.find((account) => account.kind === "OPERATING") as Account;
  const beneficiaries = (await apiFrom<Array<{ id: string; displayName: string }>>(maker, "GET", "/beneficiaries")).body.data ?? [];
  const supplier = beneficiaries.find((entry) => entry.displayName === "Tripoli Office Supplies Demo") as { id: string };
  const before = BigInt(((await apiFrom<Balance>(maker, "GET", `/accounts/${operating.id}/balance`)).body.data as Balance).available.minor);
  const draft = await apiFrom<{ id: string; version: number }>(maker, "POST", "/payments", {
    body: { moduleId: "1.1", transactionType: "INSTANT_ACCOUNT_CREDIT", sourceAccountId: operating.id, beneficiaryId: supplier.id, amount: { currency: "LYD", minor: "75000" }, purpose: "Lost response check", clientReference: `P06-${Date.now()}`, execution: { mode: "IMMEDIATE" } },
    idempotencyKey: crypto.randomUUID(),
  });
  expect(draft.status).toBe(201);
  const payment = draft.body.data as { id: string; version: number };
  const submitted = await apiFrom<{ approval: { id: string } }>(maker, "POST", `/payments/${payment.id}/submit`, { body: {}, ifMatch: payment.version, idempotencyKey: crypto.randomUUID() });
  expect(submitted.status).toBe(202);
  const approvalId = (submitted.body.data as { approval: { id: string } }).approval.id;

  const checker = await actor("aChecker1");
  await checker.goto(path(`/approvals/${approvalId}`));
  await expect(checker.getByTestId("decision-form")).toBeVisible();
  // The bank receives and decides the approval; the answer never reaches the browser.
  let calls = 0;
  await checker.route(`**/api/v1/approvals/${approvalId}/approve`, async (route) => {
    calls += 1;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await checker.getByTestId("approve").click();
  const problem = checker.getByTestId("problem");
  await expect(problem).toBeVisible();
  await expect(problem.locator("[data-code]")).toHaveAttribute("data-code", "NETWORK");
  // The same action is not offered again blindly.
  await expect(checker.getByTestId("approve")).toBeDisabled();
  await checker.unroute(`**/api/v1/approvals/${approvalId}/approve`);
  // Checking the server shows the decision that was already made.
  await problem.getByRole("button").click();
  await expect(checker.getByTestId("decision-closed")).toBeVisible();
  expect(calls).toBe(1);

  await maker.goto(path(`/payments/${payment.id}`));
  await expect.poll(async () => ((await apiFrom<{ state: string }>(maker, "GET", `/payments/${payment.id}`)).body.data as { state: string }).state, { timeout: 45_000 }).toBe("SETTLED");
  const after = BigInt(((await apiFrom<Balance>(maker, "GET", `/accounts/${operating.id}/balance`)).body.data as Balance).available.minor);
  // LYD 75.000 and one LYD 0.500 fee, exactly once.
  expect(before - after).toBe(75_500n);
  const approval = (await apiFrom<{ approvalsCount: number; votes: unknown[] }>(checker, "GET", `/approvals/${approvalId}`)).body.data as { approvalsCount: number; votes: unknown[] };
  expect(approval.approvalsCount).toBe(1);
  expect(approval.votes).toHaveLength(1);
});

test("P-07 signing out ends every tab; Back does not bring a protected page back", async ({ actor, path }) => {
  const first = await actor("aMaker");
  await first.goto(path("/accounts"));
  await expect(first.getByTestId("account-OPERATING")).toBeVisible();
  const second = await first.context().newPage();
  await second.goto(path("/payments"));
  await expect(second.locator("h1").first()).toBeVisible();

  // Sign out in the second tab through the server (the same call the Sign out control makes).
  const signedOut = await second.evaluate(() => fetch("/api/v1/session/logout", { method: "POST", credentials: "same-origin", headers: { "x-alqarib-request": "1", "content-type": "application/json" }, body: "{}" }).then((response) => response.status));
  expect(signedOut).toBe(200);
  // The first tab was showing balances. Returning to it re-checks the session before anything is trusted.
  await first.bringToFront();
  await first.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect
    .poll(async () => /\/login/.test(first.url()) || (await first.getByTestId("connection-mask").count()) > 0, { timeout: 30_000 })
    .toBe(true);
  await expect(first.getByTestId("account-OPERATING")).not.toBeVisible();
  // The API no longer knows this browser.
  expect((await apiFrom(first, "GET", "/accounts")).status).toBe(401);
  // A direct navigation and Back both end at sign-in, not at cached account data.
  await first.goto(path("/accounts"));
  await first.waitForURL(/\/login/);
  await first.goBack();
  // Once the restored page has re-checked the session, no account data is left in the document.
  // Once the restored page has re-checked the session, no account or amount is left in the document.
  await expect(first.getByTestId("account-OPERATING")).toHaveCount(0, { timeout: 20_000 });
  await expect(first.locator("[data-money]")).toHaveCount(0);
  await second.close();
});

test("P-08 a new version waits for the person: no forced reload under an open form, then a clean switch", async ({ actor, path }) => {
  const workerFile = new URL("../../public/sw.js", import.meta.url);
  const original = readFileSync(workerFile, "utf8");
  const currentBuild = /const BUILD_ID = "([^"]+)";/.exec(original)?.[1] as string;
  expect(currentBuild).toBeTruthy();
  const nextBuild = `${currentBuild}-next`;
  type Version = { buildId: string; cacheName: string };
  const versionOf = (page: import("@playwright/test").Page) =>
    page.evaluate(
      () =>
        new Promise<Version>((resolve, reject) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => resolve(event.data as Version);
          const controller = navigator.serviceWorker.controller;
          if (!controller) reject(new Error("no controlling worker"));
          else controller.postMessage({ type: "GET_VERSION" }, [channel.port2]);
        }),
    );
  const ownCaches = (page: import("@playwright/test").Page) => page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith("alqarib-public-")).sort());

  const maker = await actor("aMaker");
  try {
    // A payment is being written when the new version is deployed.
    await maker.goto(path("/payments/new"));
    await controlled(maker);
    expect(await versionOf(maker)).toMatchObject({ buildId: currentBuild });
    await maker.locator('input[name="source"]').first().check();
    await maker.getByTestId("wizard-next").click();
    await maker.locator("#beneficiary").selectOption({ index: 1 });
    await maker.getByTestId("wizard-next").click();
    await maker.locator("#amount").fill("77.125");
    await maker.locator("#purpose").fill("Typed before the update arrived");
    await maker.evaluate(() => {
      (window as unknown as { __stillHere?: string }).__stillHere = "same page";
    });
    const posts: string[] = [];
    maker.on("request", (request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/")) posts.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });

    // "Deploy": the server now offers a worker of another build.
    writeFileSync(workerFile, original.replace(`const BUILD_ID = "${currentBuild}";`, `const BUILD_ID = "${nextBuild}";`));
    await maker.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });

    // The new worker is installed and WAITS; the page says so and keeps everything typed.
    await expect(maker.getByTestId("pwa-update")).toBeVisible({ timeout: 20_000 });
    expect(await maker.evaluate(() => (window as unknown as { __stillHere?: string }).__stillHere)).toBe("same page");
    await expect(maker.locator("#amount")).toHaveValue("77.125");
    await expect(maker.locator("#purpose")).toHaveValue("Typed before the update arrived");
    expect(await versionOf(maker)).toMatchObject({ buildId: currentBuild });
    expect(await maker.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);

    // Asking for the update while the form is open is refused: no reload, nothing lost.
    await maker.getByTestId("pwa-update").getByRole("button").first().click();
    await maker.waitForTimeout(1_500);
    expect(await maker.evaluate(() => (window as unknown as { __stillHere?: string }).__stillHere)).toBe("same page");
    await expect(maker.locator("#amount")).toHaveValue("77.125");
    expect(await versionOf(maker)).toMatchObject({ buildId: currentBuild });
    expect(posts.filter((entry) => entry.startsWith("POST /api/v1/payments"))).toEqual([]);

    // Once the person has left the form, the update is offered again and can be taken.
    await maker.goto(path("/dashboard"));
    await expect(maker.getByTestId("pwa-update")).toBeVisible({ timeout: 20_000 });
    await maker.evaluate(() => {
      (window as unknown as { __stillHere?: string }).__stillHere = "before update";
    });
    const reloaded = maker.waitForEvent("load", { timeout: 20_000 });
    await maker.getByTestId("pwa-update").getByRole("button").first().click();
    await reloaded;
    await expect(maker.locator("main#main")).toBeVisible();
    expect(await maker.evaluate(() => (window as unknown as { __stillHere?: string }).__stillHere ?? "reloaded")).toBe("reloaded");
    await controlled(maker);
    // The new build controls the page, the old public cache is gone, the session is the same.
    expect(await versionOf(maker)).toMatchObject({ buildId: nextBuild, cacheName: `alqarib-public-${nextBuild}` });
    expect(await ownCaches(maker)).toEqual([`alqarib-public-${nextBuild}`]);
    await expect(maker.getByTestId("pwa-update")).toHaveCount(0);
    expect((await apiFrom<{ person: unknown }>(maker, "GET", "/session")).status).toBe(200);
    // The reload was a plain GET: nothing was sent again and no payment exists from the typed form.
    expect(posts).toEqual([]);
    const payments = await apiFrom<Array<{ purpose?: string; amount: { minor: string } }>>(maker, "GET", "/payments?limit=100");
    expect((payments.body.data ?? []).filter((payment) => payment.amount.minor === "77125")).toEqual([]);
  } finally {
    // Put the built worker back exactly as the build left it.
    writeFileSync(workerFile, original);
  }
});

test("P-10 narrow portrait and landscape: no page-level horizontal overflow on the main workflows (emulation)", async ({ actor, path }) => {
  const overflow = async (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const visits: Array<[Parameters<typeof actor>[0], string[]]> = [
    ["aMaker", ["/dashboard", "/accounts", "/payments", "/payments/new", "/batches", "/batches/new", "/approvals", "/limits", "/beneficiaries"]],
    ["aFinance", ["/customers", "/deposits", "/reports", "/notifications"]],
    ["aPayroll", ["/payroll", "/payroll/new", "/payroll/employees"]],
    ["aAdmin", ["/admin/users", "/developer", "/agreement", "/audit"]],
    ["teller1", ["/bank/teller"]],
  ];
  for (const [who, routes] of visits) {
    const page = await actor(who);
    for (const size of [{ width: 360, height: 740 }, { width: 740, height: 360 }]) {
      await page.setViewportSize(size);
      for (const route of routes) {
        await page.goto(path(route));
        await expect(page.locator("h1").first()).toBeVisible();
        expect(await overflow(page), `${who} ${route} at ${size.width}×${size.height}`).toBeLessThanOrEqual(1);
      }
    }
    // Larger text (approximation of 200% text zoom): still no sideways scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path(routes[0] as string));
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(await overflow(page), `${who} ${routes[0]} at 200% text`).toBeLessThanOrEqual(1);
  }
});
