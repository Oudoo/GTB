/**
 * S8 bank operations (OPS-01, DEC-012): unknown outcomes are resolved by inquiry on the
 * ORIGINAL reference; a repair needs an inquiry first and an independent approver; nothing
 * edits a ledger. Covers I-18 and I-19 from the operations side, I-43 and bank isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainJobs } from "@/server/jobs/runner";
import { ACCOUNTS } from "@/server/seed/fixtures";
import { approve, coreBalance, coreHolds, getPayment, payAndApprove, usage } from "./support/payments";
import { createWorld, type World } from "./support/world";

type Execution = {
  id: string;
  executionReference: string;
  state: string;
  category: string;
  lastInquiryResult: string | null;
  inquiryCount: number;
  instruction: { amount: { minor: string } | null; reference: string | null };
  actions: { inquire: boolean; proposeRepair: boolean };
  repairBlockedBy: string | null;
  openProposal: { id: string; approvalRequestId: string | null } | null;
  proposals: Array<{ id: string; status: string; action: string; approvalRequestId: string | null; outcome: { result?: string; attemptState?: string } | null }>;
  history: Array<{ code: string; actor: string | null }>;
};
type Queue = { items: Execution[]; counts: { unknown: number; failed: number; overdue: number } };

const OPERATING = ACCOUNTS.A_OPERATING.ref;

describe("S8 operations — inquiry, repair proposals and isolation", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  /** Run the release job only: the attempt (and its reference) exists, nothing was sent yet. */
  const releaseOnly = () => drainJobs(world.deps, { types: ["payment.release"], workerId: "test-release" });

  async function executionOf(paymentId: string): Promise<Execution> {
    const ops = await world.as("ops");
    const payment = await getPayment(world, paymentId);
    const queue = await ops.get<Queue>(`/bank/operations/executions?category=ALL&reference=${payment.executionReference}`);
    expect(queue.status).toBe(200);
    const item = queue.data.items.find((entry) => entry.executionReference === payment.executionReference);
    if (!item) throw new Error("execution not in queue");
    const detail = await ops.get<Execution>(`/bank/operations/executions/${item.id}`);
    expect(detail.status).toBe(200);
    return detail.data;
  }

  it("an unknown outcome the core HAS booked is acknowledged by inquiry — one debit (I-18)", async () => {
    const before = await coreBalance(world, OPERATING);
    const payment = await payAndApprove(world, { beneficiary: "TIMEOUT_AFTER", minor: "200000" });
    await world.drain();
    expect((await getPayment(world, payment.id)).state).toBe("STATUS_UNKNOWN");

    const ops = await world.as("ops");
    const queue = await ops.get<Queue>("/bank/operations/executions");
    expect(queue.data.counts.unknown).toBe(1);
    const execution = await executionOf(payment.id);
    expect(execution).toMatchObject({ state: "UNKNOWN", category: "UNKNOWN", inquiryCount: 0, repairBlockedBy: "INQUIRE_FIRST", actions: { inquire: true, proposeRepair: false } });
    expect(execution.instruction.amount?.minor).toBe("200000");

    // A repair cannot be proposed before the core was asked.
    const early = await ops.post(`/bank/operations/executions/${execution.id}/repair-proposals`, { action: "MARK_FAILED_UNPOSTED", reason: "no inquiry yet" });
    expect(early.body.code).toBe("STATUS_UNRESOLVED");
    expect(await world.db.repairProposal.count()).toBe(0);

    const inquired = await ops.post<Execution>(`/bank/operations/executions/${execution.id}/inquire`, {});
    expect(inquired.status).toBe(200);
    expect(inquired.data).toMatchObject({ state: "BOOKED", lastInquiryResult: "BOOKED", inquiryCount: 1, repairBlockedBy: "NOT_UNKNOWN" });
    expect(inquired.data.history.map((entry) => entry.code)).toContain("INQUIRY_BOOKED");

    const settled = await getPayment(world, payment.id);
    expect(settled.state).toBe("SETTLED");
    expect(settled.executionReference).toBe(execution.executionReference);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: execution.executionReference } })).toBe(1);
    expect(await coreBalance(world, OPERATING)).toBe(before - 200_500n);
    expect(await coreHolds(world, OPERATING)).toBe(0n);

    // Asking again is refused: the outcome is known. The worker changes nothing either.
    const again = await ops.post(`/bank/operations/executions/${execution.id}/inquire`, {});
    expect(again.status).toBe(409);
    world.clock.advanceMinutes(90);
    await world.drain();
    expect(await coreBalance(world, OPERATING)).toBe(before - 200_500n);

    const audit = await world.db.auditEvent.findMany({ where: { action: "operations.inquiry", targetId: execution.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorPersonId).not.toBeNull();
    expect((audit[0]?.changes as { outcome?: string }).outcome).toBe("BOOKED");
  });

  it("an unknown outcome the core does NOT have stays unknown until an independent approval (I-19)", async () => {
    const before = await coreBalance(world, OPERATING);
    const usageBefore = await usage(world);
    const payment = await payAndApprove(world, { beneficiary: "TIMEOUT_BEFORE", minor: "150000" });
    await world.drain();
    expect((await getPayment(world, payment.id)).state).toBe("STATUS_UNKNOWN");
    // Funds and limit stay reserved while the outcome is unknown; nothing is booked.
    expect(await coreBalance(world, OPERATING)).toBe(before);
    expect(await coreHolds(world, OPERATING)).toBe(150_500n);
    expect((await usage(world)).reserved).toBe(usageBefore.reserved + 150_000n);

    const ops = await world.as("ops");
    const execution = await executionOf(payment.id);
    const inquired = await ops.post<Execution>(`/bank/operations/executions/${execution.id}/inquire`, {});
    expect(inquired.data).toMatchObject({ state: "UNKNOWN", lastInquiryResult: "NOT_FOUND", repairBlockedBy: null, actions: { proposeRepair: true } });
    // "Not found" is not a failure: the payment is still unknown and cannot be retried blindly.
    expect((await getPayment(world, payment.id)).state).toBe("STATUS_UNKNOWN");
    expect(await world.db.executionAttempt.count({ where: { instruction: { paymentId: payment.id } } })).toBe(1);

    const proposed = await ops.post<Execution>(`/bank/operations/executions/${execution.id}/repair-proposals`, {
      action: "MARK_FAILED_UNPOSTED",
      reason: "Core confirmed no posting under the original reference",
      evidenceReference: "OPS-CASE-0001",
    });
    expect(proposed.status).toBe(201);
    expect(proposed.data.openProposal).not.toBeNull();
    expect(proposed.data.repairBlockedBy).toBe("OPEN_PROPOSAL");
    const approvalId = proposed.data.openProposal?.approvalRequestId as string;
    // Only one open proposal per execution.
    const second = await ops.post(`/bank/operations/executions/${execution.id}/repair-proposals`, { action: "RESUBMIT_SAME_REFERENCE", reason: "second proposal attempt" });
    expect(second.status).toBe(409);
    expect(await world.db.repairProposal.count({ where: { attemptId: execution.id } })).toBe(1);

    // Proposing changed nothing financial.
    expect((await getPayment(world, payment.id)).state).toBe("STATUS_UNKNOWN");
    expect(await coreHolds(world, OPERATING)).toBe(150_500n);

    // The proposer cannot approve it; neither can someone without the repair permission.
    const own = await approve(world, approvalId, "ops");
    expect(own.status).toBe(403);
    expect(own.body.code).toBe("SELF_APPROVAL_FORBIDDEN");
    // Someone who can read operations but holds no repair-approval permission is refused …
    const noPermission = await approve(world, approvalId, "payrollSupport");
    expect(noPermission.status).toBe(403);
    expect(noPermission.body.code).toBe("PERMISSION_DENIED");
    // … and a bank administrator outside operations cannot even see the proposal.
    const invisible = await approve(world, approvalId, "bankMaker");
    expect(invisible.status).toBe(404);
    const forged = await (await world.as("bankMaker")).post(`/approvals/${approvalId}/approve`, { proposalVersion: 1, proposalHash: "0".repeat(64) }, { ifMatch: 1 });
    expect(forged.status).toBe(404);
    expect(await world.db.repairProposal.count({ where: { status: "PENDING_APPROVAL" } })).toBe(1);

    const approved = await approve(world, approvalId, "bankChecker");
    expect(approved.status).toBe(200);
    // The vote itself calls no adapter: the repair runs as a worker job.
    expect((await getPayment(world, payment.id)).state).toBe("STATUS_UNKNOWN");
    await world.drain();

    const failed = await getPayment(world, payment.id);
    expect(failed.state).toBe("FAILED");
    expect(failed.failureCode).toBe("DECLARED_UNPOSTED");
    expect(await coreBalance(world, OPERATING)).toBe(before);
    expect(await coreHolds(world, OPERATING)).toBe(0n);
    expect(await usage(world)).toEqual(usageBefore);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: { startsWith: execution.executionReference } } })).toBe(0);

    const after = await executionOf(payment.id);
    expect(after.state).toBe("FAILED");
    expect(after.proposals[0]).toMatchObject({ status: "EXECUTED", action: "MARK_FAILED_UNPOSTED", outcome: { result: "FAILED", attemptState: "FAILED" } });
    // The whole intervention is on the audit trail, including the refused self-approval. The
    // vote of someone who could not see the proposal never reached the approval service.
    const proposalId = after.proposals[0]?.id as string;
    const trail = await world.db.auditEvent.findMany({ where: { targetId: { in: [execution.id, proposalId] } }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    expect(trail.map((event) => `${event.action}:${event.result}`)).toEqual([
      "operations.inquiry:SUCCESS",
      "repair.proposed:SUCCESS",
      "approval.vote:DENIED",
      "repair.approved:SUCCESS",
      "approval.approved:SUCCESS",
      "repair.executed:SUCCESS",
    ]);
    const proposer = trail.find((event) => event.action === "repair.proposed")?.actorPersonId;
    const approver = trail.find((event) => event.action === "approval.approved")?.actorPersonId;
    expect(proposer).toBeTruthy();
    expect(approver).toBeTruthy();
    expect(approver).not.toBe(proposer);
  });

  it("an approved resubmission uses the SAME reference and books exactly once", async () => {
    const before = await coreBalance(world, OPERATING);
    const payment = await payAndApprove(world, { minor: "175000" });
    // Run only the release step, then arm a one-off "no answer, nothing posted" fault for the
    // reference the attempt was given.
    await releaseOnly();
    const reference = (await getPayment(world, payment.id)).executionReference as string;
    expect(reference).toMatch(/^AQ[0-9A-F]{32}A1$/);
    const ops = await world.as("ops");
    const armed = await ops.post("/bank/simulator/faults", { executionReference: reference, fault: "TIMEOUT_BEFORE_PROCESSING", uses: 1, reason: "repair demonstration" });
    expect(armed.status).toBe(201);
    await world.drain();
    expect((await getPayment(world, payment.id)).state).toBe("STATUS_UNKNOWN");
    expect(await world.db.simCoreJournal.count({ where: { executionReference: reference } })).toBe(0);

    const execution = await executionOf(payment.id);
    await ops.post(`/bank/operations/executions/${execution.id}/inquire`, {});
    const proposed = await ops.post<Execution>(`/bank/operations/executions/${execution.id}/repair-proposals`, { action: "RESUBMIT_SAME_REFERENCE", reason: "Core has no posting; send the original instruction again" });
    expect(proposed.status).toBe(201);
    expect((await approve(world, proposed.data.openProposal?.approvalRequestId as string, "bankChecker")).status).toBe(200);
    await world.drain();

    const settled = await getPayment(world, payment.id);
    expect(settled.state).toBe("SETTLED");
    // Same attempt, same reference: no second attempt and exactly one journal.
    expect(settled.executionReference).toBe(reference);
    expect(await world.db.executionAttempt.count({ where: { instruction: { paymentId: payment.id } } })).toBe(1);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: reference } })).toBe(1);
    expect(await coreBalance(world, OPERATING)).toBe(before - 175_500n);
    expect(await coreHolds(world, OPERATING)).toBe(0n);
    expect((await executionOf(payment.id)).proposals[0]).toMatchObject({ status: "EXECUTED", outcome: { result: "RESUBMITTED", attemptState: "BOOKED" } });
  });

  it("a repair whose execution resolved in the meantime cannot be approved", async () => {
    const payment = await payAndApprove(world, { minor: "110000" });
    await releaseOnly();
    const reference = (await getPayment(world, payment.id)).executionReference as string;
    const ops = await world.as("ops");
    // The core WILL book it but the answer is lost; a first inquiry is made while the core is offline.
    await ops.post("/bank/simulator/faults", { executionReference: reference, fault: "TIMEOUT_BEFORE_PROCESSING", uses: 1, reason: "late posting demonstration" });
    await world.drain();
    const execution = await executionOf(payment.id);
    const first = await ops.post<Execution>(`/bank/operations/executions/${execution.id}/inquire`, {});
    expect(first.data.lastInquiryResult).toBe("NOT_FOUND");
    const proposed = await ops.post<Execution>(`/bank/operations/executions/${execution.id}/repair-proposals`, { action: "MARK_FAILED_UNPOSTED", reason: "Declare failed after not-found" });
    const approvalId = proposed.data.openProposal?.approvalRequestId as string;

    // The original instruction now arrives late at the core under its original reference.
    const attempt = await world.db.executionAttempt.findUniqueOrThrow({ where: { id: execution.id }, include: { instruction: true } });
    await world.deps.core.execute(
      { bankCode: "ALQARIB-SBX" },
      {
        type: "EXTERNAL_TRANSFER",
        rail: "LYPAY",
        executionReference: reference,
        currency: "LYD",
        narrative: attempt.instruction.narrative,
        debitAccountRef: attempt.instruction.sourceCoreRef,
        principalMinor: attempt.instruction.amountMinor,
        feeMinor: attempt.instruction.feeMinor,
        holdReference: attempt.holdReference,
      },
    );
    const second = await ops.post<Execution>(`/bank/operations/executions/${execution.id}/inquire`, {});
    expect(second.data.state).toBe("BOOKED");

    // "Declare failed" can no longer be approved: the posting exists.
    const approval = await approve(world, approvalId, "bankChecker");
    expect(approval.status).toBe(409);
    await world.drain();
    expect((await getPayment(world, payment.id)).state).toBe("SETTLED");
    expect(await world.db.simCoreJournal.count({ where: { executionReference: reference } })).toBe(1);
  });

  it("is limited to the caller's own bank, read-only without the act permission, and absent for corporates", async () => {
    const payment = await payAndApprove(world, { beneficiary: "TIMEOUT_AFTER", minor: "120000" });
    await world.drain();
    const execution = await executionOf(payment.id);

    // Another bank's administrator (who may read executions of their own bank) sees nothing.
    const otherBank = await world.as("bankBAdmin");
    const foreignList = await otherBank.get<Queue>("/bank/operations/executions?category=ALL");
    expect(foreignList.status).toBe(200);
    expect(foreignList.data.items).toEqual([]);
    expect(foreignList.data.counts).toEqual({ unknown: 0, failed: 0, overdue: 0 });
    expect((await otherBank.get(`/bank/operations/executions/${execution.id}`)).status).toBe(404);
    // A forged corporate filter cannot widen the bank boundary.
    expect((await otherBank.get<Queue>(`/bank/operations/executions?category=ALL&corporateId=${payment.id}`)).data.items).toEqual([]);

    // Read without act: can look, cannot inquire or propose.
    const support = await world.as("payrollSupport");
    expect((await support.get(`/bank/operations/executions/${execution.id}`)).status).toBe(200);
    expect((await support.post(`/bank/operations/executions/${execution.id}/inquire`, {})).status).toBe(403);
    expect((await support.post(`/bank/operations/executions/${execution.id}/repair-proposals`, { action: "MARK_FAILED_UNPOSTED", reason: "not allowed" })).status).toBe(403);
    expect((await support.get("/bank/simulator")).status).toBe(403);

    // Bank operations do not exist for a corporate session.
    const maker = await world.as("aMaker");
    expect((await maker.get("/bank/operations/executions")).status).toBe(404);
    expect((await maker.post(`/bank/operations/executions/${execution.id}/inquire`, {})).status).toBe(404);
    expect((await maker.post("/bank/simulator/clock", { advanceMinutes: 5, reason: "not allowed" })).status).toBe(404);

    // Still unknown and untouched by all of the refused calls.
    expect((await executionOf(payment.id)).inquiryCount).toBe(0);
  });
});
