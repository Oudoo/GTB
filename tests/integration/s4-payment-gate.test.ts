/**
 * S4 gate (document 06): bank activation → maker → checker → worker settlement → statement,
 * with exact before/after balances and one trace. Then: the same request twice, and a lost
 * response after posting. Covers E-01/E-02 at the API level, I-05, I-08, I-11, I-18, I-21.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, BANKS, CORPORATES, beneficiaryId } from "@/server/seed/fixtures";
import { demoAgreementProposal } from "@/server/seed/demo";
import { createWorld, type World } from "./support/world";

type PaymentData = {
  id: string;
  reference: string;
  state: string;
  version: number;
  proposalHash: string | null;
  fee: { minor: string };
  totalDebit: { minor: string };
  executionReference: string | null;
  approval: { id: string; version: number; targetRevision: number; payloadHash: string; canAct: boolean; eligibility: string; approvalsCount: number; requiredApprovals: number } | null;
  timeline: Array<{ code: string; toState: string | null; reference: string | null }>;
};

const supplierPayment = (minor = "125000") => ({
  moduleId: "1.1",
  transactionType: "INSTANT_ACCOUNT_CREDIT",
  sourceAccountId: ACCOUNTS.A_OPERATING.id,
  beneficiaryId: beneficiaryId("SUPPLIER"),
  amount: { currency: "LYD", minor },
  purpose: "Supplier invoice DEMO-2026-001",
  clientReference: "DEMO-2026-001",
  execution: { mode: "IMMEDIATE" },
});

async function coreBalance(world: World, ref: string): Promise<bigint> {
  const account = await world.db.simCoreAccount.findUniqueOrThrow({ where: { ref } });
  return account.bookedMinor;
}

async function corporateDayUsage(world: World): Promise<{ consumed: bigint; reserved: bigint }> {
  const counter = await world.db.usageCounter.findFirst({ where: { corporateId: CORPORATES.A.id, scopeKey: "CORPORATE", period: "DAY" } });
  return { consumed: counter?.consumedMinor ?? 0n, reserved: counter?.reservedMinor ?? 0n };
}

describe("S4 gate — complete payment with distinct people", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
  });
  afterAll(async () => world.close());

  it("blocks operational use until a signed agreement is effective (AGR-01, I-04)", async () => {
    const maker = await world.as("aMaker");
    const response = await maker.post("/payments", supplierPayment());
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("AGREEMENT_INACTIVE");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    // Read-only contract view stays available without an active agreement.
    const agreement = await maker.get<{ state: string }>("/agreement");
    expect(agreement.status).toBe(200);
    expect(agreement.data.state).toBe("DRAFT");
  });

  it("one bank admin proposes, the same person cannot activate, another activates (AGR-02, I-05)", async () => {
    const bankDual = await world.as("bankDual"); // holds BOTH bank admin roles
    const proposed = await bankDual.post<{ version: { id: string; approvalRequestId: string; status: string } }>(
      `/bank/corporates/${CORPORATES.A.id}/agreement-proposals`,
      demoAgreementProposal(world.deps, "A"),
    );
    expect(proposed.status).toBe(201);
    expect(proposed.data.version.status).toBe("PENDING_APPROVAL");
    const approvalId = proposed.data.version.approvalRequestId;

    const own = await bankDual.get<{ version: number; targetRevision: number; payloadHash: string; canAct: boolean; eligibility: string }>(`/approvals/${approvalId}`);
    expect(own.data.canAct).toBe(false);
    expect(own.data.eligibility).toBe("OWN_PROPOSAL");
    const selfApproval = await bankDual.post(
      `/approvals/${approvalId}/approve`,
      { proposalVersion: own.data.targetRevision, proposalHash: own.data.payloadHash },
      { ifMatch: own.data.version },
    );
    expect(selfApproval.status).toBe(403);
    expect(selfApproval.body.code).toBe("SELF_APPROVAL_FORBIDDEN");
    expect(await world.db.approvalVote.count({ where: { approvalRequestId: approvalId } })).toBe(0);
    expect((await world.db.agreement.findUniqueOrThrow({ where: { corporateId: CORPORATES.A.id } })).status).toBe("DRAFT");

    const checker = await world.as("bankChecker");
    const review = await checker.get<{ version: number; targetRevision: number; payloadHash: string; canAct: boolean }>(`/approvals/${approvalId}`);
    expect(review.data.canAct).toBe(true);
    const approved = await checker.post<{ state: string }>(
      `/approvals/${approvalId}/approve`,
      { proposalVersion: review.data.targetRevision, proposalHash: review.data.payloadHash },
      { ifMatch: review.data.version },
    );
    expect(approved.status).toBe(200);
    expect(approved.data.state).toBe("APPROVED");

    const agreement = await (await world.as("aMaker")).get<{ state: string; versions: Array<{ status: string }> }>("/agreement");
    expect(agreement.data.state).toBe("ACTIVE");
    expect(agreement.data.versions[0]?.status).toBe("EFFECTIVE");

    const audit = await world.db.auditEvent.findMany({ where: { targetType: "agreementVersion", targetId: proposed.data.version.id }, orderBy: { at: "asc" } });
    expect(audit.map((event) => `${event.action}:${event.result}`)).toEqual([
      "agreement.version.proposed:SUCCESS",
      "approval.vote:DENIED",
      "agreement.version.activated:SUCCESS",
      "approval.approved:SUCCESS",
    ]);
  });

  let paymentId = "";

  it("maker submits LYD 125.000 with an exact, advisory preview (PAY-02, LIM-04)", async () => {
    const maker = await world.as("aMaker");
    const preview = await maker.post<{
      advisory: boolean;
      fee: { minor: string };
      totalDebit: { minor: string };
      projectedAvailable: { minor: string };
      requiredCheckers: number;
      passes: boolean;
    }>("/payments/preview", supplierPayment(), { idempotencyKey: null });
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({
      advisory: true,
      fee: { currency: "LYD", minor: "500" },
      totalDebit: { currency: "LYD", minor: "125500" },
      projectedAvailable: { currency: "LYD", minor: "99874500" },
      requiredCheckers: 1,
      passes: true,
    });
    // A preview reserves nothing.
    expect(await world.db.limitReservation.count()).toBe(0);

    const key = randomUUID();
    const created = await maker.post<PaymentData>("/payments", supplierPayment(), { idempotencyKey: key });
    expect(created.status).toBe(201);
    expect(created.data.state).toBe("DRAFT");
    paymentId = created.data.id;

    // I-11: same key + same body → the same resource; same key + different body → 409.
    const replay = await maker.post<PaymentData>("/payments", supplierPayment(), { idempotencyKey: key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.data.id).toBe(paymentId);
    const conflicting = await maker.post("/payments", supplierPayment("999000"), { idempotencyKey: key });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await world.db.payment.count({ where: { corporateId: CORPORATES.A.id } })).toBe(1);

    const submitted = await maker.post<PaymentData>(`/payments/${paymentId}/submit`, undefined, { ifMatch: created.data.version });
    expect(submitted.status).toBe(202);
    expect(submitted.data.state).toBe("PENDING_APPROVAL");
    expect(submitted.data.fee.minor).toBe("500");
    expect(submitted.data.proposalHash).toMatch(/^[0-9a-f]{64}$/);

    // Submitted content is immutable.
    const edit = await maker.patch(`/payments/${paymentId}`, supplierPayment("130000"), { ifMatch: submitted.data.version, idempotencyKey: null });
    expect(edit.status).toBe(409);
    // The maker cannot approve their own proposal.
    const mine = await maker.get<PaymentData>(`/payments/${paymentId}`);
    const self = await maker.post(
      `/approvals/${mine.data.approval?.id}/approve`,
      { proposalVersion: mine.data.approval?.targetRevision, proposalHash: mine.data.approval?.payloadHash },
      { ifMatch: mine.data.approval?.version ?? 0 },
    );
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("SELF_APPROVAL_FORBIDDEN");
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(100_000_000n);
  });

  it("a different checker reviews the exact recipient, amount and fee, then approves (APR-02)", async () => {
    const checker = await world.as("aChecker1");
    const queue = await checker.get<Array<{ id: string; targetId: string; canAct: boolean; summary: Record<string, unknown>; amount: { minor: string } }>>("/approvals");
    const item = queue.data.find((entry) => entry.targetId === paymentId);
    expect(item?.canAct).toBe(true);
    expect(item?.summary).toMatchObject({
      kind: "PAYMENT",
      amount: { currency: "LYD", minor: "125000" },
      fee: { currency: "LYD", minor: "500" },
      totalDebit: { currency: "LYD", minor: "125500" },
      destination: { name: "Tripoli Office Supplies Demo", maskedReference: "DEMO-LY-••0001", matchStatus: "MATCHED" },
      purpose: "Supplier invoice DEMO-2026-001",
    });

    const detail = await checker.get<PaymentData>(`/payments/${paymentId}`);
    const approval = detail.data.approval as NonNullable<PaymentData["approval"]>;
    const approveBody = { proposalVersion: approval.targetRevision, proposalHash: approval.payloadHash };

    // A vote for a different payload hash is refused.
    const wrongHash = await checker.post(`/approvals/${approval.id}/approve`, { ...approveBody, proposalHash: "0".repeat(64) }, { ifMatch: approval.version });
    expect(wrongHash.status).toBe(412);

    const key = randomUUID();
    const approved = await checker.post<{ state: string; approvalsCount: number }>(`/approvals/${approval.id}/approve`, approveBody, { ifMatch: approval.version, idempotencyKey: key });
    expect(approved.status).toBe(200);
    expect(approved.data).toMatchObject({ state: "APPROVED", approvalsCount: 1 });

    // Lost response: the client repeats the SAME request (stale If-Match included) → replay.
    const repeated = await checker.post<{ approvalsCount: number }>(`/approvals/${approval.id}/approve`, approveBody, { ifMatch: approval.version, idempotencyKey: key });
    expect(repeated.status).toBe(200);
    expect(repeated.headers.get("idempotent-replay")).toBe("true");
    expect(repeated.data.approvalsCount).toBe(1);
    expect(await world.db.approvalVote.count({ where: { approvalRequestId: approval.id } })).toBe(1);

    // Approved and queued: limit reserved, nothing debited yet.
    const queued = await checker.get<PaymentData>(`/payments/${paymentId}`);
    expect(queued.data.state).toBe("QUEUED");
    expect(await corporateDayUsage(world)).toEqual({ consumed: 0n, reserved: 125_000n });
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(100_000_000n);
  });

  it("the worker settles through the simulated core with exact balances and one trace (PAY-04, LIM-02)", async () => {
    await world.drain();
    const maker = await world.as("aMaker");
    const settled = await maker.get<PaymentData>(`/payments/${paymentId}`);
    expect(settled.data.state).toBe("SETTLED");
    const reference = settled.data.executionReference as string;
    expect(reference).toMatch(/^AQ[0-9A-F]{32}A1$/);

    // Source fell by principal + fee; settlement control and fee income received each part.
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(100_000_000n - 125_500n);
    expect(await coreBalance(world, `${BANKS.A.code}:SIM-GL-LYPAY-SETTLEMENT`)).toBe(125_000n);
    expect(await coreBalance(world, `${BANKS.A.code}:SIM-GL-FEE-INCOME`)).toBe(500n);

    // Exactly one journal for the instruction, and it balances.
    const journals = await world.db.simCoreJournal.findMany({ where: { executionReference: { startsWith: reference } }, include: { entries: true } });
    expect(journals).toHaveLength(1);
    expect((journals[0]?.entries ?? []).reduce((sum, entry) => sum + entry.signedMinor, 0n)).toBe(0n);

    // Outgoing usage rose by the PRINCIPAL only, and the reservation was consumed once.
    expect(await corporateDayUsage(world)).toEqual({ consumed: 125_000n, reserved: 0n });
    const usage = await maker.get<{ rows: Array<{ level: string; period: string; consumed: { minor: string } | null; remaining: { minor: string } | null }> }>("/limits/usage");
    const corporateDay = usage.data.rows.find((row) => row.level === "CORPORATE" && row.period === "DAY");
    expect(corporateDay?.consumed?.minor).toBe("125000");
    expect(corporateDay?.remaining?.minor).toBe("29875000");
    const userDay = usage.data.rows.find((row) => row.level === "USER" && row.period === "DAY");
    expect(userDay?.consumed?.minor).toBe("125000");

    // Statement, timeline and audit all refer to the same instruction reference.
    const statement = await maker.get<{ lines: Array<{ reference: string | null; kind: string; signedMinor: string; description: string }> }>(
      `/accounts/${ACCOUNTS.A_OPERATING.id}/statements`,
    );
    const lines = statement.data.lines.filter((line) => line.reference === reference);
    expect(lines.map((line) => `${line.kind}:${line.signedMinor}`).sort()).toEqual(["FEE:-500", "PAYMENT:-125000"]);
    expect(lines[0]?.description).toContain(settled.data.reference);
    expect(settled.data.timeline.filter((event) => event.reference === reference).map((event) => event.toState)).toEqual(["PROCESSING", "SETTLED"]);
    expect(settled.data.timeline.map((event) => event.toState)).toEqual([
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "QUEUED",
      "PROCESSING",
      "SUBMITTED",
      "SETTLED",
    ]);
    const audit = await world.db.auditEvent.findMany({ where: { targetType: "payment", targetId: paymentId }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    expect(audit.map((event) => event.action)).toEqual([
      "payment.created",
      "payment.submitted",
      "approval.vote",
      "approval.approved",
      "payment.execution.processing",
      "payment.execution.submitted",
      "payment.execution.settled",
    ]);
    const people = new Set(audit.filter((event) => event.result === "SUCCESS" && event.actorPersonId !== null).map((event) => event.actorPersonId));
    expect(people.size).toBe(2); // maker and checker are different humans
    // The worker's audit rows carry the same stable execution reference as the statement line.
    const execution = audit.filter((event) => event.action.startsWith("payment.execution."));
    expect(execution.every((event) => event.actorKind === "SERVICE" && event.actorService === "worker")).toBe(true);
    const settledAudit = execution.find((event) => event.action === "payment.execution.settled");
    expect((settledAudit?.changes as { reference?: string } | null)?.reference).toBe(reference);

    // Running the worker again changes nothing.
    await world.drain();
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(99_874_500n);
    expect(await world.db.simCoreJournal.count({ where: { kind: "EXTERNAL_TRANSFER" } })).toBe(1);
  });

  it("losing the response AFTER posting yields STATUS_UNKNOWN, then one debit by inquiry (I-18)", async () => {
    const maker = await world.as("aMaker");
    const checker = await world.as("aChecker1");
    const before = await coreBalance(world, ACCOUNTS.A_OPERATING.ref);

    const created = await maker.post<PaymentData>("/payments", { ...supplierPayment("200000"), beneficiaryId: beneficiaryId("TIMEOUT_AFTER"), clientReference: "DEMO-2026-002" });
    const submitted = await maker.post<PaymentData>(`/payments/${created.data.id}/submit`, undefined, { ifMatch: created.data.version });
    const approval = submitted.data.approval as NonNullable<PaymentData["approval"]>;
    await checker.post(`/approvals/${approval.id}/approve`, { proposalVersion: approval.targetRevision, proposalHash: approval.payloadHash }, { ifMatch: approval.version });
    await world.drain();

    const unknown = await maker.get<PaymentData>(`/payments/${created.data.id}`);
    expect(unknown.data.state).toBe("STATUS_UNKNOWN");
    const reference = unknown.data.executionReference as string;
    // The core DID book it — the platform simply does not know yet.
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(before - 200_500n);
    // The reservation is kept while the outcome is unknown.
    expect((await corporateDayUsage(world)).reserved).toBe(200_000n);

    // Nothing can retry or cancel it; a second submission of the same request replays.
    const cancel = await maker.post(`/payments/${created.data.id}/cancel`, { reason: "try to cancel unknown" }, { ifMatch: unknown.data.version });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe("STATUS_UNRESOLVED");
    await world.drain();
    expect(await world.db.simCoreJournal.count({ where: { executionReference: reference } })).toBe(1);

    // The automatic inquiry becomes due later; it resolves by the ORIGINAL reference.
    world.clock.advanceMinutes(61);
    await world.drain();
    const resolved = await maker.get<PaymentData>(`/payments/${created.data.id}`);
    expect(resolved.data.state).toBe("SETTLED");
    expect(resolved.data.executionReference).toBe(reference);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: { startsWith: reference } } })).toBe(1);
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(before - 200_500n);
    expect(await corporateDayUsage(world)).toEqual({ consumed: 325_000n, reserved: 0n });
    expect(resolved.data.timeline.map((event) => event.code)).toContain("PAYMENT_STATUS_UNKNOWN");
  });

  it("a definitive pre-posting rejection releases funds and quota exactly once (I-21)", async () => {
    const maker = await world.as("aMaker");
    const checker = await world.as("aChecker1");
    const before = await coreBalance(world, ACCOUNTS.A_OPERATING.ref);
    const usageBefore = await corporateDayUsage(world);

    const created = await maker.post<PaymentData>("/payments", { ...supplierPayment("300000"), beneficiaryId: beneficiaryId("BLOCKED"), clientReference: "DEMO-2026-003" });
    const submitted = await maker.post<PaymentData>(`/payments/${created.data.id}/submit`, undefined, { ifMatch: created.data.version });
    const approval = submitted.data.approval as NonNullable<PaymentData["approval"]>;
    await checker.post(`/approvals/${approval.id}/approve`, { proposalVersion: approval.targetRevision, proposalHash: approval.payloadHash }, { ifMatch: approval.version });
    expect((await corporateDayUsage(world)).reserved).toBe(300_000n);
    await world.drain();

    const failed = await maker.get<PaymentData & { failureCode: string }>(`/payments/${created.data.id}`);
    expect(failed.data.state).toBe("FAILED");
    expect(failed.data.failureCode).toBe("BENEFICIARY_ACCOUNT_BLOCKED");
    expect(await coreBalance(world, ACCOUNTS.A_OPERATING.ref)).toBe(before);
    expect(await corporateDayUsage(world)).toEqual(usageBefore);
    const holds = await world.db.simCoreHold.findMany({ where: { reference: { startsWith: failed.data.executionReference as string } } });
    expect(holds.map((hold) => hold.state)).toEqual(["RELEASED"]);
    const balance = await maker.get<{ available: { minor: string }; holds: { minor: string } }>(`/accounts/${ACCOUNTS.A_OPERATING.id}/balance`);
    expect(balance.data.holds.minor).toBe("0");
    expect(balance.data.available.minor).toBe(before.toString());
  });
});
