/**
 * S8 reconciliation and simulator controls (OPS-01, I-43): break detection by stable
 * reference, append-only dispositions, no ledger edits, visible failure when the core does not
 * answer, and audited sandbox switches.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateOf } from "@/lib/calendar";
import { ACCOUNTS } from "@/server/seed/fixtures";
import { coreBalance, getPayment, payAndApprove } from "./support/payments";
import { createWorld, type World } from "./support/world";

type Run = { id: string; state: string; expectedCount: number; coreCount: number; matchedCount: number; breakCount: number; openBreaks: number; failureCode: string | null };
type Break = {
  id: string;
  kind: string;
  executionReference: string;
  state: string;
  expected: { principalMinor?: string; platformState?: string } | null;
  actual: { principalMinor?: string; count?: number } | null;
  resolutions: Array<{ id: string; disposition: string; reason: string; actor: string }>;
};
type RunDetail = { run: Run; breaks: Break[] };
type SimState = { clock: { offsetMinutes: number }; availability: Array<{ target: string; offline: boolean }>; overlays: Array<{ id: string }>; faults: unknown[] };

const OPERATING = ACCOUNTS.A_OPERATING.ref;

describe("S8 reconciliation and simulator", () => {
  let world: World;
  let today: string;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
    today = businessDateOf(world.clock.now(), "Africa/Tripoli");
  });
  afterAll(async () => world.close());

  it("detects missing, duplicate, amount, status and unexpected breaks without touching the ledger (I-43)", async () => {
    const settled = [] as string[];
    for (const minor of ["100000", "110000", "120000", "130000"]) {
      const payment = await payAndApprove(world, { minor });
      await world.drain();
      const done = await getPayment(world, payment.id);
      expect(done.state).toBe("SETTLED");
      settled.push(done.executionReference as string);
    }
    const [hidden, duplicated, altered, clean] = settled as [string, string, string, string];
    // Booked by the core while the platform still shows "result being checked".
    const lost = await payAndApprove(world, { beneficiary: "TIMEOUT_AFTER", minor: "140000" });
    await world.drain();
    const unknownRef = (await getPayment(world, lost.id)).executionReference as string;
    expect((await getPayment(world, lost.id)).state).toBe("STATUS_UNKNOWN");
    // A posting the platform never originated.
    const stray = `AQ${"F".repeat(32)}A1`;
    await world.deps.core.execute(
      { bankCode: "ALQARIB-SBX" },
      { type: "EXTERNAL_TRANSFER", rail: "LYPAY", executionReference: stray, currency: "LYD", narrative: "Synthetic stray posting", debitAccountRef: OPERATING, principalMinor: 1_000n, feeMinor: 0n },
    );

    const ops = await world.as("ops");
    for (const overlay of [
      { executionReference: hidden, kind: "HIDE" },
      { executionReference: duplicated, kind: "DUPLICATE" },
      { executionReference: altered, kind: "AMOUNT_OVERRIDE", amountMinor: "999000" },
    ]) {
      const added = await ops.post("/bank/simulator/recon-overlays", { businessDate: today, reason: "break detection fixture", ...overlay });
      expect(added.status).toBe(201);
    }

    const balanceBefore = await coreBalance(world, OPERATING);
    const journalsBefore = await world.db.simCoreJournal.count();
    const entriesBefore = await world.db.simCoreEntry.count();

    const started = await ops.post<RunDetail>("/bank/reconciliation-runs", { businessDate: today });
    expect(started.status).toBe(202);
    expect(started.data.run.state).toBe("RUNNING");
    const runId = started.data.run.id;
    await world.drain();
    // A second worker pass on the same run records nothing more.
    await world.drain();

    const detail = await ops.get<RunDetail>(`/bank/reconciliation-runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.run).toMatchObject({ state: "COMPLETED", expectedCount: 4, coreCount: 6, matchedCount: 1, breakCount: 5, openBreaks: 5, failureCode: null });
    const byRef = new Map(detail.data.breaks.map((entry) => [entry.executionReference, entry]));
    expect(byRef.get(hidden)?.kind).toBe("MISSING_IN_CORE");
    expect(byRef.get(duplicated)).toMatchObject({ kind: "DUPLICATE_IN_CORE", actual: { count: 2 } });
    expect(byRef.get(altered)).toMatchObject({ kind: "AMOUNT_MISMATCH", expected: { principalMinor: "120000" }, actual: { principalMinor: "999000" } });
    expect(byRef.get(unknownRef)).toMatchObject({ kind: "STATUS_MISMATCH", expected: { platformState: "UNKNOWN" }, actual: { principalMinor: "140000" } });
    expect(byRef.get(stray)).toMatchObject({ kind: "UNEXPECTED_IN_CORE", actual: { principalMinor: "1000" } });
    expect(byRef.has(clean)).toBe(false);

    // The run compared; it changed no ledger, balance or instruction.
    expect(await coreBalance(world, OPERATING)).toBe(balanceBefore);
    expect(await world.db.simCoreJournal.count()).toBe(journalsBefore);
    expect(await world.db.simCoreEntry.count()).toBe(entriesBefore);
    expect((await getPayment(world, lost.id)).state).toBe("STATUS_UNKNOWN");

    // Dispositions are appended; earlier ones stay exactly as written.
    const target = byRef.get(altered) as Break;
    const first = await ops.post<RunDetail>(`/bank/reconciliation-breaks/${target.id}/resolution`, { disposition: "INVESTIGATING", reason: "Asked core team for the journal" });
    expect(first.status).toBe(201);
    const second = await ops.post<RunDetail>(`/bank/reconciliation-breaks/${target.id}/resolution`, { disposition: "EXPLAINED", reason: "Extract fixture confirmed; ledger amount is correct", evidenceReference: "RECON-0001" });
    const after = second.data.breaks.find((entry) => entry.id === target.id) as Break;
    expect(after.state).toBe("RESOLVED");
    expect(after.resolutions.map((entry) => entry.disposition)).toEqual(["INVESTIGATING", "EXPLAINED"]);
    expect(after.resolutions[0]?.reason).toBe("Asked core team for the journal");
    expect(second.data.run.openBreaks).toBe(4);
    // The break itself was not deleted and the other four are still open.
    expect(await world.db.reconciliationBreak.count({ where: { runId } })).toBe(5);

    // The history cannot be rewritten or removed, even by the application's own database role.
    await expect(world.db.reconciliationResolution.updateMany({ where: { breakId: target.id }, data: { reason: "rewritten" } })).rejects.toThrow();
    await expect(world.db.reconciliationResolution.deleteMany({ where: { breakId: target.id } })).rejects.toThrow();
    expect(await world.db.reconciliationResolution.count({ where: { breakId: target.id } })).toBe(2);

    // There is no bulk "resolve all" operation.
    expect([404, 405]).toContain((await ops.post("/bank/reconciliation-breaks/resolution", { disposition: "EXPLAINED", reason: "all of them" })).status);
    expect([404, 405]).toContain((await ops.post(`/bank/reconciliation-runs/${runId}/resolve-all`, {})).status);
  });

  it("is limited to authorized staff of the same bank", async () => {
    const ops = await world.as("ops");
    const runs = await ops.get<Run[]>("/bank/reconciliation-runs");
    const runId = runs.data[0]?.id as string;
    expect(runId).toBeTruthy();
    // Another bank's administrator has no reconciliation permission and sees no run.
    const otherBank = await world.as("bankBAdmin");
    expect((await otherBank.get("/bank/reconciliation-runs")).status).toBe(403);
    expect((await otherBank.get(`/bank/reconciliation-runs/${runId}`)).status).toBe(403);
    expect((await otherBank.post("/bank/reconciliation-runs", { businessDate: today })).status).toBe(403);
    // A corporate session has no bank operations at all.
    const maker = await world.as("aMaker");
    expect((await maker.get(`/bank/reconciliation-runs/${runId}`)).status).toBe(404);
    expect((await maker.post("/bank/simulator/recon-overlays", { businessDate: today, executionReference: "AQTEST", kind: "HIDE", reason: "not allowed" })).status).toBe(404);
  });

  it("rejects a future date and fails visibly — with no invented breaks — when the core does not answer", async () => {
    const ops = await world.as("ops");
    const future = await ops.post("/bank/reconciliation-runs", { businessDate: "2031-01-01" });
    expect(future.status).toBe(400);
    expect(future.body.code).toBe("VALIDATION_FAILED");

    const offline = await ops.post<SimState>("/bank/simulator/availability", { target: "CORE", offline: true, reason: "outage demonstration" });
    expect(offline.data.availability.find((entry) => entry.target === "CORE")?.offline).toBe(true);
    const started = await ops.post<RunDetail>("/bank/reconciliation-runs", { businessDate: today });
    await world.drain();
    const failed = await ops.get<RunDetail>(`/bank/reconciliation-runs/${started.data.run.id}`);
    expect(failed.data.run).toMatchObject({ state: "FAILED", failureCode: "CORE_UNAVAILABLE", breakCount: 0 });
    expect(failed.data.breaks).toEqual([]);
    const online = await ops.post<SimState>("/bank/simulator/availability", { target: "CORE", offline: false, reason: "end of outage demonstration" });
    expect(online.data.availability.every((entry) => !entry.offline)).toBe(true);
  });

  it("moves the sandbox clock forward only and audits every simulator change", async () => {
    const ops = await world.as("ops");
    const before = (await ops.get<SimState>("/bank/simulator")).data.clock.offsetMinutes;
    const advanced = await ops.post<SimState>("/bank/simulator/clock", { advanceMinutes: 90, reason: "cut-off demonstration" });
    expect(advanced.status).toBe(200);
    expect(advanced.data.clock.offsetMinutes).toBe(before + 90);
    for (const advanceMinutes of [0, -30, 1.5]) {
      const refused = await ops.post("/bank/simulator/clock", { advanceMinutes, reason: "not allowed" });
      expect(refused.status).toBe(400);
    }
    expect((await ops.get<SimState>("/bank/simulator")).data.clock.offsetMinutes).toBe(before + 90);
    // A fault can only be armed for an execution of the caller's own bank.
    expect((await ops.post("/bank/simulator/faults", { executionReference: `AQ${"0".repeat(32)}A1`, fault: "REJECT", uses: 1, reason: "unknown reference" })).status).toBe(404);

    const actions = (await world.db.auditEvent.findMany({ where: { action: { startsWith: "simulator." } }, orderBy: [{ at: "asc" }, { id: "asc" }] })).map((event) => event.action);
    expect(actions.filter((action) => action === "simulator.clock.advanced")).toHaveLength(1);
    expect(actions.filter((action) => action === "simulator.availability.changed")).toHaveLength(2);
    expect(actions.filter((action) => action === "simulator.recon.overlay.added")).toHaveLength(3);
  });
});
