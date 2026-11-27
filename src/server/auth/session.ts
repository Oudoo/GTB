/**
 * Session service (SEC-01, SEC-03): sign-in with throttling, sign-out, and construction of
 * the verified `AuthContext` from the session cookie. Every request re-reads the session,
 * person and membership rows, so suspension and revocation take effect on the next call.
 */
import { DomainError } from "@/contracts/errors";
import { writeSecurityEvent } from "@/server/audit/audit";
import type { Deps } from "@/server/deps";
import { getEnv } from "@/server/env";
import { sha256Hex } from "@/server/hash";
import { getAuth, type AuthInstance } from "./auth";
import type { AccountRights, AuthContext } from "./context";
import { permissionsForRoles } from "./permissions";

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_LOCK_MS = 15 * 60_000;

function authFor(deps: Deps): AuthInstance {
  const env = getEnv();
  return getAuth({ db: deps.db, baseUrl: env.appBaseUrl, secret: env.authSecret });
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function throttleKey(email: string): string {
  return sha256Hex(`login:${normalizeEmail(email)}`);
}

export type MembershipSummary = {
  id: string;
  kind: "CORPORATE" | "BANK";
  bankId: string;
  bankName: string;
  bankNameAr: string;
  corporateId: string | null;
  corporateName: string | null;
  corporateNameAr: string | null;
  roles: string[];
};

export type SessionInfo = {
  sessionId: string;
  person: { id: string; name: string; nameAr: string | null; email: string; preferredLocale: string };
  memberships: MembershipSummary[];
  /** NULL when the person must choose a workspace first. */
  context: AuthContext | null;
};

export type LoginResult =
  | { ok: true; setCookies: string[] }
  | { ok: false; reason: "INVALID" | "THROTTLED"; retryAfterSeconds?: number };

/**
 * Verify credentials. The response is identical for an unknown address, a wrong password and a
 * suspended person, and the throttle counts by submitted identifier — so nothing reveals
 * whether an account exists (I-52).
 */
export async function signIn(
  deps: Deps,
  input: { email: string; password: string; headers: Headers; correlationId: string },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const keyHash = throttleKey(email);
  const now = deps.clock.now();

  const throttle = await deps.db.loginThrottle.findUnique({ where: { keyHash } });
  if (throttle?.lockedUntil && throttle.lockedUntil.getTime() > now.getTime()) {
    await writeSecurityEvent(deps.db, {
      kind: "LOGIN_THROTTLED",
      identifierHash: keyHash,
      correlationId: input.correlationId,
    });
    return {
      ok: false,
      reason: "THROTTLED",
      retryAfterSeconds: Math.max(1, Math.ceil((throttle.lockedUntil.getTime() - now.getTime()) / 1000)),
    };
  }

  const auth = authFor(deps);
  const forwarded = new Headers();
  for (const name of ["origin", "user-agent", "x-forwarded-for"]) {
    const value = input.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  if (!forwarded.has("origin")) forwarded.set("origin", getEnv().appOrigin);

  let response: Response;
  try {
    response = await auth.api.signInEmail({
      body: { email, password: input.password },
      headers: forwarded,
      asResponse: true,
    });
  } catch {
    response = new Response(null, { status: 401 });
  }

  let success = response.status === 200;
  const setCookies = success ? response.headers.getSetCookie() : [];

  if (success) {
    const person = await deps.db.person.findUnique({ where: { email } });
    const activeMemberships = person
      ? await deps.db.membership.count({ where: { personId: person.id, status: "ACTIVE" } })
      : 0;
    if (!person || person.status !== "ACTIVE" || activeMemberships === 0) {
      // Valid password but no right to enter: drop the session just created and answer exactly
      // like a wrong password.
      if (person) await deps.db.authSession.deleteMany({ where: { userId: person.id } });
      success = false;
    } else {
      await deps.db.loginThrottle.deleteMany({ where: { keyHash } });
      await writeSecurityEvent(deps.db, {
        kind: "LOGIN_SUCCEEDED",
        identifierHash: keyHash,
        personId: person.id,
        correlationId: input.correlationId,
      });
      return { ok: true, setCookies };
    }
  }

  const windowExpired = !throttle || now.getTime() - throttle.windowStart.getTime() > LOGIN_WINDOW_MS;
  const failures = windowExpired ? 1 : throttle.failures + 1;
  const lockedUntil = failures >= LOGIN_MAX_FAILURES ? new Date(now.getTime() + LOGIN_LOCK_MS) : null;
  await deps.db.loginThrottle.upsert({
    where: { keyHash },
    update: { failures, windowStart: windowExpired ? now : throttle.windowStart, lockedUntil },
    create: { keyHash, failures, windowStart: now, lockedUntil },
  });
  await writeSecurityEvent(deps.db, {
    kind: "LOGIN_FAILED",
    identifierHash: keyHash,
    correlationId: input.correlationId,
    detail: { failures },
  });
  return { ok: false, reason: "INVALID" };
}

/** Revoke the server session and return the cookies that clear it in the browser. */
export async function signOut(deps: Deps, headers: Headers, correlationId: string): Promise<string[]> {
  const auth = authFor(deps);
  const cookie = headers.get("cookie");
  const current = cookie ? await auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null) : null;
  let cleared: string[] = [];
  try {
    const response = await auth.api.signOut({
      headers: new Headers({ ...(cookie ? { cookie } : {}), origin: getEnv().appOrigin }),
      asResponse: true,
    });
    cleared = response.headers.getSetCookie();
  } catch {
    cleared = [];
  }
  if (current) {
    // Belt and braces: the row is gone even if the library call failed part-way.
    await deps.db.authSession.deleteMany({ where: { id: current.session.id } });
    await writeSecurityEvent(deps.db, { kind: "LOGOUT", personId: current.user.id, correlationId });
  }
  return cleared;
}

/** Revoke every session of a person (suspension, access change). */
export async function revokeSessionsOf(deps: Pick<Deps, "db">, personId: string): Promise<number> {
  const result = await deps.db.authSession.deleteMany({ where: { userId: personId } });
  return result.count;
}

async function buildContext(
  deps: Deps,
  membershipId: string,
  person: { id: string; name: string; email: string },
  sessionId: string,
  correlationId: string,
): Promise<AuthContext | null> {
  const membership = await deps.db.membership.findFirst({
    where: { id: membershipId, personId: person.id, status: "ACTIVE" },
    include: { bank: true, corporate: true, grants: { include: { account: true } } },
  });
  if (!membership) return null;
  if (membership.kind === "CORPORATE" && (!membership.corporate || membership.corporate.status === "CLOSED")) return null;

  const grants = new Map<string, AccountRights>();
  for (const grant of membership.grants) {
    if (grant.account.status === "CLOSED") continue;
    grants.set(grant.accountId, {
      read: grant.canRead,
      debit: grant.canDebit && grant.account.status === "ACTIVE",
      approve: grant.canApprove,
      report: grant.canReport,
    });
  }

  return {
    principal: { kind: "person", personId: person.id, sessionId, name: person.name, email: person.email },
    workspace: membership.kind,
    bankId: membership.bankId,
    bankCode: membership.bank.code,
    corporateId: membership.corporateId,
    corporateCoreRef: membership.corporate?.coreCustomerRef ?? null,
    membershipId: membership.id,
    roles: membership.roles,
    permissions: permissionsForRoles(membership.roles),
    grants,
    branchId: membership.branchId,
    userLimits: { perItemMinor: membership.userPerItemLimitMinor, dailyMinor: membership.userDailyLimitMinor },
    correlationId,
  };
}

/**
 * Resolve the cookie session into person, permitted memberships and (if a workspace is
 * selected) the authorization context. Returns null when there is no valid session.
 */
export async function resolveSession(deps: Deps, headers: Headers, correlationId: string): Promise<SessionInfo | null> {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  const auth = authFor(deps);
  const result = await auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
  if (!result) return null;

  const person = await deps.db.person.findUnique({ where: { id: result.user.id } });
  if (!person || person.status !== "ACTIVE") {
    // Suspended people keep no usable session (SEC-03).
    await deps.db.authSession.deleteMany({ where: { userId: result.user.id } });
    return null;
  }

  const rows = await deps.db.membership.findMany({
    where: { personId: person.id, status: "ACTIVE" },
    include: { bank: true, corporate: true },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
  });
  const memberships: MembershipSummary[] = rows
    .filter((row) => row.kind === "BANK" || (row.corporate && row.corporate.status !== "CLOSED"))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      bankId: row.bankId,
      bankName: row.bank.name,
      bankNameAr: row.bank.nameAr,
      corporateId: row.corporateId,
      corporateName: row.corporate?.legalName ?? null,
      corporateNameAr: row.corporate?.legalNameAr ?? null,
      roles: row.roles,
    }));

  const session = await deps.db.authSession.findUnique({ where: { id: result.session.id } });
  if (!session) return null;

  let activeId = session.activeMembershipId;
  if (activeId && !memberships.some((entry) => entry.id === activeId)) activeId = null;
  if (!activeId && memberships.length === 1) {
    activeId = (memberships[0] as MembershipSummary).id;
    await deps.db.authSession.update({ where: { id: session.id }, data: { activeMembershipId: activeId } });
  } else if (activeId !== session.activeMembershipId) {
    await deps.db.authSession.update({ where: { id: session.id }, data: { activeMembershipId: activeId } });
  }

  const context = activeId
    ? await buildContext(deps, activeId, { id: person.id, name: person.name, email: person.email }, session.id, correlationId)
    : null;

  return {
    sessionId: session.id,
    person: {
      id: person.id,
      name: person.name,
      nameAr: person.nameAr,
      email: person.email,
      preferredLocale: person.preferredLocale,
    },
    memberships,
    context,
  };
}

/** Select one of the person's own active memberships as the working context. */
export async function selectContext(deps: Deps, session: SessionInfo, membershipId: string): Promise<void> {
  if (!session.memberships.some((entry) => entry.id === membershipId)) {
    // Not theirs (or not active): indistinguishable from "does not exist".
    throw new DomainError("RESOURCE_NOT_FOUND");
  }
  await deps.db.authSession.update({ where: { id: session.sessionId }, data: { activeMembershipId: membershipId } });
}

/**
 * The CURRENT authorization context of a membership, for a background job that completes a
 * request a person made earlier (e.g. generating a report). It re-reads roles, grants and
 * status now, so rights that were removed after the request are not honoured. Returns null when
 * the membership is no longer active. Never called from a request path.
 */
export async function currentContextOf(deps: Deps, membershipId: string, correlationId: string): Promise<AuthContext | null> {
  const membership = await deps.db.membership.findUnique({ where: { id: membershipId }, include: { person: true } });
  if (!membership || membership.person.status !== "ACTIVE") return null;
  return buildContext(deps, membershipId, { id: membership.person.id, name: membership.person.name, email: membership.person.email }, "background-job", correlationId);
}

/**
 * Context of a seeded membership WITHOUT a browser session. Used only by the demo seed to drive
 * the real governance services as two distinct seeded administrators. It is not reachable from
 * any request path: requests always go through `resolveSession` or `resolveCredential`.
 */
export async function fixtureContext(deps: Deps, membershipId: string, correlationId: string): Promise<AuthContext> {
  const membership = await deps.db.membership.findUniqueOrThrow({ where: { id: membershipId }, include: { person: true } });
  const context = await buildContext(
    deps,
    membershipId,
    { id: membership.person.id, name: membership.person.name, email: membership.person.email },
    "fixture-seed",
    correlationId,
  );
  if (!context) throw new Error("Seed membership is not active");
  return context;
}
