/**
 * S7 collections and branch deposits (COL-01..03; I-33..I-39): explicit corporate + customer
 * matching, manager approval strictly above the threshold by a different person of the same
 * branch, exactly one credit per deposit, cheques credited only after clearing, and
 * allocations that can never overpay.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateOf } from "@/lib/calendar";
import { ACCOUNTS, BRANCHES, CORPORATES, customerId } from "@/server/seed/fixtures";
import { approve, coreBalance } from "./support/payments";
import { createWorld, race, type ApiResult, type World } from "./support/world";

type Deposit = {
  id: string;
  intakeReference: string;
  state: string;
  method: string;
  amount: { minor: string };
  remaining: { minor: string };
  requiresManager: boolean;
  cashReviewFlag: boolean;
  executionReference: string | null;
  receipt: { kind: string; reference: string } | null;
  approval: { id: string; state: string; canAct: boolean } | null;
  timeline: Array<{ code: string; actor: string | null }>;
  version: number;
};
type Invoice = { id: string; reference: string; status: string; due: { minor: string }; allocated: { minor: string } };
type Customer = { id: string; code: string; archived: boolean; referenced: boolean; version: number; totals: { deposits: number; due: { minor: string }; openInvoices: number } };

const OPERATING = ACCOUNTS.A_OPERATING;
const A = CORPORATES.A.id;
let slip = 0;

function intake(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  slip += 1;
  return {
    corporateId: A,
    customerCode: "CUST-001",
    creditAccountId: OPERATING.id,
    branchId: BRANCHES.BR1.id,
    method: "CASH",
    amount: { currency: "LYD", minor: "500000" },
    depositorReference: `SLIP-${String(slip).padStart(4, "0")}`,
    ...overrides,
  };
}

async function capture(world: World, actorKey: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<ApiResult<Deposit>> {
  return (await world.as(actorKey)).post<Deposit>("/bank/deposits", body, idempotencyKey ? { idempotencyKey } : {});
}

async function depositAs(world: World, actorKey: string, id: string): Promise<ApiResult<Deposit>> {
  return (await world.as(actorKey)).get<Deposit>(`/deposits/${id}`);
}

describe("S7 collections and branch deposits", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
    await world.activateAgreement("B");
  });
  afterAll(async () => world.close());

  it("credits cash once; strictly above the threshold only after a different manager of the same branch approves (I-36)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const teller = await world.as("teller1");
    const lookup = await teller.get<{ corporate: { name: string }; customer: { displayName: string }; creditAccounts: Array<{ id: string }>; managerThreshold: { minor: string } }>(`/bank/teller/customer-lookup?corporateId=${A}&customerCode=cust-001`);
    expect(lookup.status).toBe(200);
    expect(lookup.data).toMatchObject({ corporate: { name: CORPORATES.A.legalName }, customer: { displayName: "Benghazi Retail Demo" }, managerThreshold: { minor: "2000000" } });
    expect(lookup.data.creditAccounts.map((account) => account.id)).toEqual([OPERATING.id]);

    // Exactly the threshold: no manager. Capture is not a credit.
    const key = crypto.randomUUID();
    const atThreshold = await capture(world, "teller1", intake({ amount: { currency: "LYD", minor: "2000000" }, depositorReference: "SLIP-AT" }), key);
    expect(atThreshold.status).toBe(202);
    expect(atThreshold.data).toMatchObject({ state: "PENDING_POSTING", requiresManager: false, executionReference: null, receipt: { kind: "PENDING_ACKNOWLEDGMENT" } });
    expect(atThreshold.data.intakeReference).toMatch(/^DEP-BR1-2026-\d{6}$/);
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);
    // The same request again, and the same intake under a new key, create nothing new.
    const replay = await capture(world, "teller1", intake({ amount: { currency: "LYD", minor: "2000000" }, depositorReference: "SLIP-AT" }), key);
    expect(replay.data.id).toBe(atThreshold.data.id);
    const twin = await capture(world, "teller1", intake({ amount: { currency: "LYD", minor: "2000000" }, depositorReference: "slip-at" }));
    expect(twin.status).toBe(409);
    expect(twin.body.code).toBe("DUPLICATE_RESOURCE");
    expect(await world.db.deposit.count()).toBe(1);

    await world.drain();
    await world.drain();
    const posted = await depositAs(world, "teller1", atThreshold.data.id);
    expect(posted.data).toMatchObject({ state: "POSTED", receipt: { kind: "POSTED", reference: `RCP-${atThreshold.data.intakeReference}` } });
    expect(posted.data.executionReference).toMatch(/^AQ[0-9A-F]{32}D1$/);
    expect(await coreBalance(world, OPERATING.ref)).toBe(before + 2_000_000n);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: posted.data.executionReference as string } })).toBe(1);

    // One minor unit above the threshold: waits for a manager, credits nothing.
    const above = await capture(world, "teller1", intake({ amount: { currency: "LYD", minor: "2000001" } }));
    expect(above.status).toBe(202);
    expect(above.data).toMatchObject({ state: "PENDING_MANAGER", requiresManager: true });
    const approvalId = above.data.approval?.id as string;
    expect(approvalId).toBeTruthy();
    await world.drain();
    expect(await coreBalance(world, OPERATING.ref)).toBe(before + 2_000_000n);

    // The teller has no approval permission; a manager of another branch cannot even see it.
    expect((await approve(world, approvalId, "teller1")).status).toBe(403);
    expect((await approve(world, approvalId, "manager2")).status).toBe(404);
    expect((await depositAs(world, "manager2", above.data.id)).status).toBe(404);
    // A corporate user and bank operations cannot decide a branch deposit.
    expect([403, 404]).toContain((await approve(world, approvalId, "aChecker1")).status);
    expect([403, 404]).toContain((await approve(world, approvalId, "bankChecker")).status);
    // A person holding both branch roles cannot approve their own intake.
    const own = await capture(world, "branchDual", intake({ amount: { currency: "LYD", minor: "3000000" } }));
    expect(own.data.state).toBe("PENDING_MANAGER");
    const self = await approve(world, own.data.approval?.id as string, "branchDual");
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("SELF_APPROVAL_FORBIDDEN");
    await world.drain();
    expect(await coreBalance(world, OPERATING.ref)).toBe(before + 2_000_000n);

    // A different manager of the same branch approves; the worker credits exactly once.
    expect((await approve(world, approvalId, "manager1")).status).toBe(200);
    // The dual-role person may approve SOMEONE ELSE's intake of their branch.
    expect((await approve(world, own.data.approval?.id as string, "manager1")).status).toBe(200);
    await world.drain();
    await world.drain();
    expect((await depositAs(world, "teller1", above.data.id)).data.state).toBe("POSTED");
    expect(await coreBalance(world, OPERATING.ref)).toBe(before + 2_000_000n + 2_000_001n + 3_000_000n);
    const detail = (await depositAs(world, "manager1", above.data.id)).data;
    expect(detail.timeline.map((event) => event.code)).toEqual(["DEPOSIT_CAPTURED", "DEPOSIT_MANAGER_APPROVED", "DEPOSIT_POSTED"]);
    // Deciding it again has no second effect: no new vote, no second credit.
    expect([200, 409]).toContain((await approve(world, approvalId, "manager1")).status);
    await world.drain();
    expect(await world.db.approvalVote.count({ where: { approvalRequestId: approvalId } })).toBe(1);
    expect(await coreBalance(world, OPERATING.ref)).toBe(before + 2_000_000n + 2_000_001n + 3_000_000n);

    // Large cash is flagged for review (a flag for the bank, never shown to the corporate).
    const large = await capture(world, "teller1", intake({ amount: { currency: "LYD", minor: "10000000" } }));
    expect(large.data).toMatchObject({ requiresManager: true, cashReviewFlag: true });
    expect((await approve(world, large.data.approval?.id as string, "manager1")).status).toBe(200);
    await world.drain();

    // The corporate sees its deposits without the bank's staff or review flag.
    const finance = await world.as("aFinance");
    const list = await finance.get<{ items: Deposit[] }>("/deposits");
    expect(list.status).toBe(200);
    expect(list.data.items).toHaveLength(4);
    expect(list.data.items.every((entry) => entry.cashReviewFlag === false)).toBe(true);
    const corporateDetail = await finance.get<Deposit>(`/deposits/${above.data.id}`);
    expect(corporateDetail.data.approval).toBeNull();
    expect(corporateDetail.data.timeline.every((event) => event.actor === null || event.actor === "worker")).toBe(true);
    expect(corporateDetail.text).not.toContain("Teller BR1");
    expect(corporateDetail.text).not.toContain("Manager BR1");

    // One completion event and one notification per posted deposit; the books reconcile.
    expect(await world.db.outboxEvent.count({ where: { type: "deposit.posted", corporateId: A } })).toBe(4);
    expect(await world.db.notification.count({ where: { kind: "deposit.posted" } })).toBe(4);
    const ops = await world.as("ops");
    const run = await ops.post<{ run: { id: string } }>("/bank/reconciliation-runs", { businessDate: businessDateOf(world.clock.now(), "Africa/Tripoli") });
    await world.drain();
    const recon = await ops.get<{ run: { state: string; expectedCount: number; matchedCount: number; breakCount: number } }>(`/bank/reconciliation-runs/${run.data.run.id}`);
    expect(recon.data.run).toMatchObject({ state: "COMPLETED", expectedCount: 4, matchedCount: 4, breakCount: 0 });
  });

  it("cannot credit the wrong corporate, branch, account or amount (I-35, SEC-01)", async () => {
    const before = await world.db.deposit.count();
    const teller = await world.as("teller1");
    // Another branch in the body; a corporate of another bank; an unknown or archived code.
    expect((await capture(world, "teller1", intake({ branchId: BRANCHES.BR2.id }))).status).toBe(403);
    expect((await capture(world, "teller1", intake({ corporateId: CORPORATES.B.id, creditAccountId: ACCOUNTS.B_OPERATING.id }))).status).toBe(CORPORATES.B.bank === "A" ? 202 : 404);
    expect((await capture(world, "teller1", intake({ customerCode: "CUST-999" }))).status).toBe(404);
    expect((await teller.get(`/bank/teller/customer-lookup?corporateId=${A}&customerCode=CUST-999`)).status).toBe(404);
    // A code without a corporate identifies nobody.
    expect((await teller.get("/bank/teller/customer-lookup?customerCode=CUST-001")).status).toBe(400);
    // An account the agreement does not allow for collections; an amount above the cap.
    const wrongAccount = await capture(world, "teller1", intake({ creditAccountId: ACCOUNTS.A_SAVINGS.id }));
    expect(wrongAccount.status).toBe(422);
    expect(wrongAccount.body.code).toBe("ACCOUNT_NOT_ALLOWED");
    const overCap = await capture(world, "teller1", intake({ amount: { currency: "LYD", minor: "50000001" } }));
    expect(overCap.status).toBe(422);
    expect(overCap.body.code).toBe("MODULE_LIMIT_EXCEEDED");
    // A corporate with no effective agreement cannot be credited at the counter.
    const noAgreement = await capture(world, "teller1", intake({ corporateId: CORPORATES.C.id, creditAccountId: ACCOUNTS.C_OPERATING.id }));
    expect([404, 422]).toContain(noAgreement.status);
    // Malformed or unknown fields, a cheque without a reference, cash with one.
    expect((await capture(world, "teller1", intake({ tellerPersonId: crypto.randomUUID() }))).status).toBe(400);
    expect((await capture(world, "teller1", intake({ method: "CHEQUE" }))).status).toBe(400);
    expect((await capture(world, "teller1", intake({ chequeReference: "CHQ-1" }))).status).toBe(400);
    expect((await capture(world, "teller1", intake({ amount: { currency: "LYD", minor: "0" } }))).status).toBe(400);
    // Only tellers capture: managers, operations and corporate users cannot.
    expect((await capture(world, "manager1", intake())).status).toBe(403);
    expect((await capture(world, "ops", intake())).status).toBe(403);
    expect((await capture(world, "aFinance", intake())).status).toBe(404);
    expect(await world.db.deposit.count()).toBe(before + (CORPORATES.B.bank === "A" ? 1 : 0));

    // Reads: other branch, other corporate, and a person without deposit rights.
    const mine = await capture(world, "teller1", intake());
    expect(mine.status).toBe(202);
    await world.drain();
    expect((await depositAs(world, "teller2", mine.data.id)).status).toBe(404);
    expect((await depositAs(world, "bFinance", mine.data.id)).status).toBe(404);
    expect((await depositAs(world, "aFinance", mine.data.id)).status).toBe(200);
    expect((await (await world.as("teller2")).get<Deposit[]>("/bank/deposits")).data.some((entry) => entry.id === mine.data.id)).toBe(false);
    expect((await (await world.as("aFinance")).get("/bank/deposits")).status).toBe(404);
    // The receipt is authorized at download time and says what it is.
    const receipt = await (await world.as("aFinance")).get(`/deposits/${mine.data.id}/receipt?locale=ar`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get("content-type")).toContain("application/pdf");
    expect(receipt.text.startsWith("%PDF")).toBe(true);
    expect((await (await world.as("bFinance")).get(`/deposits/${mine.data.id}/receipt`)).status).toBe(404);
    expect((await (await world.as("teller2")).get(`/deposits/${mine.data.id}/receipt`)).status).toBe(404);
  });

  it("credits a cheque only after clearing, once, and never after a return (I-37, I-38)", async () => {
    const before = await coreBalance(world, OPERATING.ref);
    const ops = await world.as("ops");
    const cheque = await capture(world, "teller1", intake({ method: "CHEQUE", chequeReference: "CHQ-0001", amount: { currency: "LYD", minor: "750000" } }));
    expect(cheque.status).toBe(202);
    expect(cheque.data).toMatchObject({ state: "ACCEPTED_PENDING_CLEARING", receipt: { kind: "PENDING_ACKNOWLEDGMENT" } });
    await world.drain();
    expect(await coreBalance(world, OPERATING.ref)).toBe(before);
    expect((await ops.get<Deposit[]>("/bank/simulator/cheques")).data.map((entry) => entry.id)).toContain(cheque.data.id);

    // The clearing event arrives twice (and once more after posting): one credit only.
    const events = await race([
      () => ops.post(`/bank/simulator/cheques/${cheque.data.id}/events`, { outcome: "CLEARED", reason: "Simulated clearing" }),
      () => ops.post(`/bank/simulator/cheques/${cheque.data.id}/events`, { outcome: "CLEARED", reason: "Simulated clearing (duplicate)" }),
    ]);
    expect(events.map((response) => response.status)).toEqual([200, 200]);
    await world.drain();
    await world.drain();
    expect((await ops.post(`/bank/simulator/cheques/${cheque.data.id}/events`, { outcome: "CLEARED", reason: "Late duplicate" })).status).toBe(200);
    await world.drain();
    const cleared = (await depositAs(world, "aFinance", cheque.data.id)).data;
    expect(cleared).toMatchObject({ state: "POSTED", receipt: { kind: "POSTED" } });
    expect(await coreBalance(world, OPERATING.ref)).toBe(before + 750_000n);
    expect(await world.db.simCoreJournal.count({ where: { executionReference: cleared.executionReference as string } })).toBe(1);
    expect(await world.db.receipt.count({ where: { depositId: cheque.data.id } })).toBe(2);
    expect(await world.db.outboxEvent.count({ where: { dedupKey: `deposit:${cheque.data.id}:POSTED` } })).toBe(1);
    expect(await world.db.auditEvent.count({ where: { action: "simulator.cheque.event", targetId: cheque.data.id } })).toBe(3);

    // Returned before clearing: no credit, ever — not even if a clearing event follows.
    const bounced = await capture(world, "teller1", intake({ method: "CHEQUE", chequeReference: "CHQ-0002", amount: { currency: "LYD", minor: "900000" } }));
    expect((await ops.post(`/bank/simulator/cheques/${bounced.data.id}/events`, { outcome: "RETURNED", reason: "Insufficient funds at drawee" })).status).toBe(200);
    expect((await ops.post(`/bank/simulator/cheques/${bounced.data.id}/events`, { outcome: "CLEARED", reason: "Out-of-order clearing" })).status).toBe(200);
    await world.drain();
    const returned = (await depositAs(world, "aFinance", bounced.data.id)).data;
    expect(returned).toMatchObject({ state: "RETURNED", executionReference: null, remaining: { minor: "0" }, receipt: { kind: "PENDING_ACKNOWLEDGMENT" } });
    expect(await coreBalance(world, OPERATING.ref)).toBe(before + 750_000n);
    // A returned cheque cannot be allocated to an invoice.
    const finance = await world.as("aFinance");
    const invoice = await finance.post<Invoice>("/invoices", { customerId: customerId("A", "CUST-001"), reference: "INV-RET-1", amount: { currency: "LYD", minor: "900000" }, dueDate: "2026-12-31" });
    expect(invoice.status).toBe(201);
    expect((await finance.post(`/invoices/${invoice.data.id}/allocate`, { depositId: bounced.data.id, amount: { currency: "LYD", minor: "900000" } })).status).toBe(400);
    // Only the sandbox operator of the same bank sends clearing events.
    for (const key of ["teller1", "manager1", "aFinance", "bankBAdmin"]) expect([403, 404]).toContain((await (await world.as(key)).post(`/bank/simulator/cheques/${bounced.data.id}/events`, { outcome: "CLEARED", reason: "Not allowed" })).status);
  });

  it("keeps customer codes unique per corporate, never overpays an invoice and never deletes history (I-33, I-34, I-39)", async () => {
    const finance = await world.as("aFinance");
    const otherFinance = await world.as("bFinance");
    const customer = { code: "CUST-777", displayName: "Synthetic Trading Demo", company: "Synthetic Trading Demo LLC", mobile: "+218912345677" };
    const created = await finance.post<Customer>("/customers", customer);
    expect(created.status).toBe(201);
    // Same code in the same corporate (any letter case) is refused; in another corporate it is a different customer.
    expect((await finance.post("/customers", { ...customer, code: "cust-777" })).status).toBe(409);
    expect((await otherFinance.post("/customers", customer)).status).toBe(201);
    expect((await finance.post("/customers", { ...customer, code: "CUST-778", mobile: "0912345677" })).status).toBe(400);
    expect((await finance.post("/customers", { ...customer, code: "CUST-778", corporateId: CORPORATES.B.id })).status).toBe(400);
    expect((await (await world.as("aViewer")).post("/customers", { ...customer, code: "CUST-779" })).status).toBe(403);
    expect((await otherFinance.get(`/customers/${created.data.id}`)).status).toBe(404);

    // A posted deposit of 1,000 and an invoice of 600 for the same customer.
    const deposit = await capture(world, "teller1", intake({ customerCode: "CUST-777", amount: { currency: "LYD", minor: "1000000" } }));
    await world.drain();
    const invoice = await finance.post<Invoice>("/invoices", { customerId: created.data.id, reference: "INV-777-1", amount: { currency: "LYD", minor: "600000" }, dueDate: "2026-12-15" });
    expect(invoice.status).toBe(201);
    expect((await finance.post("/invoices", { customerId: created.data.id, reference: "inv-777-1", amount: { currency: "LYD", minor: "1" }, dueDate: "2026-12-15" })).status).toBe(409);
    const allocate = (invoiceId: string, minor: string, depositId = deposit.data.id) => finance.post<Invoice>(`/invoices/${invoiceId}/allocate`, { depositId, amount: { currency: "LYD", minor } });
    // More than is due; a deposit of another customer; then two parallel allocations of 400 against 600 due.
    expect((await allocate(invoice.data.id, "600001")).status).toBe(400);
    const foreign = await capture(world, "teller1", intake({ customerCode: "CUST-002", amount: { currency: "LYD", minor: "100000" } }));
    await world.drain();
    expect((await allocate(invoice.data.id, "100000", foreign.data.id)).status).toBe(400);
    const parallel = await race([() => allocate(invoice.data.id, "400000"), () => allocate(invoice.data.id, "400000")]);
    expect(parallel.map((response) => response.status).sort()).toEqual([200, 400]);
    const afterRace = (await finance.get<Customer & { invoices: Invoice[] }>(`/customers/${created.data.id}`)).data;
    expect(afterRace.invoices[0]).toMatchObject({ status: "OPEN", allocated: { minor: "400000" }, due: { minor: "200000" } });
    expect(afterRace.totals).toMatchObject({ deposits: 1, due: { minor: "200000" }, openInvoices: 1 });
    expect(afterRace.referenced).toBe(true);

    // An open invoice blocks archiving; the customer is never deleted.
    const blocked = await finance.patch(`/customers/${created.data.id}`, { archived: true }, { ifMatch: afterRace.version });
    expect(blocked.status).toBe(409);
    const paid = await allocate(invoice.data.id, "200000");
    expect(paid.data).toMatchObject({ status: "PAID", due: { minor: "0" } });
    // Only 400 of the deposit is left: 400.001 is refused.
    const second = await finance.post<Invoice>("/invoices", { customerId: created.data.id, reference: "INV-777-2", amount: { currency: "LYD", minor: "500000" }, dueDate: "2026-12-20" });
    expect((await allocate(second.data.id, "400001")).status).toBe(400);
    expect((await allocate(second.data.id, "400000")).status).toBe(200);
    expect((await depositAs(world, "aFinance", deposit.data.id)).data.remaining.minor).toBe("0");
    expect(await world.db.depositAllocation.count({ where: { depositId: deposit.data.id } })).toBe(3);
    // A viewer can read but not allocate; the allocation history cannot be rewritten.
    expect((await (await world.as("aViewer")).post(`/invoices/${second.data.id}/allocate`, { depositId: deposit.data.id, amount: { currency: "LYD", minor: "1" } })).status).toBe(403);

    // Archive once nothing is open: soft, reversible, and the counter no longer accepts the code.
    const third = await finance.post<Customer>("/customers", { ...customer, code: "CUST-780" });
    const archived = await finance.patch<Customer>(`/customers/${third.data.id}`, { archived: true }, { ifMatch: third.data.version });
    expect(archived.status).toBe(200);
    expect(archived.data.archived).toBe(true);
    expect(await world.db.customer.count({ where: { id: third.data.id } })).toBe(1);
    expect((await capture(world, "teller1", intake({ customerCode: "CUST-780" }))).status).toBe(404);
    expect((await finance.get<Customer[]>("/customers")).data.some((entry) => entry.code === "CUST-780")).toBe(false);
    expect((await finance.get<Customer[]>("/customers?includeArchived=true")).data.some((entry) => entry.code === "CUST-780")).toBe(true);
    expect((await finance.patch(`/customers/${third.data.id}`, { displayName: "Changed" }, { ifMatch: third.data.version })).status).toBe(412);
  });
});
