/**
 * Sandbox API credentials and outbound webhooks (API-01, EVT-01).
 *
 * - A credential is an opaque bearer token shown ONCE; only its hash is stored. It carries the
 *   scopes and accounts chosen here and nothing more: it cannot approve, administer access,
 *   reach the bank workspace or see payroll detail, whatever it sends.
 * - A webhook secret is shown once and stored encrypted. Deliveries are signed over the exact
 *   raw body, sent only to destinations that pass the SSRF policy at registration AND at
 *   delivery, and retried on a fixed schedule before dead-lettering. A failed subscriber can
 *   never change the outcome of a payment: events are published after the business commit.
 */
import { credentialCreateSchema, webhookCreateSchema } from "@/contracts/developer";
import { DomainError, notFound } from "@/contracts/errors";
import { WebhookTransportError } from "@/server/adapters/webhooks/transport";
import { writeAudit } from "@/server/audit/audit";
import { generateToken } from "@/server/auth/credentials";
import { requireCorporate, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { openSecret, sealSecret } from "@/server/crypto";
import { inTx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { requireEffectivePolicy } from "@/server/domain/agreements/policy";
import { randomToken } from "@/server/hash";
import { enqueueJob } from "@/server/jobs/queue";
import { DestinationError, parseDestination, resolveDestination } from "@/server/net/ssrf";
import type { ApiCredential, WebhookDelivery, WebhookSubscription } from "@/generated/prisma/client";
import { signWebhook } from "./signature";

export const JOB_WEBHOOK_DELIVER = "webhook.deliver";
/** Delay before each retry; after the last one the delivery is dead-lettered. */
export const RETRY_SCHEDULE_SECONDS = [10, 30, 120, 600, 3_600] as const;
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2_048;

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

export type CredentialView = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  accounts: Array<{ id: string; name: string; nameAr: string; maskedNumber: string }>;
  state: "ACTIVE" | "REVOKED" | "EXPIRED";
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

async function credentialViews(deps: Deps, rows: ApiCredential[]): Promise<CredentialView[]> {
  const accounts = await deps.db.account.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => row.accountIds))] } }, select: { id: true, name: true, nameAr: true, maskedNumber: true } });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const now = deps.clock.now();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes,
    accounts: row.accountIds.map((id) => accountById.get(id)).filter((account): account is NonNullable<typeof account> => account !== undefined),
    state: row.revokedAt ? "REVOKED" : row.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ACTIVE",
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listCredentials(deps: Deps, ctx: AuthContext): Promise<CredentialView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "developer.read");
  return credentialViews(deps, await deps.db.apiCredential.findMany({ where: { corporateId: corporateCtx.corporateId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 }));
}

export async function getCredential(deps: Deps, ctx: AuthContext, credentialId: string): Promise<CredentialView> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "developer.read");
  const row = await deps.db.apiCredential.findFirst({ where: { id: credentialId, corporateId: corporateCtx.corporateId } });
  if (!row) throw notFound();
  return (await credentialViews(deps, [row]))[0] as CredentialView;
}

/** Only a human administrator with the API role creates a credential; a token cannot mint or widen tokens. */
function requireManager(ctx: AuthContext) {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "developer.manage");
  return { corporateCtx, person: requirePerson(corporateCtx) };
}

export async function createCredential(deps: Deps, ctx: AuthContext, rawInput: unknown, credentialId: string): Promise<{ once: { token: string } }> {
  const { corporateCtx, person } = requireManager(ctx);
  const input = credentialCreateSchema.parse(rawInput);
  const now = deps.clock.now();
  // Accounts must be accounts of this corporate that the signed agreement links.
  const policy = await requireEffectivePolicy(deps.db, corporateCtx.corporateId, now);
  const linked = new Set(policy.terms.linkedAccounts);
  const accounts = await deps.db.account.findMany({ where: { corporateId: corporateCtx.corporateId, id: { in: input.accountIds } }, select: { id: true } });
  if (accounts.length !== new Set(input.accountIds).size || accounts.some((account) => !linked.has(account.id))) {
    throw new DomainError("ACCOUNT_NOT_ALLOWED", { violations: [{ field: "accountIds", rule: "agreement.linkedAccount" }] });
  }
  const generated = generateToken();
  await inTx(deps.db, async (tx) => {
    await tx.apiCredential.create({
      data: { id: credentialId, bankId: corporateCtx.bankId, corporateId: corporateCtx.corporateId, name: input.name, tokenPrefix: generated.prefix, tokenHash: generated.hash, scopes: [...new Set(input.scopes)], accountIds: accounts.map((account) => account.id), expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000), createdByPersonId: person.personId, createdAt: now },
    });
    // The token itself is never written anywhere: not to audit, not to logs.
    await writeAudit(tx, corporateCtx, { action: "credential.created", targetType: "apiCredential", targetId: credentialId, changes: { name: input.name, prefix: generated.prefix, scopes: input.scopes.join(","), accounts: accounts.length, expiresInDays: input.expiresInDays } });
  });
  return { once: { token: generated.token } };
}

/** Takes effect on the credential's very next call. */
export async function revokeCredential(deps: Deps, ctx: AuthContext, credentialId: string): Promise<void> {
  const { corporateCtx } = requireManager(ctx);
  await inTx(deps.db, async (tx) => {
    const row = await tx.apiCredential.findFirst({ where: { id: credentialId, corporateId: corporateCtx.corporateId } });
    if (!row) throw notFound();
    if (row.revokedAt) return;
    await tx.apiCredential.update({ where: { id: credentialId }, data: { revokedAt: deps.clock.now() } });
    await writeAudit(tx, corporateCtx, { action: "credential.revoked", targetType: "apiCredential", targetId: credentialId, changes: { prefix: row.tokenPrefix } });
  });
}

// ---------------------------------------------------------------------------------------------
// Webhook subscriptions
// ---------------------------------------------------------------------------------------------

export type WebhookView = { id: string; url: string; events: string[]; active: boolean; version: number; createdAt: string; deliveries: { delivered: number; pending: number; dead: number } };

async function webhookViews(deps: Deps, rows: WebhookSubscription[]): Promise<WebhookView[]> {
  const groups = await deps.db.webhookDelivery.groupBy({ by: ["subscriptionId", "state"], where: { subscriptionId: { in: rows.map((row) => row.id) } }, _count: { _all: true } });
  const count = (id: string, ...states: WebhookDelivery["state"][]) => groups.filter((group) => group.subscriptionId === id && states.includes(group.state)).reduce((sum, group) => sum + group._count._all, 0);
  return rows.map((row) => ({ id: row.id, url: row.url, events: row.events, active: row.active, version: row.version, createdAt: row.createdAt.toISOString(), deliveries: { delivered: count(row.id, "DELIVERED"), pending: count(row.id, "PENDING", "FAILED"), dead: count(row.id, "DEAD") } }));
}

function destinationRefusal(error: unknown): never {
  if (error instanceof DestinationError) {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "url", rule: error.problem, message: "This address cannot be used as a webhook destination." }] });
  }
  throw error;
}

export async function listWebhooks(deps: Deps, ctx: AuthContext): Promise<WebhookView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "developer.read");
  return webhookViews(deps, await deps.db.webhookSubscription.findMany({ where: { corporateId: corporateCtx.corporateId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }));
}

export async function getWebhook(deps: Deps, ctx: AuthContext, webhookId: string): Promise<WebhookView> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "developer.read");
  const row = await deps.db.webhookSubscription.findFirst({ where: { id: webhookId, corporateId: corporateCtx.corporateId } });
  if (!row) throw notFound();
  return (await webhookViews(deps, [row]))[0] as WebhookView;
}

/** Registers a destination after the SSRF policy passed. No request is sent to "verify" it. */
export async function createWebhook(deps: Deps, ctx: AuthContext, rawInput: unknown, webhookId: string): Promise<{ once: { signingSecret: string } }> {
  const { corporateCtx, person } = requireManager(ctx);
  const input = webhookCreateSchema.parse(rawInput);
  let normalized: string;
  try {
    const destination = parseDestination(input.url, deps.webhooks.testAllowlist);
    await resolveDestination(destination, deps.webhooks.resolver);
    normalized = destination.url.toString();
  } catch (error) {
    destinationRefusal(error);
  }
  const signingSecret = `whsec_${randomToken(32)}`;
  await inTx(deps.db, async (tx) => {
    await tx.webhookSubscription.create({ data: { id: webhookId, bankId: corporateCtx.bankId, corporateId: corporateCtx.corporateId, url: normalized, events: [...new Set(input.events)], secretCiphertext: sealSecret(deps.webhooks.encryptionKey, signingSecret), createdByPersonId: person.personId, createdAt: deps.clock.now() } });
    await writeAudit(tx, corporateCtx, { action: "webhook.created", targetType: "webhookSubscription", targetId: webhookId, changes: { host: new URL(normalized).host, events: input.events.join(",") } });
  });
  return { once: { signingSecret } };
}

export async function disableWebhook(deps: Deps, ctx: AuthContext, webhookId: string, expectedVersion: number): Promise<void> {
  const { corporateCtx } = requireManager(ctx);
  await inTx(deps.db, async (tx) => {
    const row = await tx.webhookSubscription.findFirst({ where: { id: webhookId, corporateId: corporateCtx.corporateId } });
    if (!row) throw notFound();
    if (row.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    await tx.webhookSubscription.update({ where: { id: webhookId }, data: { active: false, version: { increment: 1 } } });
    await writeAudit(tx, corporateCtx, { action: "webhook.disabled", targetType: "webhookSubscription", targetId: webhookId });
  });
}

export type DeliveryView = { id: string; eventId: string; eventType: string; state: WebhookDelivery["state"]; attempts: number; nextAttemptAt: string | null; lastAttemptAt: string | null; lastStatusCode: number | null; lastErrorCode: string | null; createdAt: string };

/** Sanitized delivery log: outcome codes and counts, never payload or response bodies. */
export async function listDeliveries(deps: Deps, ctx: AuthContext, webhookId: string, limit = 50): Promise<DeliveryView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "developer.read");
  const subscription = await deps.db.webhookSubscription.findFirst({ where: { id: webhookId, corporateId: corporateCtx.corporateId }, select: { id: true } });
  if (!subscription) throw notFound();
  const rows = await deps.db.webhookDelivery.findMany({ where: { subscriptionId: webhookId }, include: { event: { select: { type: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: Math.min(Math.max(limit, 1), 100) });
  return rows.map((row) => ({ id: row.id, eventId: row.eventId, eventType: row.event.type, state: row.state, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null, lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null, lastStatusCode: row.lastStatusCode, lastErrorCode: row.lastErrorCode, createdAt: row.createdAt.toISOString() }));
}

// ---------------------------------------------------------------------------------------------
// Publisher and delivery (worker)
// ---------------------------------------------------------------------------------------------

/**
 * Fan unpublished events out to the subscriptions that asked for them. One delivery row per
 * (event, subscription); marking the event published and creating its deliveries is one
 * transaction, so a crash can neither lose nor duplicate a delivery.
 */
export async function publishOutbox(deps: Deps, limit = 100): Promise<number> {
  const events = await deps.db.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: limit });
  let published = 0;
  for (const event of events) {
    const done = await inTx(
      deps.db,
      async (tx) => {
        const claimed = await tx.outboxEvent.updateMany({ where: { id: event.id, publishedAt: null }, data: { publishedAt: deps.clock.now() } });
        if (claimed.count !== 1) return false;
        if (!event.corporateId) return true;
        const subscriptions = await tx.webhookSubscription.findMany({ where: { corporateId: event.corporateId, active: true, events: { has: event.type } } });
        for (const subscription of subscriptions) {
          const delivery = await tx.webhookDelivery.create({ data: { subscriptionId: subscription.id, eventId: event.id, corporateId: event.corporateId, nextAttemptAt: deps.clock.now() } });
          await enqueueJob(tx, { type: JOB_WEBHOOK_DELIVER, payload: { deliveryId: delivery.id }, dedupKey: `webhook-deliver:${delivery.id}`, bankId: event.bankId, corporateId: event.corporateId, aggregateType: "webhookDelivery", aggregateId: delivery.id, maxAttempts: RETRY_SCHEDULE_SECONDS.length + 3 });
        }
        return true;
      },
      { skipIdempotency: true },
    );
    if (done) published += 1;
  }
  return published;
}

const printable = (value: string) => value.replace(/[^\x20-\x7E]/g, " ").slice(0, 200);

export type DeliveryOutcome = { kind: "done" } | { kind: "again"; at: Date };

/** One delivery attempt. The body is built once per attempt and signed exactly as sent. */
export async function deliverWebhook(deps: Deps, deliveryId: string): Promise<DeliveryOutcome> {
  const delivery = await deps.db.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { subscription: true, event: true } });
  if (!delivery || delivery.state === "DELIVERED" || delivery.state === "DEAD") return { kind: "done" };
  const now = deps.clock.now();
  const finish = async (data: { state: WebhookDelivery["state"]; status?: number | null; error?: string | null; snippet?: string | null; nextAttemptAt?: Date | null }) => {
    await deps.db.webhookDelivery.update({ where: { id: deliveryId }, data: { state: data.state, attempts: { increment: 1 }, lastAttemptAt: now, lastStatusCode: data.status ?? null, lastErrorCode: data.error ?? null, responseSnippet: data.snippet ?? null, nextAttemptAt: data.nextAttemptAt ?? null } });
  };
  if (!delivery.subscription.active) {
    await finish({ state: "DEAD", error: "SUBSCRIPTION_INACTIVE" });
    return { kind: "done" };
  }
  const retryOrDead = async (status: number | null, error: string, snippet: string | null): Promise<DeliveryOutcome> => {
    const delay = RETRY_SCHEDULE_SECONDS[delivery.attempts];
    if (delay === undefined) {
      await finish({ state: "DEAD", status, error, snippet });
      return { kind: "done" };
    }
    const at = new Date(now.getTime() + delay * 1000);
    await finish({ state: "FAILED", status, error, snippet, nextAttemptAt: at });
    return { kind: "again", at };
  };

  // The destination is validated again now, and the connection is pinned to that answer.
  let address;
  let url: URL;
  try {
    const destination = parseDestination(delivery.subscription.url, deps.webhooks.testAllowlist);
    address = await resolveDestination(destination, deps.webhooks.resolver);
    url = destination.url;
  } catch (error) {
    if (!(error instanceof DestinationError)) throw error;
    // Never connected: the reason is recorded as a code only.
    return retryOrDead(null, `DESTINATION_${error.problem}`, null);
  }

  const corporate = await deps.db.corporate.findUnique({ where: { id: delivery.corporateId }, select: { shortCode: true } });
  const body = JSON.stringify({
    id: delivery.event.id,
    type: delivery.event.type,
    schemaVersion: delivery.event.schemaVersion,
    occurredAt: delivery.event.occurredAt.toISOString(),
    corporateReference: corporate?.shortCode ?? null,
    correlationId: delivery.event.correlationId,
    data: delivery.event.payload,
  });
  // Signature time is real time: a receiver compares it with its own clock (±300 s).
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = openSecret(deps.webhooks.encryptionKey, delivery.subscription.secretCiphertext);
  try {
    const response = await deps.webhooks.transport.send({
      url,
      address,
      headers: { "content-type": "application/json", "user-agent": "AlQarib-Sandbox-Webhooks/1", "x-alqarib-event-id": delivery.event.id, "x-alqarib-delivery-id": delivery.id, "x-alqarib-timestamp": String(timestamp), "x-alqarib-signature": signWebhook(secret, timestamp, body) },
      body,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    if (response.status >= 200 && response.status < 300) {
      await finish({ state: "DELIVERED", status: response.status });
      return { kind: "done" };
    }
    // Redirects are not followed: a 3xx is a failed delivery like any other non-2xx answer.
    return retryOrDead(response.status, `HTTP_${response.status}`, printable(response.snippet));
  } catch (error) {
    if (error instanceof WebhookTransportError) return retryOrDead(null, error.code, null);
    throw error;
  }
}
