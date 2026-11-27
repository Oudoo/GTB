import { z } from "zod";
import { DomainError } from "@/contracts/errors";
import { writeAudit } from "@/server/audit/audit";
import { resolveSession, selectContext, signIn, signOut, type SessionInfo } from "@/server/auth/session";
import { command, query, type AnyOperation, type OpRequest } from "../framework";

function projectSession(session: SessionInfo) {
  const ctx = session.context;
  return {
    person: {
      id: session.person.id,
      name: session.person.name,
      nameAr: session.person.nameAr,
      email: session.person.email,
      preferredLocale: session.person.preferredLocale,
    },
    memberships: session.memberships,
    context: ctx
      ? {
          membershipId: ctx.membershipId,
          workspace: ctx.workspace,
          bankId: ctx.bankId,
          corporateId: ctx.corporateId,
          branchId: ctx.branchId,
          roles: ctx.roles,
          permissions: [...ctx.permissions].sort(),
          accounts: [...ctx.grants.entries()].map(([accountId, rights]) => ({ accountId, ...rights })),
          userLimits: {
            perItemMinor: ctx.userLimits.perItemMinor?.toString() ?? null,
            dailyMinor: ctx.userLimits.dailyMinor?.toString() ?? null,
          },
        }
      : null,
    mode: "sandbox" as const,
  };
}

function withCookies(status: number, payload: unknown, cookies: string[]): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}

const loginBody = z.strictObject({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

const contextBody = z.strictObject({ membershipId: z.uuid() });

export const sessionOperations: AnyOperation[] = [
  query({
    id: "getSession",
    method: "GET",
    path: "/session",
    summary: "Current actor, permitted contexts and permissions",
    description: "Verified from the session cookie. No token or secret is returned.",
    tag: "Session",
    scope: "session",
    handler: async ({ session }) => ({ data: projectSession(session as SessionInfo) }),
  }),

  query<Record<string, never>, Record<string, never>, z.infer<typeof loginBody>>({
    id: "signIn",
    method: "POST",
    path: "/session/login",
    summary: "Sign in with a sandbox identity",
    description:
      "Email/password sign-in for seeded or invited identities. Same response for an unknown address, a wrong password and a suspended person; throttled per identifier.",
    tag: "Session",
    scope: "public",
    body: loginBody,
    handler: async ({ deps, body, request, correlationId }) => {
      const result = await signIn(deps, {
        email: body.email,
        password: body.password,
        headers: request.headers,
        correlationId,
      });
      if (!result.ok) {
        if (result.reason === "THROTTLED") {
          throw new DomainError("QUOTA_EXCEEDED", {
            detail: "Too many sign-in attempts. Try again later.",
            ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
          });
        }
        throw new DomainError("UNAUTHENTICATED", { detail: "The email or password is not correct." });
      }
      return { raw: withCookies(200, { data: { signedIn: true }, correlationId }, result.setCookies) };
    },
  }),

  query({
    id: "signOut",
    method: "POST",
    path: "/session/logout",
    summary: "Sign out and revoke the server session",
    tag: "Session",
    scope: "public",
    handler: async ({ deps, request, correlationId }) => {
      const cleared = await signOut(deps, request.headers, correlationId);
      return { raw: withCookies(200, { data: { signedOut: true }, correlationId }, cleared) };
    },
  }),

  command<Record<string, never>, Record<string, never>, z.infer<typeof contextBody>>({
    id: "selectSessionContext",
    method: "POST",
    path: "/session/context",
    summary: "Select one of the person's own memberships as the working context",
    description: "The membership must belong to the signed-in person and be active. Clients must discard cached data after switching.",
    tag: "Session",
    scope: "session",
    body: contextBody,
    target: ({ body }) => ({ type: "membership", id: body.membershipId }),
    execute: async ({ deps, session, body }) => {
      await selectContext(deps, session as SessionInfo, body.membershipId);
    },
    render: async (request: OpRequest<Record<string, never>, Record<string, never>, z.infer<typeof contextBody>>) => {
      const fresh = await resolveSession(request.deps, request.request.headers, request.correlationId);
      if (!fresh) throw new DomainError("UNAUTHENTICATED");
      if (fresh.context) {
        await writeAudit(request.deps.db, fresh.context, {
          action: "session.context.selected",
          targetType: "membership",
          targetId: fresh.context.membershipId,
        });
      }
      return projectSession(fresh);
    },
  }),
];
