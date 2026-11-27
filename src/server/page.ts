/**
 * Server-component helpers. Pages resolve the SAME verified session and call the SAME query
 * services as the API (document 03): nothing is trusted from the URL or the client, and a
 * hidden sidebar entry is never the access control.
 */
import "server-only";
import { headers } from "next/headers";
import { isDomainError, type ErrorCode } from "@/contracts/errors";
import { redirect } from "@/i18n/navigation";
import { isLocale, type Locale } from "@/i18n/routing";
import { toDomainError } from "@/server/api/framework";
import type { AuthContext } from "@/server/auth/context";
import type { Permission } from "@/server/auth/permissions";
import { resolveSession, type SessionInfo } from "@/server/auth/session";
import { getDeps, type Deps } from "@/server/deps";
import { resolveCorrelationId } from "@/server/logging";

export type PageSession = { deps: Deps; session: SessionInfo; locale: Locale };
export type WorkspacePage = PageSession & { ctx: AuthContext };

export function localeOf(value: string): Locale {
  return isLocale(value) ? value : "en";
}

/** The signed-in person, or a redirect to sign-in. */
export async function requireSession(localeParam: string): Promise<PageSession> {
  const locale = localeOf(localeParam);
  const deps = await getDeps();
  const requestHeaders = await headers();
  const session = await resolveSession(deps, new Headers({ cookie: requestHeaders.get("cookie") ?? "" }), resolveCorrelationId(null));
  if (!session) redirect({ href: "/login", locale });
  return { deps, session: session as SessionInfo, locale };
}

async function requireWorkspace(localeParam: string, workspace: "CORPORATE" | "BANK"): Promise<WorkspacePage> {
  const page = await requireSession(localeParam);
  const ctx = page.session.context;
  if (!ctx) redirect({ href: "/select-workspace", locale: page.locale });
  const context = ctx as AuthContext;
  // A person in the other workspace is sent to their own home, never shown this one.
  if (context.workspace !== workspace) redirect({ href: context.workspace === "BANK" ? "/bank" : "/dashboard", locale: page.locale });
  return { ...page, ctx: context };
}

export const requireCorporatePage = (locale: string) => requireWorkspace(locale, "CORPORATE");
export const requireBankPage = (locale: string) => requireWorkspace(locale, "BANK");

export function can(ctx: AuthContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export type Loaded<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; status: number };

/**
 * Run a query service and turn a domain error into a renderable state. A failed read is shown
 * as an error or "not available" — never as an empty list or a zero balance.
 */
export async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    // Next.js control-flow signals (redirect/notFound) must pass through untouched.
    if (error && typeof error === "object" && "digest" in error && !isDomainError(error)) throw error;
    const domain = toDomainError(error, "page");
    return { ok: false, code: domain.code, status: domain.status };
  }
}
