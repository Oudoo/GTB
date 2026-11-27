/**
 * Corporate administration (ADM-01; I-31, I-32): access changes only by an approved proposal
 * inside the signed bank bounds, nobody administers their own access, the last administrator
 * cannot be removed, invitations are single-use, and suspension ends sessions immediately.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, CORPORATES } from "@/server/seed/fixtures";
import { approve } from "./support/payments";
import { Actor, createWorld, TEST_PASSWORD, type World } from "./support/world";

type User = { membershipId: string; name: string; email: string; roles: string[]; status: string; isSelf: boolean; version: number; limits: { perItem: { minor: string }; daily: { minor: string } } | null; grants: Array<{ accountId: string; read: boolean; debit: boolean }> };
type Proposal = { id: string; kind: string; status: string; approval: { id: string; state: string } | null };
type Inbox = Array<{ toEmail: string; path: string | null; used: boolean }>;

const lyd = (minor: string) => ({ currency: "LYD", minor });
const grant = (accountId: string, rights: Partial<{ read: boolean; debit: boolean; approve: boolean; report: boolean }> = {}) => ({ accountId, read: true, debit: false, approve: false, report: false, ...rights });

async function users(world: World, key = "aAdmin"): Promise<User[]> {
  const response = await (await world.as(key)).get<User[]>("/admin/users");
  if (response.status !== 200) throw new Error(`users failed: ${response.status} ${response.text}`);
  return response.data;
}
const memberOf = async (world: World, emailLocal: string) => (await users(world)).find((user) => user.email.startsWith(`${emailLocal}@`)) as User;

/** Sign in with an explicit e-mail and password (people created by an invitation). */
async function signInAs(world: World, email: string, password: string): Promise<{ actor: Actor; status: number }> {
  const actor = world.anonymous();
  const response = await actor.post("/session/login", { email, password }, { idempotencyKey: null });
  return { actor, status: response.status };
}

describe("corporate administration", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
    await world.activateAgreement("B");
  });
  afterAll(async () => world.close());

  it("changes access only through an approved proposal inside the bank's bounds; nobody administers themself (I-31)", async () => {
    const admin = await world.as("aAdmin");
    const me = (await users(world)).find((user) => user.isSelf) as User;
    const maker = await memberOf(world, "a.maker");
    expect(maker.limits).toEqual({ perItem: { currency: "LYD", minor: "3000000" }, daily: { currency: "LYD", minor: "10000000" } });
    const change = (overrides: Record<string, unknown> = {}) => ({ kind: "CHANGE_ACCESS", membershipId: maker.membershipId, roles: ["MAKER"], grants: [grant(ACCOUNTS.A_OPERATING.id, { debit: true }), grant(ACCOUNTS.A_SAVINGS.id, { debit: true })], limits: { perItem: lyd("4000000"), daily: lyd("12000000") }, reason: "Raise the maker allowance for the quarter", ...overrides });

    // An administrator cannot give themself payment or payroll rights — not even within bounds.
    const selfGrant = await admin.post("/admin/user-proposals", change({ membershipId: me.membershipId, roles: ["CORPORATE_ADMIN", "MAKER", "PAYROLL_OFFICER", "CHECKER"], grants: [grant(ACCOUNTS.A_PAYROLL.id, { debit: true, approve: true })] }));
    expect(selfGrant.status).toBe(403);
    // Beyond the signed envelope (LYD 8,000 per item / 30,000 a day), outside the agreement, or not a corporate role.
    const overItem = await admin.post("/admin/user-proposals", change({ limits: { perItem: lyd("8000001"), daily: lyd("12000000") } }));
    expect(overItem.status).toBe(422);
    expect(overItem.body.code).toBe("USER_LIMIT_EXCEEDED");
    expect((await admin.post("/admin/user-proposals", change({ limits: { perItem: lyd("4000000"), daily: lyd("30000001") } }))).status).toBe(422);
    expect((await admin.post("/admin/user-proposals", change({ limits: { perItem: lyd("5000000"), daily: lyd("4000000") } }))).status).toBe(422);
    const foreignAccount = await admin.post("/admin/user-proposals", change({ grants: [grant(ACCOUNTS.B_OPERATING.id, { debit: true })] }));
    expect(foreignAccount.status).toBe(422);
    expect(foreignAccount.body.code).toBe("ACCOUNT_NOT_ALLOWED");
    expect((await admin.post("/admin/user-proposals", change({ roles: ["BANK_ADMIN_CHECKER"] }))).status).toBe(400);
    expect((await admin.post("/admin/user-proposals", change({ roles: ["MAKER"], permissions: ["payroll.detail"] }))).status).toBe(400);
    expect((await admin.post("/admin/user-proposals", change({ grants: [grant(ACCOUNTS.A_OPERATING.id, { read: false, debit: true })] }))).status).toBe(400);
    expect((await admin.post("/admin/user-proposals", change({ corporateId: CORPORATES.B.id }))).status).toBe(400);
    // Other people: no proposal permission; another corporate's member does not exist for them.
    expect((await (await world.as("aMaker")).post("/admin/user-proposals", change())).status).toBe(403);
    expect((await (await world.as("aChecker1")).post("/admin/user-proposals", change())).status).toBe(403);
    expect((await (await world.as("bFinance")).get("/admin/users")).status).toBe(403);
    expect(await world.db.userChangeProposal.count()).toBe(0);

    // A valid proposal changes nothing until a different eligible person approves it.
    const proposed = await admin.post<Proposal>("/admin/user-proposals", change());
    expect(proposed.status).toBe(202);
    expect(proposed.data).toMatchObject({ kind: "LIMIT_CHANGE", status: "PENDING_APPROVAL" });
    const approvalId = proposed.data.approval?.id as string;
    expect((await memberOf(world, "a.maker")).limits?.perItem.minor).toBe("3000000");
    // A second open proposal for the same member is refused.
    expect((await admin.post("/admin/user-proposals", change())).status).toBe(409);
    // The proposer, the person concerned and people without the permission cannot decide it.
    const own = await approve(world, approvalId, "aAdmin");
    expect(own.status).toBe(403);
    expect(own.body.code).toBe("SELF_APPROVAL_FORBIDDEN");
    expect([403, 404]).toContain((await approve(world, approvalId, "aMaker")).status);
    expect([403, 404]).toContain((await approve(world, approvalId, "aFinance")).status);
    expect([403, 404]).toContain((await approve(world, approvalId, "bChecker")).status);
    expect((await approve(world, approvalId, "aChecker1")).status).toBe(200);
    const changed = await memberOf(world, "a.maker");
    expect(changed.limits).toEqual({ perItem: { currency: "LYD", minor: "4000000" }, daily: { currency: "LYD", minor: "12000000" } });
    expect(changed.grants.filter((entry) => entry.debit).map((entry) => entry.accountId).sort()).toEqual([ACCOUNTS.A_OPERATING.id, ACCOUNTS.A_SAVINGS.id].sort());
    // The new allowance is what the maker's own session now carries.
    const session = await (await world.as("aMaker")).get<{ context: { userLimits: { perItemMinor: string } } }>("/session");
    expect(session.data.context.userLimits.perItemMinor).toBe("4000000");

    // The person whose access changes cannot approve the change, even with the approval permission.
    const checker = await memberOf(world, "a.checker1");
    const forChecker = await admin.post<Proposal>("/admin/user-proposals", { kind: "CHANGE_ACCESS", membershipId: checker.membershipId, roles: ["CHECKER", "MAKER"], grants: [grant(ACCOUNTS.A_OPERATING.id, { debit: true, approve: true })], limits: { perItem: lyd("1000000"), daily: lyd("2000000") }, reason: "Checker also prepares small payments" });
    expect(forChecker.data.kind).toBe("ROLE_CHANGE");
    expect((await approve(world, forChecker.data.approval?.id as string, "aChecker1")).status).toBe(403);
    expect((await approve(world, forChecker.data.approval?.id as string, "aAdmin2")).status).toBe(200);
    expect((await memberOf(world, "a.checker1")).roles.sort()).toEqual(["CHECKER", "MAKER"]);

    // Audit holds who proposed and what kind of change — never a secret.
    const audit = await world.db.auditEvent.findMany({ where: { action: "admin.user.proposed" } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("password");
  });

  it("never removes the last active administrator", async () => {
    const admin = await world.as("aAdmin");
    const admin2 = await world.as("aAdmin2");
    const first = (await users(world)).find((user) => user.email.startsWith("a.admin@")) as User;
    const second = (await users(world)).find((user) => user.email.startsWith("a.admin2@")) as User;
    const demote = (membershipId: string) => ({ kind: "CHANGE_ACCESS", membershipId, roles: ["VIEWER"], grants: [], limits: null, reason: "Rotate the administrator role" });
    // Two administrators: each proposes to demote the other. Both proposals are valid on their own.
    const demoteSecond = await admin.post<Proposal>("/admin/user-proposals", demote(second.membershipId));
    const demoteFirst = await admin2.post<Proposal>("/admin/user-proposals", demote(first.membershipId));
    expect([demoteSecond.status, demoteFirst.status]).toEqual([202, 202]);
    expect((await approve(world, demoteSecond.data.approval?.id as string, "aChecker2")).status).toBe(200);
    expect((await memberOf(world, "a.admin2")).roles).toEqual(["VIEWER"]);
    // Applying the second would leave the corporate without an administrator: refused.
    const last = await approve(world, demoteFirst.data.approval?.id as string, "aChecker2");
    expect(last.status).toBe(409);
    expect(JSON.stringify(last.body)).toContain("lastAdministrator");
    expect((await memberOf(world, "a.admin")).roles).toContain("CORPORATE_ADMIN");
    // The only administrator cannot suspend themself either.
    const self = (await users(world)).find((user) => user.isSelf) as User;
    expect((await admin.post(`/admin/users/${self.membershipId}/suspend`, { reason: "Leaving the company" }, { ifMatch: self.version })).status).toBe(403);
  });

  it("delivers a single-use invitation through the sandbox inbox and never touches an existing password", async () => {
    const admin = await world.as("aAdmin");
    const email = "new.viewer@demo.alqarib.test";
    const invite = (overrides: Record<string, unknown> = {}) => ({ kind: "INVITE", email, displayName: "Nabil Invited (Demo)", roles: ["VIEWER"], grants: [grant(ACCOUNTS.A_OPERATING.id, { report: true })], limits: null, reason: "New finance analyst", ...overrides });
    // An invitation is bounded like any other access.
    expect((await admin.post("/admin/user-proposals", invite({ grants: [grant(ACCOUNTS.B_OPERATING.id)] }))).status).toBe(422);
    expect((await admin.post("/admin/user-proposals", invite({ email: "a.maker@demo.alqarib.test" }))).status).toBe(409);
    const proposed = await admin.post<Proposal>("/admin/user-proposals", invite({ email: "New.Viewer@Demo.AlQarib.test" }));
    expect(proposed.status).toBe(202);
    // No link exists before the approval.
    expect((await admin.get<Inbox>("/admin/local-inbox")).data).toEqual([]);
    expect((await approve(world, proposed.data.approval?.id as string, "aChecker2")).status).toBe(200);
    const inbox = (await admin.get<Inbox>("/admin/local-inbox")).data;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ toEmail: email, used: false });
    const token = (inbox[0]?.path as string).split("/").pop() as string;
    // Only the hash is stored with the invitation; other people cannot read the inbox.
    expect(JSON.stringify(await world.db.invitation.findMany())).not.toContain(token);
    for (const key of ["aMaker", "aChecker1", "bFinance"]) expect((await (await world.as(key)).get("/admin/local-inbox")).status).toBe(403);

    const anonymous = world.anonymous();
    const lookup = await anonymous.post<{ email: string; corporate: { name: string }; existingIdentity: boolean }>("/invitations/lookup", { token }, { idempotencyKey: null });
    expect(lookup.status).toBe(200);
    expect(lookup.data).toMatchObject({ email, corporate: { name: CORPORATES.A.legalName }, existingIdentity: false });
    expect((await anonymous.post("/invitations/lookup", { token: `${token.slice(0, -3)}abc` }, { idempotencyKey: null })).status).toBe(404);
    expect((await anonymous.post("/invitations/accept", { token, password: "short" }, { idempotencyKey: null })).status).toBe(400);
    const accepted = await anonymous.post("/invitations/accept", { token, password: "Invited-Person-Password-01" }, { idempotencyKey: null });
    expect(accepted.status).toBe(200);
    // Single use: the same link works neither again nor for a lookup.
    expect((await anonymous.post("/invitations/accept", { token, password: "Another-Password-0002" }, { idempotencyKey: null })).status).toBe(404);
    expect((await anonymous.post("/invitations/lookup", { token }, { idempotencyKey: null })).status).toBe(404);
    expect((await admin.get<Inbox>("/admin/local-inbox")).data[0]).toMatchObject({ used: true, path: null });

    // The new person signs in and has exactly the approved access.
    const invited = await signInAs(world, email, "Invited-Person-Password-01");
    expect(invited.status).toBe(200);
    const accounts = await invited.actor.get<Array<{ id: string }>>("/accounts");
    expect(accounts.status).toBe(200);
    expect(accounts.data.map((account) => account.id)).toEqual([ACCOUNTS.A_OPERATING.id]);
    expect((await invited.actor.post("/payments", {})).status).toBe(403);
    expect((await invited.actor.get("/admin/users")).status).toBe(403);
    expect((await signInAs(world, email, "Another-Password-0002")).status).toBe(401);

    // An expired invitation is as good as none.
    const late = await admin.post<Proposal>("/admin/user-proposals", invite({ email: "late.viewer@demo.alqarib.test", displayName: "Late Invitee (Demo)" }));
    expect((await approve(world, late.data.approval?.id as string, "aChecker2")).status).toBe(200);
    const lateToken = ((await admin.get<Inbox>("/admin/local-inbox")).data.find((entry) => entry.toEmail.startsWith("late.viewer"))?.path as string).split("/").pop() as string;
    world.clock.advanceMs(8 * 86_400_000);
    expect((await anonymous.post("/invitations/accept", { token: lateToken, password: "Invited-Person-Password-02" }, { idempotencyKey: null })).status).toBe(404);
    expect(await world.db.person.count({ where: { email: "late.viewer@demo.alqarib.test" } })).toBe(0);

    // Inviting someone who already has an identity adds a membership and leaves their password alone.
    const existing = await admin.post<Proposal>("/admin/user-proposals", invite({ email: "b.viewer@demo.alqarib.test", displayName: "Wafa Viewer (Demo)" }));
    expect((await approve(world, existing.data.approval?.id as string, "aChecker2")).status).toBe(200);
    const existingToken = ((await admin.get<Inbox>("/admin/local-inbox")).data.find((entry) => entry.toEmail.startsWith("b.viewer"))?.path as string).split("/").pop() as string;
    expect((await anonymous.post<{ existingIdentity: boolean }>("/invitations/lookup", { token: existingToken }, { idempotencyKey: null })).data.existingIdentity).toBe(true);
    expect((await anonymous.post("/invitations/accept", { token: existingToken, password: "Attacker-Chosen-Password-9" }, { idempotencyKey: null })).status).toBe(200);
    expect((await signInAs(world, "b.viewer@demo.alqarib.test", "Attacker-Chosen-Password-9")).status).toBe(401);
    const original = await signInAs(world, "b.viewer@demo.alqarib.test", TEST_PASSWORD);
    expect(original.status).toBe(200);
    const memberships = (await original.actor.get<{ memberships: Array<{ corporateId: string | null }> }>("/session")).data.memberships;
    expect(memberships.map((membership) => membership.corporateId).sort()).toEqual([CORPORATES.A.id, CORPORATES.B.id].sort());
  });

  it("suspends immediately, ends sessions, and re-enables only through approval (I-32)", async () => {
    const admin = await world.as("aAdmin");
    // The finance user is signed in, has requested a report and holds a session cookie.
    const finance = await world.signIn("aFinance");
    const today = "2026-11-23";
    const report = await finance.post<{ id: string }>("/reports", { type: "STATEMENT", format: "CSV", accountIds: [ACCOUNTS.A_OPERATING.id], fromDate: today, toDate: today });
    await world.drain();
    expect((await finance.get(`/reports/${report.data.id}/download`)).status).toBe(200);
    const member = await memberOf(world, "a.finance");

    // Who may suspend, and whom.
    expect((await (await world.as("aMaker")).post(`/admin/users/${member.membershipId}/suspend`, { reason: "Not allowed" }, { ifMatch: member.version })).status).toBe(403);
    expect((await admin.post(`/admin/users/${member.membershipId}/suspend`, { reason: "Stale version" }, { ifMatch: member.version + 3 })).status).toBe(412);
    const outsider = await world.db.membership.findFirstOrThrow({ where: { corporateId: CORPORATES.B.id } });
    expect((await admin.post(`/admin/users/${outsider.id}/suspend`, { reason: "Another corporate" }, { ifMatch: outsider.version })).status).toBe(404);

    const suspended = await admin.post<User>(`/admin/users/${member.membershipId}/suspend`, { reason: "Left the finance team" }, { ifMatch: member.version });
    expect(suspended.status).toBe(200);
    expect(suspended.data.status).toBe("SUSPENDED");
    // The existing session, the report link and every other call stop working at once.
    expect((await finance.get("/accounts")).status).toBe(401);
    expect((await finance.get(`/reports/${report.data.id}/download`)).status).toBe(401);
    expect((await finance.post("/customers", { code: "CUST-X", displayName: "After Suspension", company: "After Suspension", mobile: "+218912340002" })).status).toBe(401);
    // Signing in again gives no way back into the corporate.
    const again = await signInAs(world, "a.finance@demo.alqarib.test", TEST_PASSWORD);
    expect([401, 403]).toContain((await again.actor.get("/accounts")).status);
    expect([401, 403, 404]).toContain((await again.actor.get(`/reports/${report.data.id}/download`)).status);
    const auditRow = await world.db.auditEvent.findFirstOrThrow({ where: { action: "admin.user.suspended", targetId: member.membershipId } });
    expect(auditRow.reason).toBe("Left the finance team");

    // Re-enabling is a privilege increase: it needs a proposal and a second person.
    const current = await memberOf(world, "a.finance");
    expect((await admin.post(`/admin/users/${current.membershipId}/suspend`, { reason: "Already suspended" }, { ifMatch: current.version })).status).toBe(409);
    const reactivate = await admin.post<Proposal>("/admin/user-proposals", { kind: "REACTIVATE", membershipId: current.membershipId, reason: "Back from leave" });
    expect(reactivate.status).toBe(202);
    expect((await memberOf(world, "a.finance")).status).toBe("SUSPENDED");
    expect((await approve(world, reactivate.data.approval?.id as string, "aAdmin")).status).toBe(403);
    expect((await approve(world, reactivate.data.approval?.id as string, "aChecker2")).status).toBe(200);
    expect((await memberOf(world, "a.finance")).status).toBe("ACTIVE");
    const back = await signInAs(world, "a.finance@demo.alqarib.test", TEST_PASSWORD);
    expect((await back.actor.get("/accounts")).status).toBe(200);
  });
});
