/**
 * `pnpm smoke` — business smoke test against a RUNNING application and worker (documents 07, 11).
 *
 * It is an ordinary HTTP client: every person signs in with their own credentials and nothing
 * reads or writes the database directly. It performs the first demonstration of the product and
 * fails (exit 1) unless the resulting posting is exactly right:
 *
 *   1. readiness of the app, liveness of the worker
 *   2. one bank administrator proposes a signed sandbox agreement, cannot activate it
 *      themself, and a DIFFERENT administrator activates it (skipped when one is in force)
 *   3. a corporate maker creates and submits a LYD 125.000 supplier payment; repeating the
 *      request with the same idempotency key creates nothing new
 *   4. the maker cannot approve it; a DIFFERENT checker sees the exact recipient, amount and
 *      fee and approves
 *   5. the worker settles it through the simulated core
 *   6. the source balance fell by LYD 125.500, outgoing usage rose by LYD 125.000, and the
 *      statement, the payment and the audit trail carry the same instruction reference
 *   7. repeating the approval and the create request afterwards changes nothing
 *
 * Usage:  pnpm smoke                 (uses APP_BASE_URL and DEMO_PASSWORD from .env)
 *         pnpm smoke --base http://localhost:3100
 *         pnpm smoke --restart-check  (run it while the worker is STOPPED: the approved payment
 *                                      must wait, untouched, until you start the worker again,
 *                                      and must then be posted exactly once)
 * Secrets are never printed. Sandbox only: synthetic people, simulated core and rails.
 */
import { createHash, randomUUID } from "node:crypto";
import { ACCOUNTS, CORPORATES, PEOPLE, beneficiaryId, directory } from "../src/server/seed/fixtures";

const args = process.argv.slice(2);
const baseArg = args.indexOf("--base");
const BASE = (baseArg >= 0 ? args[baseArg + 1] : process.env["APP_BASE_URL"])?.replace(/\/$/, "");
const PASSWORD = process.env["DEMO_PASSWORD"];
const RESTART_CHECK = args.includes("--restart-check");
const SETTLE_TIMEOUT_MS = Number(process.env["SMOKE_SETTLE_TIMEOUT_MS"] ?? (RESTART_CHECK ? 300_000 : 60_000));

const PRINCIPAL = 125_000n; // LYD 125.000 in minor units (three decimals)
const FEE = 500n; // LYD 0.500, the instant-transfer fee of the demo agreement

type Reply<T> = { status: number; headers: Headers; data: T; code: string | undefined; raw: string };

class Failure extends Error {}
const fail = (message: string): never => {
  throw new Failure(message);
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
const step = (text: string) => console.log(`  ok  ${text}`);
const lyd = (minor: bigint) => {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  return `${sign}LYD ${abs / 1000n}.${(abs % 1000n).toString().padStart(3, "0")}`;
};

/** One signed-in person with their own cookie jar. */
class Person {
  private cookie = "";
  constructor(readonly key: string) {}

  async call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, options: { key?: string; ifMatch?: number } = {}): Promise<Reply<T>> {
    const headers = new Headers({ accept: "application/json" });
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET") {
      // What a same-origin browser request carries; a cross-site request would be refused.
      headers.set("origin", BASE as string);
      headers.set("x-alqarib-request", "1");
      headers.set("content-type", "application/json");
      if (options.key) headers.set("idempotency-key", options.key);
    }
    if (options.ifMatch !== undefined) headers.set("if-match", `"${options.ifMatch}"`);
    const response = await fetch(`${BASE}/api/v1${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "manual" });
    const jar = new Map(this.cookie.split("; ").filter(Boolean).map((pair) => [pair.split("=")[0] as string, pair]));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] as string;
      const name = pair.split("=")[0] as string;
      if (/Max-Age=0/i.test(cookie)) jar.delete(name);
      else jar.set(name, pair);
    }
    this.cookie = [...jar.values()].join("; ");
    const raw = await response.text();
    let parsed: { data?: T; code?: string } = {};
    try {
      parsed = raw ? (JSON.parse(raw) as { data?: T; code?: string }) : {};
    } catch {
      parsed = {};
    }
    return { status: response.status, headers: response.headers, data: parsed.data as T, code: parsed.code, raw };
  }
  get<T = unknown>(path: string) {
    return this.call<T>("GET", path);
  }
  post<T = unknown>(path: string, body?: unknown, options: { key?: string; ifMatch?: number } = {}) {
    return this.call<T>("POST", path, body, { key: options.key ?? randomUUID(), ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}) });
  }
}

async function signIn(key: string): Promise<Person> {
  const fixture = PEOPLE.find((entry) => entry.key === key);
  if (!fixture) return fail(`unknown demo person ${key}`);
  const person = new Person(key);
  const reply = await person.call("POST", "/session/login", { email: fixture.email, password: PASSWORD });
  check(reply.status === 200, `sign-in failed for ${fixture.email} (HTTP ${reply.status}${reply.code ? ` ${reply.code}` : ""}). Is the demo data seeded with this DEMO_PASSWORD?`);
  return person;
}

type Approval = { id: string; version: number; targetRevision: number; payloadHash: string; canAct: boolean; eligibility: string; state: string; summary: Record<string, unknown> };
type Payment = {
  id: string;
  reference: string;
  state: string;
  version: number;
  fee: { minor: string };
  executionReference: string | null;
  approval: Approval | null;
  timeline: Array<{ toState: string | null; reference: string | null }>;
};
type Balance = { booked: { minor: string }; available: { minor: string }; holds: { minor: string } };
type Usage = { rows: Array<{ level: string; period: string; metric: string; consumed: { minor: string } | null; reserved: { minor: string } | null }> };
type Line = { kind: string; reference: string | null; signedMinor: string };
type AuditEvent = { action: string; result: string; actor: { kind: string; name: string | null }; target: { type: string; id: string | null }; changes: unknown };

const vote = (approval: Pick<Approval, "targetRevision" | "payloadHash">) => ({ proposalVersion: approval.targetRevision, proposalHash: approval.payloadHash });

async function main(): Promise<void> {
  if (!BASE) fail("APP_BASE_URL is not set (or pass --base http://localhost:3000).");
  if (!PASSWORD) fail("DEMO_PASSWORD is not set. Run `pnpm setup:env`, then `pnpm db:seed`.");
  console.log(`Al Qarib sandbox smoke test against ${BASE}`);

  // 1. Readiness -----------------------------------------------------------------------------
  const ready = await new Person("anonymous").get<{ status: string; mode: string; coreAdapter: string }>("/health/ready").catch(() => null);
  if (!ready) return fail(`the application does not answer at ${BASE}. Start it with \`pnpm start\` (after \`pnpm build\`) or \`pnpm dev\`.`);
  check(ready.status === 200 && ready.data.status === "ready", `the application is not ready (HTTP ${ready.status}): run \`pnpm db:migrate\`.`);
  check(ready.data.mode === "sandbox" && ready.data.coreAdapter === "simulated", "this command only runs against the sandbox with the simulated core.");
  step("application ready: sandbox mode, simulated core, migrations current");

  const [bankMaker, bankChecker, ops, maker, checker, admin] = await Promise.all(["bankMaker", "bankChecker", "ops", "aMaker", "aChecker1", "aAdmin"].map(signIn)) as [Person, Person, Person, Person, Person, Person];
  step("six distinct people signed in with their own credentials (2 bank administrators, operations, maker, checker, corporate administrator)");

  const overview = await ops.get<{ asOf: string; worker: { healthy: boolean; lastSeenAt: string | null } | null }>("/bank/overview");
  check(overview.status === 200 && overview.data.worker !== null, "the operations view is not available");
  if (RESTART_CHECK) {
    check(!overview.data.worker.healthy, "--restart-check must start while the worker is STOPPED (a heartbeat was seen in the last 30 seconds). Stop the worker, wait 30 seconds and run it again.");
    step("worker process is stopped (no heartbeat in the last 30 seconds)");
  } else {
    check(overview.data.worker.healthy, "no worker heartbeat in the last 30 seconds. Start it in a second terminal: `pnpm worker:start` (or `pnpm worker:dev`).");
    step("worker process alive (heartbeat within 30 seconds)");
  }

  // 2. Agreement -----------------------------------------------------------------------------
  const corporateId = CORPORATES.A.id;
  let agreement = await maker.get<{ state: string }>("/agreement");
  check(agreement.status === 200, `the corporate cannot read its agreement (HTTP ${agreement.status})`);
  if (agreement.data.state === "ACTIVE") {
    step(`a signed agreement is already in force for ${CORPORATES.A.legalName} (activation not repeated)`);
  } else {
    const refused = await maker.post("/payments", { moduleId: "1.1" });
    check(refused.status === 422 || refused.status === 400, "a payment was accepted although no agreement is in force");
    const template = await bankMaker.get<Record<string, unknown>>(`/bank/corporates/${corporateId}/agreement-template`);
    check(template.status === 200, `the bank administrator cannot read the agreement template (HTTP ${template.status})`);
    const from = new Date(overview.data.asOf);
    const proposed = await bankMaker.post<{ version: { id: string; approvalRequestId: string; status: string } }>(`/bank/corporates/${corporateId}/agreement-proposals`, {
      effectiveFrom: from.toISOString(),
      effectiveUntil: new Date(from.getTime() + 365 * 86_400_000).toISOString(),
      signatureEvidence: [
        {
          signerReference: `Authorised signatory of ${CORPORATES.A.legalName} (synthetic)`,
          evidenceReference: `SIM-SIGN-${CORPORATES.A.shortCode}-SMOKE`,
          evidenceSha256: createHash("sha256").update(`simulated-signature:${CORPORATES.A.shortCode}:smoke`).digest("hex"),
          acceptedAt: from.toISOString(),
          simulated: true,
        },
      ],
      terms: template.data,
      changeReason: "Initial sandbox agreement from the segment demo template (smoke test)",
    });
    check(proposed.status === 201 && proposed.data.version.status === "PENDING_APPROVAL", `the agreement proposal was not accepted (HTTP ${proposed.status}${proposed.code ? ` ${proposed.code}` : ""})`);
    const approvalId = proposed.data.version.approvalRequestId;
    step("bank administrator (maker) proposed the signed sandbox agreement");

    const own = await bankMaker.get<Approval>(`/approvals/${approvalId}`);
    const self = own.status === 200 ? await bankMaker.post(`/approvals/${approvalId}/approve`, vote(own.data), { ifMatch: own.data.version }) : own;
    check(self.status === 403 || self.status === 404, `the proposer was able to act on their own proposal (HTTP ${self.status})`);
    check((await maker.get<{ state: string }>("/agreement")).data.state !== "ACTIVE", "the agreement became active without an independent approval");
    step("the proposer could not activate their own proposal");

    const review = await bankChecker.get<Approval>(`/approvals/${approvalId}`);
    check(review.status === 200 && review.data.canAct, "the second bank administrator cannot review the proposal");
    const activated = await bankChecker.post<{ state: string }>(`/approvals/${approvalId}/approve`, vote(review.data), { ifMatch: review.data.version });
    check(activated.status === 200 && activated.data.state === "APPROVED", `activation failed (HTTP ${activated.status}${activated.code ? ` ${activated.code}` : ""})`);
    agreement = await maker.get<{ state: string }>("/agreement");
    check(agreement.data.state === "ACTIVE", `the agreement is ${agreement.data.state} after approval, expected ACTIVE`);
    step("a different bank administrator activated it; the corporate now reads an agreement in force");
  }

  // 3. Payment by the maker ------------------------------------------------------------------
  const accountId = ACCOUNTS.A_OPERATING.id;
  const balanceBefore = await maker.get<Balance>(`/accounts/${accountId}/balance`);
  check(balanceBefore.status === 200, "the maker cannot read the source balance");
  const usageOf = async () => {
    const usage = await maker.get<Usage>("/limits/usage");
    check(usage.status === 200, "the maker cannot read limit usage");
    const row = usage.data.rows.find((entry) => entry.level === "CORPORATE" && entry.period === "DAY" && entry.metric === "AMOUNT");
    return { consumed: BigInt(row?.consumed?.minor ?? "0"), reserved: BigInt(row?.reserved?.minor ?? "0") };
  };
  const usageBefore = await usageOf();
  const supplier = directory("SUPPLIER");
  const clientReference = `SMOKE-${Date.now().toString(36).toUpperCase()}`;
  const body = {
    moduleId: "1.1",
    transactionType: "INSTANT_ACCOUNT_CREDIT",
    sourceAccountId: accountId,
    beneficiaryId: beneficiaryId("SUPPLIER"),
    amount: { currency: "LYD", minor: PRINCIPAL.toString() },
    purpose: "Supplier invoice (smoke test)",
    clientReference,
    execution: { mode: "IMMEDIATE" },
  };
  const createKey = randomUUID();
  const created = await maker.post<Payment>("/payments", body, { key: createKey });
  check(created.status === 201, `the payment was not created (HTTP ${created.status}${created.code ? ` ${created.code}` : ""})`);
  const paymentId = created.data.id;
  const replay = await maker.post<Payment>("/payments", body, { key: createKey });
  check(replay.status === 201 && replay.data.id === paymentId && replay.headers.get("idempotent-replay") === "true", "repeating the create request did not return the same payment");
  const conflict = await maker.post("/payments", { ...body, amount: { currency: "LYD", minor: "999000" } }, { key: createKey });
  check(conflict.status === 409, "the same idempotency key with a different amount was not refused");
  const submitted = await maker.post<Payment>(`/payments/${paymentId}/submit`, undefined, { ifMatch: created.data.version });
  check(submitted.status === 202 && submitted.data.state === "PENDING_APPROVAL" && submitted.data.approval, `the payment was not submitted for approval (HTTP ${submitted.status}${submitted.code ? ` ${submitted.code}` : ""})`);
  check(BigInt(submitted.data.fee.minor) === FEE, `the quoted fee is ${submitted.data.fee.minor}, expected ${FEE}`);
  step(`maker created and submitted ${submitted.data.reference}: ${lyd(PRINCIPAL)} to ${supplier.holderName}; the repeated request created nothing new`);

  // 4. Approval by a different person --------------------------------------------------------
  const approvalId = submitted.data.approval.id;
  const mine = await maker.get<Approval>(`/approvals/${approvalId}`);
  const selfVote = mine.status === 200 ? await maker.post(`/approvals/${approvalId}/approve`, vote(mine.data), { ifMatch: mine.data.version }) : mine;
  check(selfVote.status === 403 || selfVote.status === 404, `the maker was able to approve their own payment (HTTP ${selfVote.status})`);
  step("the maker could not approve their own payment");

  const review = await checker.get<Approval>(`/approvals/${approvalId}`);
  check(review.status === 200 && review.data.canAct, "the checker cannot review the payment");
  const summary = review.data.summary as { amount?: { minor: string }; fee?: { minor: string }; totalDebit?: { minor: string }; destination?: { name: string; matchStatus: string } };
  check(summary.amount?.minor === PRINCIPAL.toString(), `the checker is shown amount ${summary.amount?.minor}, expected ${PRINCIPAL}`);
  check(summary.fee?.minor === FEE.toString(), `the checker is shown fee ${summary.fee?.minor}, expected ${FEE}`);
  check(summary.totalDebit?.minor === (PRINCIPAL + FEE).toString(), "the checker is shown a wrong total debit");
  check(summary.destination?.name === supplier.holderName && summary.destination.matchStatus === "MATCHED", "the checker is not shown the verified recipient");
  const approveKey = randomUUID();
  const approved = await checker.post<{ state: string; approvalsCount: number }>(`/approvals/${approvalId}/approve`, vote(review.data), { key: approveKey, ifMatch: review.data.version });
  check(approved.status === 200 && approved.data.state === "APPROVED" && approved.data.approvalsCount === 1, `the approval failed (HTTP ${approved.status}${approved.code ? ` ${approved.code}` : ""})`);
  step(`a different checker reviewed recipient ${supplier.holderName}, amount ${lyd(PRINCIPAL)} and fee ${lyd(FEE)}, then approved`);

  // 5. Settlement by the worker --------------------------------------------------------------
  if (RESTART_CHECK) {
    // Nothing may move while no worker runs: the approved payment waits with its limit reserved.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const waiting = (await maker.get<Payment>(`/payments/${paymentId}`)).data;
    check(waiting.state === "QUEUED", `without a worker the payment is ${waiting.state}, expected QUEUED`);
    const held = await maker.get<Balance>(`/accounts/${accountId}/balance`);
    check(held.data.booked.minor === balanceBefore.data.booked.minor, "the balance moved although no worker is running");
    const reservedNow = await usageOf();
    check(reservedNow.reserved - usageBefore.reserved === PRINCIPAL && reservedNow.consumed === usageBefore.consumed, "the limit is not held as reserved while the payment waits");
    step("with the worker stopped the approved payment waits as QUEUED: balance untouched, limit reserved");
    console.log(`\n  >>> Start the worker now (\`pnpm worker:start\`). You may also stop and start the application. Waiting up to ${SETTLE_TIMEOUT_MS / 1000} seconds…\n`);
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  // During a restart check the application itself may be stopped and started again: the same
  // signed-in session keeps reading once it is back.
  const readPayment = async (previous: Payment): Promise<Payment> => {
    try {
      const reply = await maker.get<Payment>(`/payments/${paymentId}`);
      if (reply.status === 200) return reply.data;
      check(RESTART_CHECK && reply.status >= 500, `the payment can no longer be read (HTTP ${reply.status})`);
      return previous;
    } catch (error) {
      if (!RESTART_CHECK || error instanceof Failure) throw error;
      return previous;
    }
  };
  let payment = await readPayment(submitted.data);
  while (payment.state !== "SETTLED" && Date.now() < deadline) {
    check(!["FAILED", "REJECTED", "CANCELLED", "EXPIRED", "RETURNED", "STATUS_UNKNOWN"].includes(payment.state), `the payment ended as ${payment.state}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    payment = await readPayment(payment);
  }
  check(payment.state === "SETTLED", `the payment is still ${payment.state} after ${SETTLE_TIMEOUT_MS / 1000} seconds: is the worker running?`);
  const reference = payment.executionReference;
  check(reference !== null && /^AQ[0-9A-F]{32}A1$/.test(reference), "the settled payment has no stable instruction reference");
  step(`the ${RESTART_CHECK ? "restarted " : ""}worker settled it through the simulated core (instruction ${reference})`);

  // 6. Exact outcome -------------------------------------------------------------------------
  const balanceAfter = await maker.get<Balance>(`/accounts/${accountId}/balance`);
  const bookedDelta = BigInt(balanceAfter.data.booked.minor) - BigInt(balanceBefore.data.booked.minor);
  check(bookedDelta === -(PRINCIPAL + FEE), `the source balance changed by ${lyd(bookedDelta)}, expected ${lyd(-(PRINCIPAL + FEE))} (was another payment made on this account at the same moment?)`);
  check(BigInt(balanceAfter.data.holds.minor) === BigInt(balanceBefore.data.holds.minor), "a hold was left on the source account");
  const usageAfter = await usageOf();
  check(usageAfter.consumed - usageBefore.consumed === PRINCIPAL, `outgoing usage rose by ${lyd(usageAfter.consumed - usageBefore.consumed)}, expected ${lyd(PRINCIPAL)}`);
  check(usageAfter.reserved === usageBefore.reserved, "a limit reservation was left behind");
  step(`source balance fell by ${lyd(PRINCIPAL + FEE)}; outgoing limit usage rose by ${lyd(PRINCIPAL)} (the fee does not count toward limits)`);

  const statement = await maker.get<{ lines: Line[] }>(`/accounts/${accountId}/statements?reference=${reference}&limit=100`);
  check(statement.status === 200, "the maker cannot read the statement");
  const lines = statement.data.lines.filter((line) => line.reference === reference).map((line) => `${line.kind}:${line.signedMinor}`).sort();
  check(JSON.stringify(lines) === JSON.stringify([`FEE:-${FEE}`, `PAYMENT:-${PRINCIPAL}`]), `the statement shows ${JSON.stringify(lines)} for this instruction`);
  check(payment.timeline.some((event) => event.toState === "SETTLED" && event.reference === reference), "the payment timeline does not carry the instruction reference");
  const audit = await admin.get<AuditEvent[]>(`/audit-events?q=${payment.reference}&limit=100`);
  check(audit.status === 200, `the corporate administrator cannot read the audit trail (HTTP ${audit.status})`);
  const own = audit.data.filter((event) => event.target.type === "payment" && event.target.id === paymentId);
  const actions = own.map((event) => event.action);
  for (const action of ["payment.created", "payment.submitted", "approval.approved", "payment.execution.settled"]) check(actions.includes(action), `the audit trail has no ${action} event for this payment`);
  const settledEvent = own.find((event) => event.action === "payment.execution.settled");
  check((settledEvent?.changes as { reference?: string } | null)?.reference === reference, "the audit trail does not carry the instruction reference");
  check(settledEvent?.actor.kind === "SERVICE", "the settlement was not recorded as done by the worker");
  const people = new Set(own.filter((event) => event.actor.kind === "PERSON" && event.result === "SUCCESS").map((event) => event.actor.name));
  check(people.size === 2, `the audit trail names ${people.size} acting people for this payment, expected the maker and a different checker`);
  step("statement (payment and fee lines), payment timeline and audit trail carry the same instruction reference; maker and checker are two people");

  // 7. Repeating changes nothing -------------------------------------------------------------
  const again = await checker.post<{ approvalsCount: number }>(`/approvals/${approvalId}/approve`, vote(review.data), { key: approveKey, ifMatch: review.data.version });
  check(again.status === 200 && again.data.approvalsCount === 1, "repeating the approval request was not answered with the first result");
  const createdAgain = await maker.post<Payment>("/payments", body, { key: createKey });
  check(createdAgain.status === 201 && createdAgain.data.id === paymentId, "repeating the create request after settlement created another payment");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const balanceFinal = await maker.get<Balance>(`/accounts/${accountId}/balance`);
  check(balanceFinal.data.booked.minor === balanceAfter.data.booked.minor, "the balance moved again after the requests were repeated");
  const linesAgain = (await maker.get<{ lines: Line[] }>(`/accounts/${accountId}/statements?reference=${reference}&limit=100`)).data.lines.filter((line) => line.reference === reference);
  check(linesAgain.length === 2, "the instruction was posted more than once");
  step("repeating the approval and the create request changed nothing: exactly one debit");

  console.log(`\nSMOKE PASSED — payment ${payment.reference}, instruction ${reference}, booked balance now ${lyd(BigInt(balanceFinal.data.booked.minor))}.`);
}

main().catch((error: unknown) => {
  if (error instanceof Failure) console.error(`\nSMOKE FAILED — ${error.message}`);
  else console.error(`\nSMOKE FAILED — unexpected error: ${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
});
