/**
 * Shared end-to-end fixtures. Every actor is a DISTINCT synthetic person in their own browser
 * context who signs in through the real sign-in form — no injected session, no shared cookies.
 */
import { test as base, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ACTORS, E2E_PASSWORD, EMAIL_DOMAIN, type ActorKey } from "./constants.ts";

export type AppOptions = { appLocale: "en" | "ar" };

type Fixtures = {
  /** Sign a distinct person in and return their page. */
  actor: (key: ActorKey) => Promise<Page>;
  /** Locale-prefixed application path. */
  path: (route: string) => string;
};

export const test = base.extend<AppOptions & Fixtures>({
  appLocale: ["en", { option: true }],

  // The second parameter is Playwright's fixture callback (named `provide` here so the React
  // hooks lint rule does not mistake it for the React `use` hook).
  path: async ({ appLocale }, provide) => {
    await provide((route) => `/${appLocale}${route}`);
  },

  actor: async ({ browser, contextOptions, baseURL, appLocale }, provide) => {
    const contexts: BrowserContext[] = [];
    const problems: string[] = [];
    await provide(async (key) => {
      const context = await browser.newContext({ ...contextOptions, baseURL });
      contexts.push(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(`${key}: uncaught ${error.message}`));
      page.on("response", (response) => {
        if (response.status() >= 500) problems.push(`${key}: HTTP ${response.status()} ${new URL(response.url()).pathname}`);
      });
      await page.goto(`/${appLocale}/login`);
      await page.locator("#email").fill(`${ACTORS[key]}@${EMAIL_DOMAIN}`);
      await page.locator("#password").fill(E2E_PASSWORD);
      await page.getByTestId("sign-in").click();
      await page.waitForURL((url) => /\/(dashboard|bank|select-workspace)(\/|$)/.test(url.pathname));
      return page;
    });
    for (const context of contexts) await context.close();
    // An uncaught client error or a 5xx anywhere in a journey fails that journey.
    expect(problems, "unexpected client errors or server failures").toEqual([]);
  },
});

export { expect };

/** Exact minor units of a rendered amount (`<bdi data-money="125000">`). */
export async function minorOf(locator: Locator): Promise<bigint> {
  const target = (await locator.getAttribute("data-money")) !== null ? locator : locator.locator("[data-money]").first();
  const value = await target.getAttribute("data-money");
  if (value === null) throw new Error("No amount found");
  return BigInt(value);
}

export type ApiReply<T = unknown> = { status: number; body: { data?: T; code?: string; correlationId?: string } & Record<string, unknown> };

/**
 * Call the application API from inside the signed-in page, exactly as its own scripts do:
 * same-origin, session cookie, CSRF header. Used to prove wire-level properties (replay,
 * denial codes) that the UI deliberately makes hard to trigger.
 */
export async function apiFrom<T = unknown>(
  page: Page,
  method: "GET" | "POST" | "PATCH",
  route: string,
  options: { body?: unknown; idempotencyKey?: string; ifMatch?: number } = {},
): Promise<ApiReply<T>> {
  return page.evaluate(
    async ({ method, route, options }) => {
      const headers: Record<string, string> = { accept: "application/json", "x-alqarib-request": "1" };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
      if (options.ifMatch !== undefined) headers["if-match"] = `"${options.ifMatch}"`;
      const response = await fetch(`/api/v1${route}`, {
        method,
        headers,
        credentials: "same-origin",
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    },
    { method, route, options },
  ) as Promise<ApiReply<T>>;
}

/** The current state shown by the first status badge on the page. */
export async function stateOf(page: Page): Promise<string | null> {
  return page.getByTestId("status").first().getAttribute("data-state");
}

/** Reload until the page shows one of the wanted states (the worker runs in another process). */
export async function waitForState(page: Page, wanted: string[], timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    await page.reload();
    last = await stateOf(page);
    if (last && wanted.includes(last)) return last;
    await page.waitForTimeout(700);
  }
  throw new Error(`State stayed ${last}; expected one of ${wanted.join(", ")}`);
}
