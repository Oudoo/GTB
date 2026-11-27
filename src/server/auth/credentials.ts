/**
 * Sandbox API credentials (API-01, document 04). Opaque high-entropy bearer tokens; only a
 * SHA-256 of the token is stored. These are explicitly NOT an OAuth2/OIDC/FAPI/mTLS
 * implementation. A credential carries the intersection of its scopes and account list and
 * can never approve, administer access or reach the bank workspace.
 */
import { DomainError } from "@/contracts/errors";
import { Prisma } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { randomToken, sha256Hex } from "@/server/hash";
import type { AccountRights, AuthContext } from "./context";
import { permissionsForScopes } from "./permissions";

export const TOKEN_PREFIX = "aqsb";

export function generateToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomToken(6).replace(/[^A-Za-z0-9]/g, "x").slice(0, 8);
  const token = `${TOKEN_PREFIX}_${prefix}_${randomToken(32)}`;
  return { token, prefix, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return sha256Hex(`alqarib-api-token:${token}`);
}

export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,200})$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

export type CredentialResolution = { context: AuthContext; credentialId: string; quota: { perMinute: number; perDay: number } };

export const DEFAULT_API_QUOTA = { perMinute: 60, perDay: 10_000 } as const;

/** Returns null for an unknown, revoked or expired token (the caller answers 401). */
export async function resolveCredential(deps: Deps, token: string, correlationId: string): Promise<CredentialResolution | null> {
  const credential = await deps.db.apiCredential.findUnique({ where: { tokenHash: hashToken(token) } });
  const now = deps.clock.now();
  if (!credential || credential.revokedAt || credential.expiresAt.getTime() <= now.getTime()) return null;

  const corporate = await deps.db.corporate.findUnique({ where: { id: credential.corporateId }, include: { bank: true } });
  if (!corporate || corporate.status !== "ACTIVE") return null;

  const accounts = await deps.db.account.findMany({
    where: { corporateId: corporate.id, id: { in: credential.accountIds }, status: { not: "CLOSED" } },
  });
  const canWrite = credential.scopes.includes("payments:write") || credential.scopes.includes("batches:write");
  const grants = new Map<string, AccountRights>();
  for (const account of accounts) {
    grants.set(account.id, {
      read: true,
      debit: canWrite && account.status === "ACTIVE",
      approve: false,
      report: credential.scopes.includes("accounts:read"),
    });
  }

  if (!credential.lastUsedAt || now.getTime() - credential.lastUsedAt.getTime() > 60_000) {
    await deps.db.apiCredential.updateMany({ where: { id: credential.id }, data: { lastUsedAt: now } });
  }

  // Demo quota is agreement fixture metadata, not a production rate (document 04).
  const version = await deps.db.agreementVersion.findFirst({
    where: { corporateId: corporate.id, status: { in: ["APPROVED", "EFFECTIVE"] }, effectiveFrom: { lte: now }, effectiveUntil: { gt: now } },
    select: { terms: true },
  });
  const plan = (version?.terms as { apiPlan?: { perMinute?: number; perDay?: number } } | null)?.apiPlan;

  return {
    credentialId: credential.id,
    quota: {
      perMinute: Number.isInteger(plan?.perMinute) ? (plan?.perMinute as number) : DEFAULT_API_QUOTA.perMinute,
      perDay: Number.isInteger(plan?.perDay) ? (plan?.perDay as number) : DEFAULT_API_QUOTA.perDay,
    },
    context: {
      principal: { kind: "credential", credentialId: credential.id, name: credential.name, scopes: credential.scopes },
      workspace: "CORPORATE",
      bankId: corporate.bankId,
      bankCode: corporate.bank.code,
      corporateId: corporate.id,
      corporateCoreRef: corporate.coreCustomerRef,
      membershipId: null,
      roles: [],
      permissions: permissionsForScopes(credential.scopes),
      grants,
      branchId: null,
      // A credential has no personal allowance; corporate and module limits still apply and a
      // human checker must approve every API-created payment.
      userLimits: { perItemMinor: null, dailyMinor: null },
      correlationId,
    },
  };
}

/**
 * Count one API call against the per-minute and per-day windows. Calls are counted
 * independently of payment amounts; exceeding either window raises 429 with Retry-After.
 */
export async function consumeQuota(
  deps: Deps,
  credentialId: string,
  quota: { perMinute: number; perDay: number },
): Promise<void> {
  const now = deps.clock.now();
  const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const dayStart = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
  const bump = async (kind: "MINUTE" | "DAY", start: Date): Promise<number> => {
    const rows = await deps.db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      INSERT INTO "ApiQuotaWindow" ("credentialId", "windowKind", "windowStart", "count")
      VALUES (${credentialId}::uuid, ${kind}, ${start}, 1)
      ON CONFLICT ("credentialId", "windowKind", "windowStart")
      DO UPDATE SET "count" = "ApiQuotaWindow"."count" + 1
      RETURNING "count"`);
    return rows[0]?.count ?? 1;
  };
  const minuteCount = await bump("MINUTE", minuteStart);
  if (minuteCount > quota.perMinute) {
    throw new DomainError("QUOTA_EXCEEDED", {
      retryAfterSeconds: Math.max(1, Math.ceil((minuteStart.getTime() + 60_000 - now.getTime()) / 1000)),
    });
  }
  const dayCount = await bump("DAY", dayStart);
  if (dayCount > quota.perDay) {
    throw new DomainError("QUOTA_EXCEEDED", {
      retryAfterSeconds: Math.max(1, Math.ceil((dayStart.getTime() + 86_400_000 - now.getTime()) / 1000)),
    });
  }
}
