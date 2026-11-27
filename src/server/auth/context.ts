/**
 * The verified authorization context every domain service receives (SEC-01).
 *
 * It is built ONLY by `server/auth/session.ts` (cookie session), `server/auth/credentials.ts`
 * (scoped bearer token) or `serviceContext` (worker acting on a stored instruction). Nothing in
 * a request body, query string or header (tenant, role, actor) can change it.
 */
import { DomainError, denied, notFound } from "@/contracts/errors";
import type { Permission } from "./permissions";

export type Principal =
  | { kind: "person"; personId: string; sessionId: string; name: string; email: string }
  | { kind: "credential"; credentialId: string; name: string; scopes: readonly string[] }
  | { kind: "service"; service: string };

export type AccountRights = Readonly<{ read: boolean; debit: boolean; approve: boolean; report: boolean }>;

export type AuthContext = Readonly<{
  principal: Principal;
  workspace: "CORPORATE" | "BANK";
  bankId: string;
  bankCode: string;
  corporateId: string | null;
  /** Core customer number of the corporate (second tenant check at the core adapter). */
  corporateCoreRef: string | null;
  membershipId: string | null;
  roles: readonly string[];
  permissions: ReadonlySet<Permission>;
  /** accountId → rights. For a credential this is already intersected with its account list. */
  grants: ReadonlyMap<string, AccountRights>;
  branchId: string | null;
  userLimits: Readonly<{ perItemMinor: bigint | null; dailyMinor: bigint | null }>;
  correlationId: string;
}>;

export type CorporateContext = AuthContext & { workspace: "CORPORATE"; corporateId: string; corporateCoreRef: string };
export type BankContext = AuthContext & { workspace: "BANK"; corporateId: null };

export function hasPermission(ctx: AuthContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) throw denied();
}

export function requireAnyPermission(ctx: AuthContext, permissions: readonly Permission[]): void {
  if (!permissions.some((permission) => ctx.permissions.has(permission))) throw denied();
}

/** Narrow to a corporate workspace. A bank user asking for corporate resources gets 404. */
export function requireCorporate(ctx: AuthContext): CorporateContext {
  if (ctx.workspace !== "CORPORATE" || !ctx.corporateId || !ctx.corporateCoreRef) throw notFound();
  return ctx as CorporateContext;
}

export function requireBank(ctx: AuthContext): BankContext {
  if (ctx.workspace !== "BANK") throw notFound();
  return ctx as BankContext;
}

/** Only a human with a live session can perform this (e.g. approvals; API-01). */
export function requirePerson(ctx: AuthContext): Extract<Principal, { kind: "person" }> {
  if (ctx.principal.kind !== "person") {
    throw new DomainError("PERMISSION_DENIED", { detail: "This action requires a signed-in person." });
  }
  return ctx.principal;
}

export function personIdOf(ctx: AuthContext): string | null {
  return ctx.principal.kind === "person" ? ctx.principal.personId : null;
}

export function rightsFor(ctx: AuthContext, accountId: string): AccountRights {
  return ctx.grants.get(accountId) ?? { read: false, debit: false, approve: false, report: false };
}

export function readableAccountIds(ctx: AuthContext): string[] {
  return [...ctx.grants.entries()].filter(([, rights]) => rights.read).map(([id]) => id);
}

/**
 * Account existence is not disclosed: an account the caller cannot read is "not found" (404),
 * while a readable account lacking the specific right is "denied" (403) — SEC-01.
 */
export function requireAccountRight(ctx: AuthContext, accountId: string, right: keyof AccountRights): void {
  const rights = rightsFor(ctx, accountId);
  if (!rights.read) throw notFound();
  if (!rights[right]) throw denied();
}

export function actorLabel(ctx: AuthContext): string {
  switch (ctx.principal.kind) {
    case "person":
      return ctx.principal.name;
    case "credential":
      return `API credential ${ctx.principal.name}`;
    case "service":
      return ctx.principal.service;
  }
}

/**
 * Worker context for a stored instruction. The tenant comes from the persisted, already
 * authorized record — never from raw queued JSON — and carries no human permission.
 */
export function serviceContext(input: {
  service: string;
  bankId: string;
  bankCode: string;
  corporateId: string | null;
  corporateCoreRef: string | null;
  correlationId: string;
}): AuthContext {
  return {
    principal: { kind: "service", service: input.service },
    workspace: input.corporateId ? "CORPORATE" : "BANK",
    bankId: input.bankId,
    bankCode: input.bankCode,
    corporateId: input.corporateId,
    corporateCoreRef: input.corporateCoreRef,
    membershipId: null,
    roles: [],
    permissions: new Set(),
    grants: new Map(),
    branchId: null,
    userLimits: { perItemMinor: null, dailyMinor: null },
    correlationId: input.correlationId,
  };
}
