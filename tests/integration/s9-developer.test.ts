/**
 * S9 developer surface (API-01, EVT-01; I-45..I-49): a sandbox token carries exactly its scopes
 * and accounts and can never approve or administer; quota and revocation act on the next call;
 * webhook destinations pass the SSRF policy at registration and at delivery; deliveries are
 * signed over the raw body, retried on schedule and can never change a settled payment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebhookRequest, WebhookResponse, WebhookTransport } from "@/server/adapters/webhooks/transport";
import { WebhookTransportError } from "@/server/adapters/webhooks/transport";
import { RETRY_SCHEDULE_SECONDS } from "@/server/domain/developer/service";
import { verifyWebhookSignature } from "@/server/domain/developer/signature";
import type { ResolvedAddress } from "@/server/net/ssrf";
import { ACCOUNTS, CORPORATES } from "@/server/seed/fixtures";
import { approve, coreBalance, getPayment, payAndApprove, paymentBody, type PaymentData } from "./support/payments";
import { Actor, createWorld, type World } from "./support/world";

type Credential = { id: string; name: string; tokenPrefix: string; scopes: string[]; state: string; token?: string; accounts: Array<{ id: string }> };
type Webhook = { id: string; url: string; events: string[]; active: boolean; version: number; signingSecret?: string; deliveries: { delivered: number; pending: number; dead: number } };
type Delivery = { id: string; eventId: string; eventType: string; state: string; attempts: number; lastStatusCode: number | null; lastErrorCode: string | null; nextAttemptAt: string | null };

/** In-memory receiver standing in for a subscriber's HTTPS endpoint. */
class FakeReceiver implements WebhookTransport {
  readonly received: WebhookRequest[] = [];
  mode: "ok" | "timeout" | "redirect" | "error500" = "ok";
  async send(request: WebhookRequest): Promise<WebhookResponse> {
    this.received.push(request);
    if (this.mode === "timeout") throw new WebhookTransportError("TIMEOUT");
    if (this.mode === "redirect") return { status: 302, snippet: "" };
    if (this.mode === "error500") return { status: 500, snippet: "boom \u0000 secret-looking-body" };
    return { status: 204, snippet: "" };
  }
}

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };

function bearer(world: World, token: string): Actor {
  const actor = new Actor(world, "credential");
  actor.bearer = token;
  return actor;
}

async function drainAll(world: World): Promise<void> {
  while ((await world.drain(2_000)) > 0) {
    /* until no job is due */
  }
}

describe("S9 developer surface", () => {
  let world: World;
  const receiver = new FakeReceiver();
  const dns = new Map<string, ResolvedAddress[]>([
    ["hooks.example.test", [PUBLIC]],
    ["rebind.example.test", [PUBLIC]],
    ["inside.example.test", [{ address: "10.20.30.40", family: 4 }]],
    ["mixed.example.test", [PUBLIC, { address: "169.254.169.254", family: 4 }]],
  ]);
  beforeAll(async () => {
    world = await createWorld({ webhooks: { transport: receiver, resolver: async (host) => dns.get(host) ?? [] } });
    await world.activateAgreement("A");
    await world.activateAgreement("B");
  });
  afterAll(async () => world.close());

  it("issues a token once and holds it to its scopes, accounts and human approval (I-45, API-01)", async () => {
    const admin = await world.as("aAdmin");
    const request = { name: "ERP integration (synthetic)", scopes: ["accounts:read", "payments:read", "payments:write"], accountIds: [ACCOUNTS.A_OPERATING.id], expiresInDays: 30 };
    const key = crypto.randomUUID();
    const created = await admin.post<Credential>("/developer/credentials", request, { idempotencyKey: key });
    expect(created.status).toBe(201);
    const token = created.data.token as string;
    expect(token).toMatch(/^aqsb_[A-Za-z0-9]{6,8}_.{20,}$/);
    expect(created.data).toMatchObject({ state: "ACTIVE", scopes: request.scopes, tokenPrefix: token.split("_")[1] });
    // Shown once: a replay of the same request and every later read carry no token.
    const replay = await admin.post<Credential>("/developer/credentials", request, { idempotencyKey: key });
    expect(replay.data.id).toBe(created.data.id);
    expect(replay.data.token).toBeUndefined();
    const listed = await admin.get<Credential[]>("/developer/credentials");
    expect(listed.text).not.toContain(token);
    expect(listed.text).not.toContain("tokenHash");
    const stored = await world.db.apiCredential.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(stored.tokenHash).not.toContain(token.slice(-12));
    expect(JSON.stringify(await world.db.auditEvent.findMany({ where: { targetId: created.data.id } }))).not.toContain(token.slice(-12));
    expect(JSON.stringify(await world.db.idempotencyRecord.findMany())).not.toContain(token.slice(-12));

    // Who may create one: a human administrator who also holds the API role, for linked accounts only.
    for (const key2 of ["aAdmin2", "aMaker", "aChecker1", "aFinance"]) expect((await (await world.as(key2)).post("/developer/credentials", request)).status).toBe(403);
    expect((await admin.post("/developer/credentials", { ...request, scopes: ["payroll:read"] })).status).toBe(400);
    expect((await admin.post("/developer/credentials", { ...request, scopes: ["batches:write"] })).status).toBe(400);
    expect((await admin.post("/developer/credentials", { ...request, accountIds: [ACCOUNTS.B_OPERATING.id] })).status).toBe(422);
    expect((await admin.post("/developer/credentials", { ...request, expiresInDays: 400 })).status).toBe(400);
    expect((await (await world.as("bFinance")).get("/developer/credentials")).status).toBe(403);

    // The token reads exactly its account and can prepare a payment…
    const api = bearer(world, token);
    const accounts = await api.get<Array<{ id: string }>>("/accounts");
    expect(accounts.status).toBe(200);
    expect(accounts.data.map((account) => account.id)).toEqual([ACCOUNTS.A_OPERATING.id]);
    const draft = await api.post<PaymentData>("/payments", paymentBody({ minor: "50000" }));
    expect(draft.status).toBe(201);
    const submitted = await api.post<PaymentData>(`/payments/${draft.data.id}/submit`, {}, { ifMatch: draft.data.version });
    expect(submitted.status).toBe(202);
    expect(submitted.data.state).toBe("PENDING_APPROVAL");
    const approvalId = (await getPayment(world, draft.data.id)).approval?.id as string;
    // …but it can never decide it, whatever it sends.
    const balance = await coreBalance(world, ACCOUNTS.A_OPERATING.ref);
    for (const path of [`/approvals/${approvalId}/approve`, `/approvals/${approvalId}/reject`]) {
      const forged = await api.post(path, { proposalVersion: 1, proposalHash: "0".repeat(64), reason: "automated" }, { ifMatch: 1, headers: { "x-role": "CHECKER", "x-corporate-id": CORPORATES.A.id } });
      expect(forged.status).toBe(403);
    }
    expect((await api.get(`/approvals/${approvalId}`)).status).toBe(403);
    // Not its account, not its scope, not its workspace, not payroll, not administration.
    expect([403, 404, 422]).toContain((await api.post("/payments", paymentBody({ source: "A_SAVINGS", minor: "1000" }))).status);
    for (const path of ["/batches", "/customers", "/deposits", "/payroll/employees", "/reports", "/audit-events", "/developer/credentials", "/developer/webhooks", "/notifications", "/bank/operations/executions", "/bank/corporates", "/bank/simulator", "/alert-rules"]) {
      const response = await api.get(path);
      expect([403, 404], `GET ${path}`).toContain(response.status);
    }
    expect((await api.post("/developer/credentials", request)).status).toBe(403);
    expect((await api.post("/bank/simulator/clock", { advanceMinutes: 5, reason: "not allowed" })).status).toBe(403);
    await drainAll(world);
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(balance);
    // A human checker approves the API-created payment; only then does money move.
    expect((await approve(world, approvalId, "aChecker1")).status).toBe(200);
    await drainAll(world);
    expect((await getPayment(world, draft.data.id)).state).toBe("SETTLED");
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(balance - 50_500n);
    // A malformed or unknown token is simply unauthenticated.
    expect((await bearer(world, `${token.slice(0, -4)}AAAA`).get("/accounts")).status).toBe(401);
    expect((await bearer(world, "not-a-token").get("/accounts")).status).toBe(401);
  });

  it("counts calls against the quota and stops a revoked or expired token on its next call (I-46)", async () => {
    const admin = await world.as("aAdmin");
    const created = await admin.post<Credential>("/developer/credentials", { name: "Quota probe (synthetic)", scopes: ["accounts:read"], accountIds: [ACCOUNTS.A_OPERATING.id], expiresInDays: 1 });
    const api = bearer(world, created.data.token as string);
    const paymentsBefore = await world.db.payment.count();
    // The demo agreement allows 60 calls a minute.
    const statuses: number[] = [];
    for (let call = 0; call < 62; call += 1) statuses.push((await api.get("/accounts")).status);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    const limited = await api.get("/accounts");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("QUOTA_EXCEEDED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await world.db.payment.count()).toBe(paymentsBefore);
    // The next minute is a new window.
    world.clock.advanceMs(61_000);
    expect((await api.get("/accounts")).status).toBe(200);

    // Revocation acts on the very next call and cannot be undone by the token.
    expect((await api.post(`/developer/credentials/${created.data.id}/revoke`)).status).toBe(403);
    expect((await (await world.as("aMaker")).post(`/developer/credentials/${created.data.id}/revoke`)).status).toBe(403);
    const revoked = await admin.post<Credential>(`/developer/credentials/${created.data.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.data.state).toBe("REVOKED");
    expect((await api.get("/accounts")).status).toBe(401);

    // Expiry is enforced by the clock, not by the client.
    const shortLived = await admin.post<Credential>("/developer/credentials", { name: "One-day token (synthetic)", scopes: ["accounts:read"], accountIds: [ACCOUNTS.A_OPERATING.id], expiresInDays: 1 });
    const temporary = bearer(world, shortLived.data.token as string);
    expect((await temporary.get("/accounts")).status).toBe(200);
    world.clock.advanceMs(24 * 3_600_000 + 1_000);
    expect((await temporary.get("/accounts")).status).toBe(401);
    expect((await admin.get<Credential[]>("/developer/credentials")).data.find((entry) => entry.id === shortLived.data.id)?.state).toBe("EXPIRED");
  });

  it("registers only destinations that pass the SSRF policy and never calls a refused one (I-47)", async () => {
    const admin = await world.as("aAdmin");
    const events = ["payment.status_changed"];
    const refused = [
      "http://hooks.example.test/a",
      "https://user:pass@hooks.example.test/a",
      "https://hooks.example.test:8443/a",
      "https://localhost/a",
      "https://127.0.0.1/a",
      "https://[::1]/a",
      "https://[::ffff:10.0.0.1]/a",
      "https://169.254.169.254/latest/meta-data",
      "https://2130706433/a",
      "https://inside.example.test/a",
      "https://mixed.example.test/a",
      "https://unknown-host.example.test/a",
      "https://service.internal/a",
    ];
    for (const url of refused) {
      const response = await admin.post("/developer/webhooks", { url, events });
      expect(response.status, url).toBe(400);
      expect(JSON.stringify(response.body), url).toMatch(/SCHEME_NOT_HTTPS|CREDENTIALS_IN_URL|PORT_NOT_ALLOWED|HOST_NOT_ALLOWED|ADDRESS_NOT_PUBLIC|HOST_UNRESOLVABLE/);
    }
    expect((await admin.post("/developer/webhooks", { url: "https://hooks.example.test/a", events: ["payroll.row_paid"] })).status).toBe(400);
    expect((await (await world.as("aMaker")).post("/developer/webhooks", { url: "https://hooks.example.test/a", events })).status).toBe(403);
    expect(await world.db.webhookSubscription.count()).toBe(0);
    // Registration itself never contacts the destination.
    const accepted = await admin.post<Webhook>("/developer/webhooks", { url: "https://rebind.example.test/hook", events });
    expect(accepted.status).toBe(201);
    expect(accepted.data.signingSecret).toMatch(/^whsec_/);
    expect(receiver.received).toHaveLength(0);
    const stored = await world.db.webhookSubscription.findUniqueOrThrow({ where: { id: accepted.data.id } });
    expect(stored.secretCiphertext).not.toContain((accepted.data.signingSecret as string).slice(6));
    expect((await admin.get<Webhook[]>("/developer/webhooks")).text).not.toContain("whsec_");

    // DNS rebinding: the name now points inside. The delivery is refused before any connection.
    dns.set("rebind.example.test", [{ address: "10.0.0.5", family: 4 }]);
    const payment = await payAndApprove(world, { minor: "10000" });
    await drainAll(world);
    expect((await getPayment(world, payment.id)).state).toBe("SETTLED");
    expect(receiver.received).toHaveLength(0);
    const log = await admin.get<Delivery[]>(`/developer/webhooks/${accepted.data.id}/deliveries`);
    expect(log.data.length).toBeGreaterThan(0);
    expect(log.data.every((delivery) => delivery.state === "FAILED" && delivery.lastErrorCode === "DESTINATION_ADDRESS_NOT_PUBLIC")).toBe(true);
    const current = (await admin.get<Webhook[]>("/developer/webhooks")).data.find((entry) => entry.id === accepted.data.id) as Webhook;
    expect((await admin.post(`/developer/webhooks/${accepted.data.id}/disable`, undefined, { ifMatch: current.version })).status).toBe(200);
  });

  it("signs deliveries over the raw body, retries on schedule and never changes a settled payment (I-48, I-49)", async () => {
    const admin = await world.as("aAdmin");
    const created = await admin.post<Webhook>("/developer/webhooks", { url: "https://hooks.example.test/alqarib", events: ["payment.status_changed", "batch.finished"] });
    expect(created.status).toBe(201);
    const secret = created.data.signingSecret as string;
    receiver.received.length = 0;

    // The subscriber is down when the payment settles: the payment is unaffected.
    receiver.mode = "timeout";
    const balance = await coreBalance(world, ACCOUNTS.A_OPERATING.ref);
    const payment = await payAndApprove(world, { minor: "20000" });
    await drainAll(world);
    expect((await getPayment(world, payment.id)).state).toBe("SETTLED");
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(balance - 20_500n);
    let log = (await admin.get<Delivery[]>(`/developer/webhooks/${created.data.id}/deliveries`)).data;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((delivery) => delivery.state === "FAILED" && delivery.attempts === 1 && delivery.lastErrorCode === "TIMEOUT" && delivery.nextAttemptAt !== null)).toBe(true);
    const firstAttempts = receiver.received.length;
    expect(firstAttempts).toBe(log.length);
    // Nothing is retried before its time.
    world.clock.advanceMs(9_000);
    await drainAll(world);
    expect(receiver.received.length).toBe(firstAttempts);

    // A redirect is not followed and a 5xx body is kept only as a bounded, printable excerpt.
    receiver.mode = "redirect";
    world.clock.advanceMs(2_000);
    await drainAll(world);
    log = (await admin.get<Delivery[]>(`/developer/webhooks/${created.data.id}/deliveries`)).data;
    expect(log.every((delivery) => delivery.attempts === 2 && delivery.lastErrorCode === "HTTP_302" && delivery.lastStatusCode === 302)).toBe(true);
    expect(receiver.received.every((request) => request.url.hostname === "hooks.example.test" && request.address?.address === PUBLIC.address)).toBe(true);
    receiver.mode = "error500";
    world.clock.advanceMs(31_000);
    await drainAll(world);
    const snippets = await world.db.webhookDelivery.findMany({ where: { subscriptionId: created.data.id }, select: { responseSnippet: true } });
    expect(snippets.every((row) => row.responseSnippet !== null && !/[^\x20-\x7E]/.test(row.responseSnippet) && row.responseSnippet.length <= 200)).toBe(true);

    // The subscriber recovers: the same events arrive, signed afresh.
    receiver.mode = "ok";
    world.clock.advanceMs(121_000);
    await drainAll(world);
    log = (await admin.get<Delivery[]>(`/developer/webhooks/${created.data.id}/deliveries`)).data;
    expect(log.every((delivery) => delivery.state === "DELIVERED" && delivery.attempts === 4 && delivery.lastStatusCode === 204)).toBe(true);
    const settledEvent = log.find((delivery) => delivery.eventType === "payment.status_changed") as Delivery;
    const attempts = receiver.received.filter((request) => request.headers["x-alqarib-delivery-id"] === settledEvent.id);
    expect(attempts).toHaveLength(4);
    // Same event and delivery identity on every attempt.
    expect(new Set(attempts.map((request) => request.headers["x-alqarib-event-id"]))).toEqual(new Set([settledEvent.eventId]));

    // The receiver's check: exact raw body, timing-safe, ±300 seconds.
    const last = attempts[3] as WebhookRequest;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const verify = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) => verifyWebhookSignature({ secret, rawBody: last.body, timestampHeader: last.headers["x-alqarib-timestamp"], signatureHeader: last.headers["x-alqarib-signature"], nowSeconds, ...overrides });
    expect(verify()).toBe("OK");
    expect(verify({ rawBody: last.body.replace("SETTLED", "FAILED") })).toBe("BAD_SIGNATURE");
    expect(verify({ rawBody: JSON.stringify(JSON.parse(last.body), null, 2) })).toBe("BAD_SIGNATURE");
    expect(verify({ secret: "whsec_wrong" })).toBe("BAD_SIGNATURE");
    expect(verify({ nowSeconds: nowSeconds + 301 })).toBe("STALE_TIMESTAMP");
    expect(verify({ signatureHeader: undefined })).toBe("MISSING_HEADERS");
    const body = JSON.parse(last.body) as { id: string; type: string; schemaVersion: number; corporateReference: string; data: Record<string, unknown> };
    expect(body).toMatchObject({ id: settledEvent.eventId, type: "payment.status_changed", schemaVersion: 1, corporateReference: CORPORATES.A.shortCode });
    expect(body.data["resourceId"]).toBeTruthy();
    // Aggregates and identifiers only: no account number, no beneficiary name.
    expect(last.body).not.toContain(ACCOUNTS.A_OPERATING.ref);
    expect(last.body).not.toContain("Tripoli Office Supplies");
    expect(last.headers["x-alqarib-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);

    // A subscriber that never recovers is dead-lettered after the schedule; the payment stays settled.
    receiver.mode = "timeout";
    const second = await payAndApprove(world, { minor: "30000" });
    await drainAll(world);
    for (const delay of RETRY_SCHEDULE_SECONDS) {
      world.clock.advanceMs((delay + 1) * 1000);
      await drainAll(world);
    }
    log = (await admin.get<Delivery[]>(`/developer/webhooks/${created.data.id}/deliveries`)).data;
    const dead = log.filter((delivery) => delivery.state === "DEAD");
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.every((delivery) => delivery.attempts === RETRY_SCHEDULE_SECONDS.length + 1 && delivery.nextAttemptAt === null)).toBe(true);
    expect((await getPayment(world, second.id)).state).toBe("SETTLED");
    const before = receiver.received.length;
    world.clock.advanceMs(7_200_000);
    await drainAll(world);
    expect(receiver.received.length).toBe(before);

    // Only this corporate's events go to this subscription; another corporate cannot read its log.
    expect(receiver.received.every((request) => (JSON.parse(request.body) as { corporateReference: string }).corporateReference === CORPORATES.A.shortCode)).toBe(true);
    expect((await (await world.as("bFinance")).get(`/developer/webhooks/${created.data.id}/deliveries`)).status).toBe(403);
    // The contract is published without a session.
    const openapi = await world.anonymous().get<undefined>("/openapi.json");
    expect(openapi.status).toBe(200);
    expect((openapi.body as { openapi?: string }).openapi).toBe("3.1.0");
  });
});
