/**
 * Deeper money-movement checks on real PostgreSQL (document 07): concurrency, shared limits,
 * policy re-check at release, fee change, returns, internal transfers, window boundaries,
 * forged authority, audit immutability and sign-in throttling.
 * Covers I-02, I-03, I-04, I-06, I-07, I-09, I-10, I-12, I-13, I-14, I-15, I-16, I-17, I-20,
 * I-22, I-23, I-24, I-44 and I-52. Vote and idempotency races use 20 simultaneous requests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_ATTEMPT_ADVANCE } from "@/server/domain/execution/engine";
import { JOB_PAYMENT_RELEASE } from "@/server/domain/payments/service";
import { claimJobs } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { ACCOUNTS, BANKS, CORPORATES, personId } from "@/server/seed/fixtures";
import { demoAgreementProposal } from "@/server/seed/demo";
import { approve, coreBalance, coreHolds, getPayment, payAndApprove, paymentBody, submitPayment, usage, type PaymentData } from "./support/payments";
import { createWorld, race, TEST_PASSWORD, type ApiResult, type World } from "./support/world";

const OPERATING = ACCOUNTS.A_OPERATING;
const SAVINGS = ACCOUNTS.A_SAVINGS;

async function drainAll(world: World): Promise<void> {
  while ((await world.drain(2_000)) > 0) {
    /* until no job is due */
  }
}
const pendingApproval = (payment: PaymentData) => (payment.approval as NonNullable<PaymentData["approval"]>).id;

/**
 * Approving votes prepared in advance (each voter has read the proposal) and then released at
 * the same instant. A voter listed several times sends the same vote several times.
 */
async function approveAtOnce(world: World, approvalId: string, voters: readonly string[]): Promise<ApiResult[]> {
  const calls: Array<() => Promise<ApiResult>> = [];
  for (const voter of voters) {
    const actor = await world.as(voter);
    const approval = await actor.get<{ version: number; targetRevision: number; payloadHash: string }>(`/approvals/${approvalId}`);
    if (approval.status !== 200) throw new Error(`${voter} cannot read the proposal: ${approval.status}`);
    calls.push(() => actor.post(`/approvals/${approvalId}/approve`, { proposalVersion: approval.data.targetRevision, proposalHash: approval.data.payloadHash }, { ifMatch: approval.data.version }));
  }
  return race(calls);
}
const times = (count: number, voter: string) => Array.from({ length: count }, () => voter);

/** Submit and collect every approval the amount needs (two checkers from LYD 2,000). */
async function payFullyApproved(world: World, overrides: Parameters<typeof submitPayment>[1], maker: string): Promise<PaymentData> {
  const submitted = await submitPayment(world, overrides, maker);
  for (const checker of ["aChecker1", "aChecker2"]) {
    const current = await getPayment(world, submitted.id, maker);
    if (current.state !== "PENDING_APPROVAL") break;
    const vote = await approve(world, pendingApproval(current), checker);
    if (vote.status !== 200) throw new Error(`approve failed: ${vote.status} ${vote.text}`);
  }
  return getPayment(world, submitted.id, maker);
}

describe("payment concurrency and shared limits", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  it("one checker approving twenty times at once casts one vote and starts one execution (I-09)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const usageBefore = await usage(world);
    const payment = await submitPayment(world, { minor: "100000" });
    const approvalId = pendingApproval(payment);
    const results = await approveAtOnce(world, approvalId, times(20, "aChecker1"));
    expect(results).toHaveLength(20);
    expect(results.some((result) => result.status === 200)).toBe(true);
    expect(results.every((result) => [200, 409, 412].includes(result.status))).toBe(true);
    expect(await world.db.approvalVote.count({ where: { approvalRequestId: approvalId } })).toBe(1);
    // One vote, one reservation, one release job — whatever the twenty answers were.
    expect((await usage(world)).reserved).toBe(usageBefore.reserved + 100_000n);
    expect(await world.db.job.count({ where: { type: JOB_PAYMENT_RELEASE, aggregateId: payment.id } })).toBe(1);
    await drainAll(world);
    expect((await getPayment(world, payment.id)).state).toBe("SETTLED");
    expect(await world.db.executionAttempt.count({ where: { instruction: { paymentId: payment.id } } })).toBe(1);
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 100_500n);
    expect(await usage(world)).toEqual({ consumed: usageBefore.consumed + 100_000n, reserved: usageBefore.reserved });
  });

  it("two different checkers racing for the final approval produce one transition and one debit (I-10)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const usageBefore = await usage(world);
    const payment = await submitPayment(world, { minor: "200000" });
    const approvalId = pendingApproval(payment);
    const results = await approveAtOnce(world, approvalId, [...times(10, "aChecker1"), ...times(10, "aChecker2")]);
    expect(results.every((result) => [200, 409, 412].includes(result.status))).toBe(true);
    // One checker's vote decided it; the other checker was too late and added nothing.
    const votes = await world.db.approvalVote.findMany({ where: { approvalRequestId: approvalId } });
    expect(votes).toHaveLength(1);
    const winner = votes[0]?.personId === personId("aChecker1") ? "aChecker1" : "aChecker2";
    expect(votes[0]?.personId).toBe(personId(winner));
    const accepted = results.map((result, index) => ({ status: result.status, voter: index < 10 ? "aChecker1" : "aChecker2" })).filter((entry) => entry.status === 200);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(new Set(accepted.map((entry) => entry.voter))).toEqual(new Set([winner]));
    expect(await world.db.job.count({ where: { type: JOB_PAYMENT_RELEASE, aggregateId: payment.id } })).toBe(1);
    // Reserved once at approval…
    expect((await usage(world)).reserved).toBe(usageBefore.reserved + 200_000n);
    await drainAll(world);
    // …consumed once at settlement.
    expect(await usage(world)).toEqual({ consumed: usageBefore.consumed + 200_000n, reserved: usageBefore.reserved });
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 200_500n);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: (await getPayment(world, payment.id)).executionReference as string } })).toBe(1);
  });

  it("twenty identical create requests sent at once create one payment (I-12)", async () => {
    const maker = await world.as("aMaker");
    const body = paymentBody({ minor: "30000" });
    const key = crypto.randomUUID();
    const before = await world.db.payment.count();
    const results = await race(Array.from({ length: 20 }, () => () => maker.post<PaymentData>("/payments", body, { idempotencyKey: key })));
    expect(results).toHaveLength(20);
    expect(results.some((result) => result.status === 201)).toBe(true);
    // Either both answer with the same resource, or the second is told a request is in progress.
    expect(results.every((result) => result.status === 201 || (result.status === 409 && result.body.code === "REQUEST_IN_PROGRESS"))).toBe(true);
    const ids = new Set(results.filter((result) => result.status === 201).map((result) => result.data.id));
    expect(ids.size).toBe(1);
    expect(await world.db.payment.count()).toBe(before + 1);
    // The same key with a different body is a conflict, not a second payment.
    const different = await maker.post("/payments", paymentBody({ minor: "30001" }), { idempotencyKey: key });
    expect(different.status).toBe(409);
    expect(different.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await world.db.payment.count()).toBe(before + 1);
  });

  it("two payments that fit one by one cannot both reserve the last of a user's daily limit (I-13)", async () => {
    // The maker's daily allowance is LYD 10,000. Bring usage to 9,400 in three settled payments.
    const spent = (await usage(world, `USER:membership:${(await world.db.membership.findFirstOrThrow({ where: { corporateId: CORPORATES.A.id, person: { email: { startsWith: "a.maker@" } } } })).id}`)).consumed;
    let remainingToSpend = 9_400_000n - spent;
    while (remainingToSpend > 0n) {
      const amount = remainingToSpend > 3_000_000n ? 3_000_000n : remainingToSpend;
      await payFullyApproved(world, { minor: amount.toString() }, "aMaker");
      remainingToSpend -= amount;
    }
    await drainAll(world);
    const scope = `USER:membership:${(await world.db.membership.findFirstOrThrow({ where: { corporateId: CORPORATES.A.id, person: { email: { startsWith: "a.maker@" } } } })).id}`;
    expect((await usage(world, scope)).consumed).toBe(9_400_000n);
    const balance = await coreBalance(world, OPERATING.ref);
    // Each LYD 400 payment fits the remaining 600 on its own; together they do not.
    const first = await submitPayment(world, { minor: "400000" });
    const second = await submitPayment(world, { minor: "400000" });
    const results = await race([() => approve(world, pendingApproval(first), "aChecker1"), () => approve(world, pendingApproval(second), "aChecker2")]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
    expect(results.find((result) => result.status === 422)?.body.code).toBe("USER_LIMIT_EXCEEDED");
    const after = await usage(world, scope);
    expect(after.consumed + after.reserved).toBe(9_800_000n);
    await drainAll(world);
    expect(await coreBalance(world, OPERATING.ref)).toBe(balance - 400_500n);
    const counters = await world.db.usageCounter.findMany({ where: { corporateId: CORPORATES.A.id } });
    expect(counters.every((counter) => counter.consumedMinor >= 0n && counter.reservedMinor >= 0n)).toBe(true);
    // The refused vote left its payment pending and unreserved; nothing was debited for it.
    const states = [(await getPayment(world, first.id)).state, (await getPayment(world, second.id)).state].sort();
    expect(states).toEqual(["PENDING_APPROVAL", "SETTLED"]);
  });

  it("payments from different accounts, types and people still share the corporate daily limit (I-14)", async () => {
    // Corporate daily limit LYD 30,000; each payment module allows LYD 20,000 a day on its own.
    const corporateUsed = async () => {
      const current = await usage(world);
      return current.consumed + current.reserved;
    };
    // The treasurer brings corporate usage to exactly 27,000 across instant and ACH payments.
    await payFullyApproved(world, { minor: "5000000", source: "A_SAVINGS" }, "aTreasurer");
    await payFullyApproved(world, { minor: "3000000", source: "A_SAVINGS" }, "aTreasurer");
    let rest = 27_000_000n - (await corporateUsed());
    while (rest > 0n) {
      const amount = rest > 8_000_000n ? 8_000_000n : rest;
      await payFullyApproved(world, { minor: amount.toString(), source: "A_SAVINGS", transactionType: "ACH_CREDIT" }, "aTreasurer");
      rest -= amount;
    }
    await drainAll(world);
    expect(await corporateUsed()).toBe(27_000_000n);
    // LYD 1,900 instant from the operating account and LYD 1,900 ACH from savings, by two people.
    // Each fits its own module and its maker's allowance; together they would reach 30,800.
    const instant = await submitPayment(world, { minor: "1900000", source: "A_OPERATING" }, "aDual");
    const ach = await submitPayment(world, { minor: "1900000", source: "A_SAVINGS", transactionType: "ACH_CREDIT" }, "aTreasurer");
    const results = await race([() => approve(world, pendingApproval(instant), "aChecker1"), () => approve(world, pendingApproval(ach), "aChecker2")]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
    expect(results.find((result) => result.status === 422)?.body.code).toBe("CORPORATE_DAILY_LIMIT_EXCEEDED");
    await drainAll(world);
    expect(await corporateUsed()).toBe(28_900_000n);
    // Exactly one of the two went ahead; the other is still waiting and reserved nothing.
    const states = [(await getPayment(world, instant.id, "aDual")).state, (await getPayment(world, ach.id, "aTreasurer")).state];
    expect(states.filter((state) => state === "PENDING_APPROVAL")).toHaveLength(1);
    const counters = await world.db.usageCounter.findMany({ where: { corporateId: CORPORATES.A.id } });
    expect(counters.every((counter) => counter.consumedMinor >= 0n && counter.reservedMinor >= 0n)).toBe(true);
  });
});

describe("re-check at release and fee change", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
    await world.activateAgreement("B");
  });
  afterAll(async () => world.close());

  it("does not execute an approved payment after its maker was suspended (I-15)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const executeAt = new Date(world.clock.now().getTime() + 2 * 3_600_000).toISOString();
    const scheduled = await payAndApprove(world, { minor: "150000", executeAt }, "aDual", "aChecker1");
    expect(scheduled.state).toBe("SCHEDULED");
    const member = await world.db.membership.findFirstOrThrow({ where: { corporateId: CORPORATES.A.id, person: { email: { startsWith: "a.dual@" } } } });
    const suspended = await (await world.as("aAdmin")).post(`/admin/users/${member.id}/suspend`, { reason: "Left the company before the payment date" }, { ifMatch: member.version });
    expect(suspended.status).toBe(200);
    world.clock.advanceMs(2 * 3_600_000 + 60_000);
    await drainAll(world);
    const blocked = await getPayment(world, scheduled.id, "aMaker");
    expect(blocked.state).not.toBe("SETTLED");
    expect(blocked.releaseBlockCode).toBe("MAKER_INELIGIBLE");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);
    expect(await world.db.executionAttempt.count({ where: { instruction: { paymentId: scheduled.id } } })).toBe(0);
  });

  it("asks for approval again when the fee changed after approval — never charges the new fee silently (I-16)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const executeAt = new Date(world.clock.now().getTime() + 3 * 3_600_000).toISOString();
    const scheduled = await payAndApprove(world, { minor: "100000", executeAt });
    expect(scheduled).toMatchObject({ state: "SCHEDULED", fee: { minor: "500" } });
    // The bank activates a revision whose instant-payment fee is LYD 0.750.
    const proposal = demoAgreementProposal(world.deps, "A");
    for (const terms of proposal.terms.moduleTerms) for (const rule of terms.feeRules) if (rule.transactionType === "INSTANT_ACCOUNT_CREDIT") rule.minor = "750";
    const bankMaker = await world.as("bankMaker");
    const proposed = await bankMaker.post<{ version: { approvalRequestId: string } }>(`/bank/corporates/${CORPORATES.A.id}/agreement-proposals`, proposal);
    expect(proposed.status).toBe(201);
    expect((await approve(world, proposed.data.version.approvalRequestId, "bankChecker")).status).toBe(200);

    world.clock.advanceMs(3 * 3_600_000 + 60_000);
    await drainAll(world);
    const waiting = await getPayment(world, scheduled.id);
    // Not paid at the old fee, not paid at the new fee: back to the checker with the new figures.
    expect(waiting.state).toBe("PENDING_APPROVAL");
    expect(waiting.fee.minor).toBe("750");
    expect(waiting.timeline.map((event) => event.code)).toContain("REAPPROVAL_REQUIRED");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);
    const again = pendingApproval(waiting);
    expect(again).not.toBe(pendingApproval(scheduled));
    expect((await approve(world, again, "aChecker2")).status).toBe(200);
    await drainAll(world);
    expect((await getPayment(world, scheduled.id)).state).toBe("SETTLED");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 100_750n);
  });

});

describe("agreement revisions under concurrency", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  it("activates a revision once and never leaves two sets of terms in force (I-06)", async () => {
    const url = `/bank/corporates/${CORPORATES.A.id}/agreement-proposals`;
    const versionsOf = () => world.db.agreementVersion.findMany({ where: { corporateId: CORPORATES.A.id }, orderBy: { versionNo: "asc" } });
    expect((await versionsOf()).map((version) => version.status)).toEqual(["EFFECTIVE"]);

    // The first revision has been in force for a minute when its replacement is proposed.
    world.clock.advanceMinutes(1);
    const proposal = demoAgreementProposal(world.deps, "A");
    for (const terms of proposal.terms.moduleTerms) for (const rule of terms.feeRules) if (rule.transactionType === "INSTANT_ACCOUNT_CREDIT") rule.minor = "750";
    const bankMaker = await world.as("bankMaker");
    const bankDual = await world.as("bankDual");
    // Two administrators propose a revision of the same agreement at the same instant.
    const proposals = await race([
      () => bankMaker.post<{ version: { id: string; approvalRequestId: string } }>(url, proposal),
      () => bankDual.post<{ version: { id: string; approvalRequestId: string } }>(url, proposal),
    ]);
    expect(proposals.map((result) => result.status).sort()).toEqual([201, 409]);
    const accepted = proposals.find((result) => result.status === 201) as (typeof proposals)[number];
    const proposer = proposals.indexOf(accepted) === 0 ? "bankMaker" : "bankDual";
    const approvalId = accepted.data.version.approvalRequestId;
    expect((await versionsOf()).map((version) => version.status)).toEqual(["EFFECTIVE", "PENDING_APPROVAL"]);
    // Nothing changed for customers yet: the pending revision is not in force.
    expect((await submitPayment(world, { minor: "10000" })).fee.minor).toBe("500");

    // Everyone entitled to decide votes at once, twenty requests in all; the proposer's own
    // votes are refused whatever roles they hold.
    const others = ["bankMaker", "bankDual"].filter((key) => key !== proposer);
    const voters = [...times(10, "bankChecker"), ...times(5, others[0] as string), ...times(5, proposer)];
    const calls: Array<() => Promise<ApiResult>> = [];
    for (const voter of voters) {
      const actor = await world.as(voter);
      const approval = await actor.get<{ version: number; targetRevision: number; payloadHash: string }>(`/approvals/${approvalId}`);
      expect(approval.status).toBe(200);
      calls.push(() => actor.post(`/approvals/${approvalId}/approve`, { proposalVersion: approval.data.targetRevision, proposalHash: approval.data.payloadHash }, { ifMatch: approval.data.version }));
    }
    const results = await race(calls);
    const byVoter = (voter: string) => results.filter((_result, index) => voters[index] === voter);
    expect(byVoter(proposer).every((result) => result.status === 403 || result.status === 409)).toBe(true);
    expect(byVoter(proposer).every((result) => result.status !== 200)).toBe(true);
    expect(results.filter((result) => result.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((result) => [200, 403, 409, 412].includes(result.status))).toBe(true);

    const votes = await world.db.approvalVote.findMany({ where: { approvalRequestId: approvalId } });
    expect(votes).toHaveLength(1);
    expect(votes[0]?.personId).not.toBe(personId(proposer));
    expect([personId("bankChecker"), personId(others[0] as string)]).toContain(votes[0]?.personId);

    // One outcome: the old revision ends exactly where the new one starts.
    const versions = await versionsOf();
    expect(versions.map((version) => version.status)).toEqual(["SUPERSEDED", "EFFECTIVE"]);
    const [previous, current] = versions as [(typeof versions)[number], (typeof versions)[number]];
    expect(previous.effectiveFrom.getTime()).toBeLessThan(current.effectiveFrom.getTime());
    expect(previous.effectiveUntil.getTime()).toBe(current.effectiveFrom.getTime());
    const now = world.clock.now().getTime();
    const inForce = versions.filter((version) => ["APPROVED", "EFFECTIVE"].includes(version.status) && version.effectiveFrom.getTime() <= now && now < version.effectiveUntil.getTime());
    expect(inForce.map((version) => version.id)).toEqual([accepted.data.version.id]);
    expect(await world.db.auditEvent.count({ where: { action: "agreement.version.activated", targetId: accepted.data.version.id } })).toBe(1);
    // The new terms apply from now on, once.
    expect((await submitPayment(world, { minor: "10000" })).fee.minor).toBe("750");
  });
});

describe("an agreement binds only while it is in force", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
  });
  afterAll(async () => world.close());

  const stateOf = async () => (await (await world.as("aMaker")).get<{ state: string }>("/agreement")).data.state;
  const createPayment = async () => (await world.as("aMaker")).post("/payments", paymentBody({ minor: "50000" }));
  const refusedWithoutAgreement = async (where: string) => {
    const response = await createPayment();
    expect(response.status, where).toBe(422);
    expect(response.body.code, where).toBe("AGREEMENT_INACTIVE");
  };

  it("not before its start, not from its end, and never without signature evidence (I-04, AGR-01)", async () => {
    const start = new Date(world.clock.now().getTime() + 3_600_000);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    // No signature evidence: the proposal itself is refused.
    const unsigned = { ...demoAgreementProposal(world.deps, "A", { effectiveFrom: start, effectiveUntil: end }), signatureEvidence: [] };
    expect((await (await world.as("bankMaker")).post(`/bank/corporates/${CORPORATES.A.id}/agreement-proposals`, unsigned)).status).toBe(400);
    expect(await world.db.agreementVersion.count({ where: { corporateId: CORPORATES.A.id } })).toBe(0);
    expect(await stateOf()).toBe("DRAFT");
    await refusedWithoutAgreement("draft");

    // Approved by two people, but it starts in an hour: nothing may be paid yet.
    await world.activateAgreement("A", { effectiveFrom: start, effectiveUntil: end });
    expect(await stateOf()).toBe("NOT_YET_EFFECTIVE");
    await refusedWithoutAgreement("before the start");
    world.clock.advanceMs(3_600_000 - 1);
    await refusedWithoutAgreement("one millisecond before the start");

    // The start instant is inside the period — with no worker having run in between.
    world.clock.advanceMs(1);
    expect(await stateOf()).toBe("ACTIVE");
    const before = await coreBalance(world, OPERATING.ref);
    const paid = await payAndApprove(world, { minor: "10000" });
    await drainAll(world);
    expect((await getPayment(world, paid.id)).state).toBe("SETTLED");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 10_500n);

    // A payment approved inside the period but not yet executed when the period ends.
    world.clock.advanceMs(2 * 3_600_000 - 60_000 - 1);
    expect(await stateOf()).toBe("ACTIVE");
    const late = await payAndApprove(world, { minor: "20000" });
    expect(late.state).toBe("QUEUED");
    // The end instant is outside the period.
    world.clock.advanceMs(60_000 + 1);
    expect(await stateOf()).toBe("EXPIRED");
    await refusedWithoutAgreement("at the end");
    await drainAll(world);
    const blocked = await getPayment(world, late.id);
    expect(blocked.state).toBe("APPROVED");
    expect(blocked.releaseBlockCode).toBe("AGREEMENT_INACTIVE");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 10_500n);
    expect(await world.db.executionAttempt.count({ where: { instruction: { paymentId: late.id } } })).toBe(0);
    // The contract and its history stay readable.
    const history = await (await world.as("aMaker")).get<{ versions: Array<{ status: string }> }>("/agreement");
    expect(history.status).toBe(200);
    expect(history.data.versions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("emergency stop of an agreement", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  it("stops new and already approved payments at once; lifting it needs a second administrator (I-04, AGR-02)", async () => {
    const corporate = CORPORATES.A.id;
    const maker = await world.as("aMaker");
    const bankMaker = await world.as("bankMaker");
    const before = await coreBalance(world, OPERATING.ref);
    const usageBefore = await usage(world);
    const agreementVersion = async () => (await world.db.agreement.findUniqueOrThrow({ where: { corporateId: corporate } })).version;
    const stateOf = async () => (await maker.get<{ state: string }>("/agreement")).data.state;

    // One payment is approved and waiting for the worker; another is waiting for its approval.
    const approved = await payAndApprove(world, { minor: "200000" });
    expect(approved.state).toBe("QUEUED");
    const pending = await submitPayment(world, { minor: "30000" });
    expect((await usage(world)).reserved).toBe(usageBefore.reserved + 200_000n);

    // A corporate person cannot stop or lift anything; a stale version is refused.
    expect([403, 404]).toContain((await maker.post(`/bank/corporates/${corporate}/suspend`, { reason: "not a bank user" }, { ifMatch: await agreementVersion() })).status);
    expect((await bankMaker.post(`/bank/corporates/${corporate}/suspend`, { reason: "stale version (test)" }, { ifMatch: (await agreementVersion()) - 1 })).status).toBe(412);
    expect(await stateOf()).toBe("ACTIVE");
    const stopped = await bankMaker.post(`/bank/corporates/${corporate}/suspend`, { reason: "Emergency stop requested by compliance (test)" }, { ifMatch: await agreementVersion() });
    expect(stopped.status).toBe(200);
    expect(await stateOf()).toBe("SUSPENDED");

    // Nothing new, no approval, no release — immediately, before any worker ran.
    const refused = await maker.post("/payments", paymentBody({ minor: "50000" }));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("AGREEMENT_INACTIVE");
    const vote = await approve(world, pendingApproval(pending), "aChecker1");
    expect(vote.status).toBe(422);
    expect(vote.body.code).toBe("AGREEMENT_INACTIVE");
    expect(await world.db.approvalVote.count({ where: { approvalRequestId: pendingApproval(pending) } })).toBe(0);
    await drainAll(world);
    const blocked = await getPayment(world, approved.id);
    expect(blocked.state).toBe("APPROVED");
    expect(blocked.releaseBlockCode).toBe("AGREEMENT_INACTIVE");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);
    expect(await world.db.executionAttempt.count({ where: { instruction: { paymentId: approved.id } } })).toBe(0);
    // The blocked payment holds no limit while it cannot run.
    expect(await usage(world)).toEqual(usageBefore);
    // Asking for the release again does not help while the stop is in place.
    const early = await maker.post(`/payments/${approved.id}/retry-release`, undefined, { ifMatch: blocked.version });
    await drainAll(world);
    expect([202, 409, 422]).toContain(early.status);
    expect((await getPayment(world, approved.id)).state).toBe("APPROVED");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);

    // Lifting the stop: proposed by one administrator, decided by another.
    const proposed = await bankMaker.post(`/bank/corporates/${corporate}/restore-proposals`, { reason: "Review completed, stop lifted (test)" });
    expect(proposed.status).toBe(201);
    const request = await world.db.approvalRequest.findFirstOrThrow({ where: { targetType: "agreementRestore", state: "PENDING" } });
    expect((await approve(world, request.id, "bankMaker")).status).toBe(403);
    expect(await stateOf()).toBe("SUSPENDED");
    expect((await approve(world, request.id, "bankChecker")).status).toBe(200);
    expect(await stateOf()).toBe("ACTIVE");

    // Nothing starts by itself. The maker asks again; every control is re-checked; one debit.
    await drainAll(world);
    const still = await getPayment(world, approved.id);
    expect(still.state).toBe("APPROVED");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);
    const retried = await maker.post(`/payments/${approved.id}/retry-release`, undefined, { ifMatch: still.version });
    expect(retried.status).toBe(202);
    await drainAll(world);
    expect((await getPayment(world, approved.id)).state).toBe("SETTLED");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 200_500n);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: (await getPayment(world, approved.id)).executionReference as string } })).toBe(1);
    // The pending one can now be decided as usual.
    expect((await approve(world, pendingApproval(pending), "aChecker1")).status).toBe(200);

    const actions = (await world.db.auditEvent.findMany({ where: { corporateId: corporate, action: { startsWith: "agreement." }, result: "SUCCESS" }, orderBy: { id: "asc" } })).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["agreement.suspended", "agreement.restore.proposed", "agreement.restored"]));
    const stop = await world.db.auditEvent.findFirstOrThrow({ where: { corporateId: corporate, action: "agreement.suspended" } });
    expect(stop.actorPersonId).toBe(personId("bankMaker"));
    expect(stop.reason).toContain("Emergency stop");
  });
});

describe("rail events and returns", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  it("keeps one posting and a forward-only status under duplicate and out-of-order rail events (I-20)", async () => {
    for (const beneficiary of ["DUPLICATE_EVENT", "OUT_OF_ORDER"] as const) {
      const before = await coreBalance(world, OPERATING.ref);
      const payment = await payAndApprove(world, { minor: "50000", beneficiary, transactionType: "ACH_CREDIT" });
      await drainAll(world);
      world.clock.advanceMs(10 * 60_000);
      await drainAll(world);
      await drainAll(world);
      const done = await getPayment(world, payment.id);
      expect(done.state, beneficiary).toBe("SETTLED");
      expect(await world.db.simCoreJournal.count({ where: { executionReference: done.executionReference as string } })).toBe(1);
      const states = done.timeline.map((event) => event.toState).filter((state): state is string => state !== null);
      expect(states.filter((state) => state === "SETTLED")).toHaveLength(1);
      expect(states.indexOf("SETTLED")).toBe(states.length - 1);
      const fee = BigInt(done.fee.minor);
      expect(await coreBalance(world, OPERATING.ref)).toBe(before - 50_000n - fee);
    }
  });

  it("books a linked compensation for a return, keeps the original and does not free past usage (I-22)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const payment = await payAndApprove(world, { minor: "80000", beneficiary: "LATE_RETURN", transactionType: "ACH_CREDIT" });
    await drainAll(world);
    // The synthetic ACH rail settles a few seconds after acceptance and, for this recipient,
    // sends a return one minute after settlement.
    world.clock.advanceMs(10_000);
    await drainAll(world);
    const settled = await getPayment(world, payment.id);
    expect(settled.state).toBe("SETTLED");
    const fee = BigInt(settled.fee.minor);
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 80_000n - fee);
    const usageSettled = await usage(world);

    world.clock.advanceMs(2 * 60_000);
    await drainAll(world);
    const returned = await getPayment(world, payment.id);
    expect(returned.state).toBe("RETURNED");
    const reference = returned.executionReference as string;
    // The original journal is retained; the compensation is a second journal linked to it.
    expect(await world.db.simCoreJournal.count({ where: { executionReference: reference } })).toBe(1);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: `${reference}R` } })).toBe(1);
    // The principal came back; the fee was earned and stays charged.
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - fee);
    // A return does not hand the day's limit back.
    expect(await usage(world)).toEqual(usageSettled);
    expect(returned.timeline.map((event) => event.toState)).toEqual(expect.arrayContaining(["SETTLED", "RETURNED"]));
  });

});

describe("a worker that dies between the limit reservation and the posting", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  /** A worker takes the next job of this type and dies: no handler runs, nothing is reported. */
  async function claimAndDie(type: string): Promise<string> {
    const claimed = await claimJobs(world.db, { workerId: "worker-that-dies", limit: 1, leaseMs: 60_000, now: world.clock.now(), types: [type] });
    expect(claimed.map((job) => job.type)).toEqual([type]);
    return (claimed[0] as { id: string }).id;
  }
  /** Time passes and the dead worker's lease runs out (leases are kept on the database clock). */
  const expireLease = (jobId: string) => world.db.job.update({ where: { id: jobId }, data: { lockedUntil: new Date(Date.now() - 1_000) } });
  const attemptsOf = (paymentId: string) => world.db.executionAttempt.findMany({ where: { instruction: { paymentId } } });

  it("keeps the reservation, resumes the same attempt and posts exactly once (I-17)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const usageBefore = await usage(world);
    const payment = await payAndApprove(world, { minor: "300000" });
    // The final approval reserved the limit. Nothing has been sent anywhere yet.
    const reserved = { consumed: usageBefore.consumed, reserved: usageBefore.reserved + 300_000n };
    expect(await usage(world)).toEqual(reserved);

    // Crash 1 — a worker takes the release job and dies before doing anything.
    const releaseJob = await claimAndDie(JOB_PAYMENT_RELEASE);
    await drainAll(world);
    // While that lease lasts nobody else may run the job; the reservation is not given back.
    expect(await attemptsOf(payment.id)).toHaveLength(0);
    expect(await usage(world)).toEqual(reserved);
    await expireLease(releaseJob);
    await drainJobs(world.deps, { types: [JOB_PAYMENT_RELEASE], workerId: "worker-2" });
    const [attempt, ...extra] = await attemptsOf(payment.id);
    expect(extra).toHaveLength(0);
    if (!attempt) throw new Error("the release job did not create the execution attempt");
    expect(attempt.state).toBe("INTENT");
    expect(await usage(world)).toEqual(reserved);

    // Crash 2 — a worker takes the execution job and dies before calling the core.
    const advanceJob = await claimAndDie(JOB_ATTEMPT_ADVANCE);
    await drainAll(world);
    expect((await attemptsOf(payment.id)).map((entry) => entry.state)).toEqual(["INTENT"]);
    expect(await coreHolds(world, OPERATING.ref)).toBe(0n);
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);
    expect(await usage(world)).toEqual(reserved);

    // Crash 3 — the core placed the hold, and the worker died before it could record that.
    const instruction = await world.db.businessInstruction.findUniqueOrThrow({ where: { id: attempt.instructionId } });
    const held = await world.deps.core.reserveDebit(
      { bankCode: BANKS.A.code, ownerRef: CORPORATES.A.coreCustomerRef, correlationId: instruction.correlationId },
      { reference: attempt.holdReference, accountRef: OPERATING.ref, amountMinor: 300_500n, currency: "LYD" },
    );
    expect(held.kind).toBe("reserved");
    expect(await coreHolds(world, OPERATING.ref)).toBe(300_500n);
    expect((await attemptsOf(payment.id)).map((entry) => entry.state)).toEqual(["INTENT"]);

    // The lease runs out; another worker resumes the SAME attempt with the SAME references.
    await expireLease(advanceJob);
    await drainAll(world);

    const settled = await getPayment(world, payment.id);
    expect(settled.state).toBe("SETTLED");
    expect(settled.executionReference).toBe(attempt.executionReference);
    const after = await attemptsOf(payment.id);
    expect(after.map((entry) => [entry.id, entry.holdReference, entry.executionReference])).toEqual([[attempt.id, attempt.holdReference, attempt.executionReference]]);
    // One hold (replayed, not doubled), captured by one journal: exactly one debit of 300.500.
    expect(await world.db.simCoreHold.count({ where: { accountRef: OPERATING.ref, amountMinor: 300_500n } })).toBe(1);
    expect(await coreHolds(world, OPERATING.ref)).toBe(0n);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: attempt.executionReference } })).toBe(1);
    expect(await coreBalance(world, OPERATING.ref)).toBe(before - 300_500n);
    // The limit moved from reserved to consumed once, in every bucket the payment counts toward.
    expect(await usage(world)).toEqual({ consumed: usageBefore.consumed + 300_000n, reserved: usageBefore.reserved });
    // The release replaced the approval-time reservation by one in the current window (LIM-03):
    // the older cycle was given back in the same transaction, the current one was consumed.
    const reservations = await world.db.limitReservation.findMany({ where: { instructionId: attempt.instructionId } });
    const current = reservations.filter((entry) => entry.cycle === instruction.reservationCycle);
    const earlier = reservations.filter((entry) => entry.cycle !== instruction.reservationCycle);
    expect(current).toHaveLength(7);
    expect(new Set(current.map((entry) => entry.counterId)).size).toBe(7);
    expect(new Set(current.map((entry) => `${entry.state}:${entry.amountMinor}`))).toEqual(new Set(["CONSUMED:300000"]));
    expect(earlier).toHaveLength(7);
    expect(new Set(earlier.map((entry) => `${entry.state}:${entry.amountMinor}`))).toEqual(new Set(["RELEASED:300000"]));
    // Both abandoned claims were taken over and finished; neither job was duplicated.
    const jobs = await world.db.job.findMany({ where: { id: { in: [releaseJob, advanceJob] } }, select: { id: true, state: true, attempts: true } });
    expect(jobs.find((job) => job.id === releaseJob)).toMatchObject({ state: "SUCCEEDED", attempts: 2 });
    expect(jobs.find((job) => job.id === advanceJob)?.state).toBe("SUCCEEDED");
    expect(await world.db.job.count({ where: { type: { in: [JOB_PAYMENT_RELEASE, JOB_ATTEMPT_ADVANCE] }, state: { in: ["PENDING", "RUNNING"] } } })).toBe(0);
  });
});

describe("transfers and window boundaries", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
    await world.activateAgreement("B");
  });
  afterAll(async () => world.close());

  it("moves an own-account transfer atomically and refuses a destination outside the corporate (I-23)", async () => {
    const operating = await coreBalance(world, OPERATING.ref);
    const savings = await coreBalance(world, SAVINGS.ref);
    const transfer = await payAndApprove(world, { transactionType: "OWN_ACCOUNT_TRANSFER", destination: "A_SAVINGS", minor: "250000" }, "aTreasurer", "aChecker1");
    await drainAll(world);
    const done = await getPayment(world, transfer.id, "aTreasurer");
    expect(done.state).toBe("SETTLED");
    const fee = BigInt(done.fee.minor);
    expect(operating - (await coreBalance(world, OPERATING.ref))).toBe(250_000n + fee);
    expect((await coreBalance(world, SAVINGS.ref)) - savings).toBe(250_000n);

    const treasurer = await world.as("aTreasurer");
    const count = await world.db.payment.count();
    // Another corporate's account, the source itself and an unknown account are not destinations.
    for (const destinationAccountId of [ACCOUNTS.B_OPERATING.id, OPERATING.id, crypto.randomUUID()]) {
      const refused = await treasurer.post("/payments", { ...paymentBody({ transactionType: "OWN_ACCOUNT_TRANSFER", minor: "1000" }), destinationAccountId });
      expect([400, 404, 422], destinationAccountId).toContain(refused.status);
    }
    expect(await world.db.payment.count()).toBe(count);
    expect((await coreBalance(world, SAVINGS.ref)) - savings).toBe(250_000n);
  });

  it("checks a payment scheduled into next month against next month's window, not this one (I-24)", async () => {
    // Fixture clock: late November. Schedule for 2 December, inside the 30-day horizon.
    const executeAt = "2026-12-02T08:30:00.000Z";
    const monthBefore = await world.db.usageCounter.findMany({ where: { corporateId: CORPORATES.A.id, scopeKey: "CORPORATE", period: "MONTH" } });
    const novemberBefore = monthBefore.reduce((sum, counter) => sum + counter.consumedMinor + counter.reservedMinor, 0n);
    const scheduled = await payAndApprove(world, { minor: "120000", executeAt });
    expect(scheduled.state).toBe("SCHEDULED");
    // Nothing is reserved in the current windows for a future-dated payment.
    const monthAfterApproval = await world.db.usageCounter.findMany({ where: { corporateId: CORPORATES.A.id, scopeKey: "CORPORATE", period: "MONTH" } });
    expect(monthAfterApproval.reduce((sum, counter) => sum + counter.consumedMinor + counter.reservedMinor, 0n)).toBe(novemberBefore);
    // Not early.
    world.clock.set(new Date("2026-12-02T08:00:00.000Z"));
    await drainAll(world);
    expect((await getPayment(world, scheduled.id)).state).toBe("SCHEDULED");
    world.clock.set(new Date("2026-12-02T08:31:00.000Z"));
    await drainAll(world);
    expect((await getPayment(world, scheduled.id)).state).toBe("SETTLED");
    const december = await world.db.usageCounter.findFirstOrThrow({ where: { corporateId: CORPORATES.A.id, scopeKey: "CORPORATE", period: "MONTH", windowStart: new Date("2026-12-01T00:00:00.000Z") } });
    expect(december.consumedMinor).toBe(120_000n);
    const november = await world.db.usageCounter.findFirstOrThrow({ where: { corporateId: CORPORATES.A.id, scopeKey: "CORPORATE", period: "MONTH", windowStart: new Date("2026-11-01T00:00:00.000Z") } });
    expect(november.consumedMinor + november.reservedMinor).toBe(novemberBefore);
  });
});

describe("authority, audit and sign-in", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  it("ignores forged tenant, role and actor claims; real session authority prevails (I-02, I-03, I-07)", async () => {
    const maker = await world.as("aMaker");
    const forgedHeaders = { "x-corporate-id": CORPORATES.B.id, "x-tenant-id": CORPORATES.B.id, "x-role": "CHECKER,CORPORATE_ADMIN,BANK_ADMIN_CHECKER", "x-person-id": crypto.randomUUID(), "x-forwarded-user": "bank.checker@demo.alqarib.test" };
    // Body fields that would name another actor, tenant or state are rejected outright.
    for (const extra of [{ makerPersonId: crypto.randomUUID() }, { corporateId: CORPORATES.B.id }, { state: "APPROVED" }, { feeMinor: "0" }, { requiredApprovals: 0 }]) {
      expect((await maker.post("/payments", { ...paymentBody({ minor: "1000" }), ...extra }, { headers: forgedHeaders })).status).toBe(400);
    }
    // With forged headers the maker still only sees their own corporate and still cannot approve.
    const accounts = await maker.get<Array<{ id: string }>>("/accounts", { headers: forgedHeaders });
    expect(accounts.data.map((account) => account.id).sort()).toEqual([ACCOUNTS.A_OPERATING.id, ACCOUNTS.A_PAYROLL.id, ACCOUNTS.A_SAVINGS.id].sort());
    const payment = await submitPayment(world, { minor: "10000" });
    const approval = await maker.get<{ version: number; targetRevision: number; payloadHash: string }>(`/approvals/${pendingApproval(payment)}`);
    const own = await maker.post(`/approvals/${pendingApproval(payment)}/approve`, { proposalVersion: approval.data.targetRevision, proposalHash: approval.data.payloadHash }, { ifMatch: approval.data.version, headers: forgedHeaders });
    expect(own.status).toBe(403);
    expect(await world.db.approvalVote.count({ where: { approvalRequestId: pendingApproval(payment) } })).toBe(0);
    expect((await maker.get("/bank/corporates", { headers: forgedHeaders })).status).toBe(404);

    // A bank administrator of another bank cannot read or change this bank's corporate.
    const otherBank = await world.as("bankBAdmin");
    expect((await otherBank.get(`/bank/corporates/${CORPORATES.A.id}/agreement`)).status).toBe(404);
    const crossBank = await otherBank.post(`/bank/corporates/${CORPORATES.A.id}/agreement-proposals`, demoAgreementProposal(world.deps, "A"));
    expect([403, 404]).toContain(crossBank.status);
    // A module that is not part of this release cannot be switched on by a crafted proposal.
    const crafted = demoAgreementProposal(world.deps, "A");
    crafted.terms.moduleTerms.push({ moduleId: "4.1", transactionTypes: [], currency: "LYD", debitAccountIds: [], creditAccountIds: [], limits: [], feeRules: [], approvalBands: [] } as never);
    const deferred = await (await world.as("bankMaker")).post(`/bank/corporates/${CORPORATES.A.id}/agreement-proposals`, crafted);
    expect([400, 422]).toContain(deferred.status);
    expect(await world.db.agreementVersion.count({ where: { corporateId: CORPORATES.A.id } })).toBe(1);
  });

  it("writes an audit event with every business change and lets nobody rewrite it (I-44)", async () => {
    const before = await world.db.auditEvent.count();
    const payment = await payAndApprove(world, { minor: "20000" });
    await drainAll(world);
    const events = await world.db.auditEvent.findMany({ where: { OR: [{ targetId: payment.id }, { targetId: pendingApproval(payment) }] }, orderBy: { id: "asc" } });
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(["payment.created", "payment.submitted", "approval.approved", "payment.execution.settled"]));
    expect(await world.db.auditEvent.count()).toBeGreaterThan(before);
    // The application's own database role can neither change nor remove audit rows.
    const target = events[0] as { id: string };
    await expect(world.db.auditEvent.update({ where: { id: target.id }, data: { action: "payment.rewritten" } })).rejects.toThrow();
    await expect(world.db.auditEvent.updateMany({ data: { result: "DENIED" } })).rejects.toThrow();
    await expect(world.db.auditEvent.delete({ where: { id: target.id } })).rejects.toThrow();
    await expect(world.db.auditEvent.deleteMany({})).rejects.toThrow();
    await expect(world.db.$executeRawUnsafe('TRUNCATE "AuditEvent"')).rejects.toThrow();
    expect((await world.db.auditEvent.findUniqueOrThrow({ where: { id: target.id } })).action).toBe(events[0]?.action);
    // A refused action is recorded as denied; it does not vanish.
    const refused = await approve(world, pendingApproval(await submitPayment(world, { minor: "1000" })), "aMaker");
    expect(refused.status).toBe(403);
    expect(await world.db.auditEvent.count({ where: { result: "DENIED", action: "approval.vote" } })).toBeGreaterThan(0);
  });

  it("refuses a cross-site write and throttles sign-in without revealing which addresses exist (I-52)", async () => {
    const maker = await world.as("aMaker");
    const count = await world.db.payment.count();
    const forged = await maker.post("/payments", paymentBody({ minor: "5000" }), { forged: true });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe("CSRF_REJECTED");
    // The marker header alone is not enough when the request comes from another origin.
    const wrongOrigin = await maker.post("/payments", paymentBody({ minor: "5000" }), { forged: true, headers: { origin: "https://evil.example.test", "x-alqarib-request": "1" } });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.body.code).toBe("CSRF_REJECTED");
    expect(await world.db.payment.count()).toBe(count);

    const attempt = (email: string, password: string) => world.anonymous().post("/session/login", { email, password }, { idempotencyKey: null });
    const known = "a.viewer@demo.alqarib.test";
    const unknown = "nobody.here@demo.alqarib.test";
    const first = [await attempt(known, "wrong-password-0001"), await attempt(unknown, "wrong-password-0001")];
    // Same status and same message for a real and an unknown address.
    expect(first.map((response) => response.status)).toEqual([401, 401]);
    expect(first[0]?.body["detail"]).toBe(first[1]?.body["detail"]);
    let knownStatus = 401;
    let unknownStatus = 401;
    for (let tries = 0; tries < 12 && (knownStatus !== 429 || unknownStatus !== 429); tries += 1) {
      knownStatus = (await attempt(known, `wrong-password-${tries}`)).status;
      unknownStatus = (await attempt(unknown, `wrong-password-${tries}`)).status;
    }
    expect([knownStatus, unknownStatus]).toEqual([429, 429]);
    // While locked, even the right password is not accepted — and the response does not say why.
    const locked = await attempt(known, TEST_PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another person is unaffected.
    expect((await attempt("a.finance@demo.alqarib.test", TEST_PASSWORD)).status).toBe(200);
  });
});
