/**
 * Corporate user administration (ADM-01).
 *
 * - Access is changed by PROPOSAL: an administrator asks, a different eligible person approves.
 *   Nobody can propose a change to, or approve a change of, their own access.
 * - Every proposal is checked against the signed agreement when it is made AND when it is
 *   applied: only corporate roles, only agreement-linked accounts, user allowance inside the
 *   bank's envelope. There is no superuser and no way to name a permission directly.
 * - Suspension is immediate and revokes the person's sessions. Re-enabling needs approval.
 * - The last active administrator can be neither suspended nor demoted.
 * - Invitations are hashed, single-use, expiring tokens delivered to a sandbox-only local
 *   inbox. Accepting one never changes the password of an identity that already exists.
 */
import { invitationAcceptSchema, userProposalSchema, type UserProposalInput } from "@/contracts/admin";
import { DomainError, conflict, denied, notFound } from "@/contracts/errors";
import { minorToJson, type MoneyJson } from "@/contracts/money";
import { writeAudit } from "@/server/audit/audit";
import { hashPassword } from "@/server/auth/password";
import { requireCorporate, requirePermission, requirePerson, type AuthContext, type CorporateContext } from "@/server/auth/context";
import { normalizeEmail, revokeSessionsOf } from "@/server/auth/session";
import { inTx, type DbOrTx, type Prisma, type Tx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { requireEffectivePolicy } from "@/server/domain/agreements/policy";
import { createApprovalRequest, getApproval, type ApprovalView } from "@/server/domain/approvals/service";
import { digestOf, randomToken, sha256Hex } from "@/server/hash";
import type { Membership, Role, UserChangeProposal } from "@/generated/prisma/client";

const INVITATION_VALIDITY_DAYS = 7;
const tokenHash = (token: string) => sha256Hex(`alqarib-invitation:${token}`);

type Access = { roles: Role[]; grants: Array<{ accountId: string; read: boolean; debit: boolean; approve: boolean; report: boolean }>; limits: { perItemMinor: string; dailyMinor: string } | null };
type Payload = { kind: "INVITE"; email: string; displayName: string; access: Access } | { kind: "CHANGE_ACCESS"; access: Access } | { kind: "REACTIVATE" };

export type UserView = {
  membershipId: string;
  name: string;
  email: string;
  roles: Role[];
  status: Membership["status"];
  limits: { perItem: MoneyJson; daily: MoneyJson } | null;
  grants: Array<{ accountId: string; name: string; nameAr: string; maskedNumber: string; read: boolean; debit: boolean; approve: boolean; report: boolean }>;
  isSelf: boolean;
  version: number;
};

export async function listUsers(deps: Deps, ctx: AuthContext): Promise<UserView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "admin.users.read");
  const members = await deps.db.membership.findMany({
    where: { corporateId: corporateCtx.corporateId, kind: "CORPORATE" },
    include: { person: { select: { id: true, name: true, email: true } }, grants: { include: { account: { select: { name: true, nameAr: true, maskedNumber: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const self = corporateCtx.principal.kind === "person" ? corporateCtx.principal.personId : null;
  // Identity and access only: never a password, a hash or a session.
  return members.map((member) => ({
    membershipId: member.id,
    name: member.person.name,
    email: member.person.email,
    roles: member.roles,
    status: member.status,
    limits: member.userPerItemLimitMinor !== null && member.userDailyLimitMinor !== null ? { perItem: minorToJson(member.userPerItemLimitMinor, "LYD"), daily: minorToJson(member.userDailyLimitMinor, "LYD") } : null,
    grants: member.grants.map((grant) => ({ accountId: grant.accountId, name: grant.account.name, nameAr: grant.account.nameAr, maskedNumber: grant.account.maskedNumber, read: grant.canRead, debit: grant.canDebit, approve: grant.canApprove, report: grant.canReport })),
    isSelf: member.personId === self,
    version: member.version,
  }));
}

/** Check a desired access against the signed agreement. Throws; never silently trims. */
async function assertWithinBounds(deps: Deps, db: DbOrTx, corporateId: string, access: Access): Promise<void> {
  const policy = await requireEffectivePolicy(db, corporateId, deps.clock.now());
  const linked = new Set(policy.terms.linkedAccounts);
  const accounts = await db.account.findMany({ where: { corporateId, id: { in: access.grants.map((grant) => grant.accountId) } }, select: { id: true } });
  const own = new Set(accounts.map((account) => account.id));
  if (new Set(access.grants.map((grant) => grant.accountId)).size !== access.grants.length) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "grants", rule: "duplicateAccount", message: "An account is listed twice." }] });
  if (access.grants.some((grant) => !own.has(grant.accountId) || !linked.has(grant.accountId))) throw new DomainError("ACCOUNT_NOT_ALLOWED", { violations: [{ field: "grants", rule: "agreement.linkedAccount" }] });
  if (access.grants.some((grant) => (grant.debit || grant.approve || grant.report) && !grant.read)) throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "grants", rule: "readRequired", message: "A right on an account needs read access to it." }] });
  if (access.limits) {
    const perItem = BigInt(access.limits.perItemMinor);
    const daily = BigInt(access.limits.dailyMinor);
    const envelope = policy.terms.userLimitEnvelope;
    // The bank's envelope is a ceiling nobody inside the corporate can raise.
    if (perItem > BigInt(envelope.perItemMinor) || daily > BigInt(envelope.dailyMinor) || perItem > daily) {
      throw new DomainError("USER_LIMIT_EXCEEDED", { violations: [{ field: "limits", rule: "agreement.userLimitEnvelope", limitMinor: envelope.perItemMinor, dailyLimitMinor: envelope.dailyMinor }] });
    }
  }
}

function accessOf(input: Extract<UserProposalInput, { kind: "INVITE" | "CHANGE_ACCESS" }>): Access {
  for (const amount of input.limits ? [input.limits.perItem, input.limits.daily] : []) {
    if (amount.currency !== "LYD") throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "limits", rule: "currency", message: "User allowances are in LYD." }] });
  }
  return {
    roles: [...new Set(input.roles)] as Role[],
    grants: input.grants,
    limits: input.limits ? { perItemMinor: input.limits.perItem.minor, dailyMinor: input.limits.daily.minor } : null,
  };
}

async function activeAdmins(db: DbOrTx, corporateId: string): Promise<string[]> {
  const admins = await db.membership.findMany({ where: { corporateId, kind: "CORPORATE", status: "ACTIVE", roles: { has: "CORPORATE_ADMIN" }, person: { status: "ACTIVE" } }, select: { id: true } });
  return admins.map((admin) => admin.id);
}

/** Removing the admin role from, or suspending, the only active administrator is refused. */
async function assertNotLastAdmin(db: DbOrTx, corporateId: string, membershipId: string): Promise<void> {
  const admins = await activeAdmins(db, corporateId);
  if (admins.length === 1 && admins[0] === membershipId) {
    throw new DomainError("STATE_CONFLICT", { detail: "This is the last active administrator. Bank-assisted recovery is needed to change it.", violations: [{ field: "membershipId", rule: "lastAdministrator", message: "The last active administrator cannot be removed." }] });
  }
}

export type UserProposalView = {
  id: string;
  kind: UserChangeProposal["kind"];
  status: UserChangeProposal["status"];
  target: { membershipId: string | null; name: string; email: string };
  access: { roles: Role[]; grants: number; limits: { perItem: MoneyJson; daily: MoneyJson } | null } | null;
  reason: string;
  proposedBy: string;
  createdAt: string;
  approval: ApprovalView | null;
};

async function proposalViews(deps: Deps, ctx: AuthContext, rows: UserChangeProposal[]): Promise<UserProposalView[]> {
  const memberIds = rows.map((row) => row.targetMembershipId).filter((id): id is string => id !== null);
  const members = await deps.db.membership.findMany({ where: { id: { in: memberIds } }, include: { person: { select: { name: true, email: true } } } });
  const memberById = new Map(members.map((member) => [member.id, member]));
  const people = await deps.db.person.findMany({ where: { id: { in: rows.map((row) => row.proposedByPersonId) } }, select: { id: true, name: true } });
  const nameById = new Map(people.map((person) => [person.id, person.name]));
  const out: UserProposalView[] = [];
  for (const row of rows) {
    const payload = row.payload as unknown as Payload;
    const member = row.targetMembershipId ? memberById.get(row.targetMembershipId) : undefined;
    const access = payload.kind === "REACTIVATE" ? null : payload.access;
    out.push({
      id: row.id,
      kind: row.kind,
      status: row.status,
      target: payload.kind === "INVITE" ? { membershipId: null, name: payload.displayName, email: payload.email } : { membershipId: row.targetMembershipId, name: member?.person.name ?? "", email: member?.person.email ?? "" },
      access: access ? { roles: access.roles, grants: access.grants.length, limits: access.limits ? { perItem: minorToJson(BigInt(access.limits.perItemMinor), "LYD"), daily: minorToJson(BigInt(access.limits.dailyMinor), "LYD") } : null } : null,
      reason: row.reason,
      proposedBy: nameById.get(row.proposedByPersonId) ?? "",
      createdAt: row.createdAt.toISOString(),
      approval: row.approvalRequestId ? await getApproval(deps, ctx, row.approvalRequestId).catch(() => null) : null,
    });
  }
  return out;
}

export async function listUserProposals(deps: Deps, ctx: AuthContext): Promise<UserProposalView[]> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "admin.users.read");
  const rows = await deps.db.userChangeProposal.findMany({ where: { corporateId: corporateCtx.corporateId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
  return proposalViews(deps, corporateCtx, rows);
}

export async function getUserProposal(deps: Deps, ctx: AuthContext, proposalId: string): Promise<UserProposalView> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "admin.users.read");
  const row = await deps.db.userChangeProposal.findFirst({ where: { id: proposalId, corporateId: corporateCtx.corporateId } });
  if (!row) throw notFound();
  return (await proposalViews(deps, corporateCtx, [row]))[0] as UserProposalView;
}

const kindOf = (current: Membership & { grants: unknown[] }, access: Access): UserChangeProposal["kind"] =>
  [...current.roles].sort().join() !== [...access.roles].sort().join() ? "ROLE_CHANGE" : (current.userPerItemLimitMinor?.toString() ?? null) !== (access.limits?.perItemMinor ?? null) || (current.userDailyLimitMinor?.toString() ?? null) !== (access.limits?.dailyMinor ?? null) ? "LIMIT_CHANGE" : "GRANT_CHANGE";

export async function proposeUserChange(deps: Deps, ctx: AuthContext, rawInput: unknown, proposalId: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "admin.users.propose");
  const person = requirePerson(corporateCtx);
  const input = userProposalSchema.parse(rawInput);
  const now = deps.clock.now();
  const corporateId = corporateCtx.corporateId;

  let payload: Payload;
  let kind: UserChangeProposal["kind"];
  let target: (Membership & { person: { id: string; name: string; email: string }; grants: unknown[] }) | null = null;
  let activeKey: string;
  let label: { name: string; email: string };
  if (input.kind === "INVITE") {
    const email = normalizeEmail(input.email);
    const access = accessOf(input);
    await assertWithinBounds(deps, deps.db, corporateId, access);
    const existing = await deps.db.membership.findFirst({ where: { corporateId, person: { email } }, select: { id: true } });
    if (existing) throw new DomainError("DUPLICATE_RESOURCE", { detail: "This person is already a member. Propose an access change instead." });
    payload = { kind: "INVITE", email, displayName: input.displayName, access };
    kind = "INVITE";
    activeKey = `userChange:${corporateId}:invite:${email}`;
    label = { name: input.displayName, email };
  } else {
    target = await deps.db.membership.findFirst({ where: { id: input.membershipId, corporateId, kind: "CORPORATE" }, include: { person: { select: { id: true, name: true, email: true } }, grants: true } });
    if (!target) throw notFound();
    // Nobody administers their own access — not even inside the bank's bounds.
    if (target.personId === person.personId) throw new DomainError("PERMISSION_DENIED", { detail: "You cannot change your own access. Another administrator must propose it." });
    activeKey = `userChange:${corporateId}:member:${target.id}`;
    label = { name: target.person.name, email: target.person.email };
    if (input.kind === "REACTIVATE") {
      if (target.status !== "SUSPENDED") throw conflict("This member is not suspended.");
      payload = { kind: "REACTIVATE" };
      kind = "REACTIVATE";
    } else {
      if (target.status !== "ACTIVE") throw conflict("Only an active member's access can be changed.");
      const access = accessOf(input);
      await assertWithinBounds(deps, deps.db, corporateId, access);
      if (target.roles.includes("CORPORATE_ADMIN") && !access.roles.includes("CORPORATE_ADMIN")) await assertNotLastAdmin(deps.db, corporateId, target.id);
      payload = { kind: "CHANGE_ACCESS", access };
      kind = kindOf(target, access);
    }
  }
  const payloadHash = digestOf({ proposalId, targetMembershipId: target?.id ?? null, payload });

  await inTx(deps.db, async (tx) => {
    await tx.userChangeProposal.create({ data: { id: proposalId, bankId: corporateCtx.bankId, corporateId, kind, targetMembershipId: target?.id ?? null, payload: payload as unknown as Prisma.InputJsonValue, payloadHash, status: "PENDING_APPROVAL", reason: input.reason, proposedByPersonId: person.personId, createdAt: now } });
    const access = payload.kind === "REACTIVATE" ? null : payload.access;
    const request = await createApprovalRequest(tx, {
      bankId: corporateCtx.bankId,
      corporateId,
      klass: "CORPORATE_ADMIN",
      targetType: "userChange",
      targetId: proposalId,
      targetRevision: 1,
      payloadHash,
      summary: {
        kind: "USER_CHANGE",
        change: kind,
        reference: label.email,
        title: label.name,
        linkPath: "/admin/users",
        targetName: label.name,
        targetEmail: label.email,
        reason: input.reason,
        ...(access ? { roles: access.roles.join(", "), previousRoles: target ? target.roles.join(", ") : null, accounts: access.grants.length, debitAccounts: access.grants.filter((grant) => grant.debit).length, approveAccounts: access.grants.filter((grant) => grant.approve).length, perItemLimit: access.limits ? { currency: "LYD", minor: access.limits.perItemMinor } : null, dailyLimit: access.limits ? { currency: "LYD", minor: access.limits.dailyMinor } : null } : {}),
      },
      makerPersonId: person.personId,
      requiredApprovals: 1,
      expiresAt: new Date(now.getTime() + deps.settings.approvalValidityDays * 86_400_000),
      activeKey,
    });
    await tx.userChangeProposal.update({ where: { id: proposalId }, data: { approvalRequestId: request.id } });
    await writeAudit(tx, corporateCtx, { action: "admin.user.proposed", targetType: "userChange", targetId: proposalId, reason: input.reason, changes: { kind, targetMembershipId: target?.id ?? null, ...(access ? { roles: access.roles.join(","), accounts: access.grants.length, hasLimits: access.limits !== null } : {}) } });
  });
}

async function writeAccess(tx: Tx, membership: { id: string; corporateId: string | null }, access: Access): Promise<void> {
  await tx.membership.update({
    where: { id: membership.id },
    data: { roles: access.roles, userPerItemLimitMinor: access.limits ? BigInt(access.limits.perItemMinor) : null, userDailyLimitMinor: access.limits ? BigInt(access.limits.dailyMinor) : null, limitCurrency: access.limits ? "LYD" : null, grantVersion: { increment: 1 }, version: { increment: 1 } },
  });
  // The whole set of account rights is replaced by exactly what was approved.
  await tx.accountGrant.deleteMany({ where: { membershipId: membership.id } });
  if (access.grants.length > 0) {
    await tx.accountGrant.createMany({ data: access.grants.map((grant) => ({ membershipId: membership.id, corporateId: membership.corporateId as string, accountId: grant.accountId, canRead: grant.read, canDebit: grant.debit, canApprove: grant.approve, canReport: grant.report })) });
  }
}

export const userChangeApprovalTarget = {
  checkVoter: async (tx: Tx, request: { id: string; targetId: string }, ctx: AuthContext, deps: Deps) => {
    const proposal = await tx.userChangeProposal.findUnique({ where: { id: request.targetId } });
    if (!proposal || proposal.status !== "PENDING_APPROVAL" || proposal.approvalRequestId !== request.id) throw conflict("This proposal is no longer awaiting a decision.");
    // The person whose access changes cannot approve the change.
    if (proposal.targetMembershipId && ctx.membershipId === proposal.targetMembershipId) throw denied();
    const payload = proposal.payload as unknown as Payload;
    if (payload.kind === "INVITE" && ctx.principal.kind === "person" && normalizeEmail(ctx.principal.email) === payload.email) throw denied();
    // The agreement may have changed since the proposal: check the bounds again now.
    if (payload.kind !== "REACTIVATE") await assertWithinBounds(deps, tx, proposal.corporateId, payload.access);
  },
  onApproved: async (tx: Tx, request: { targetId: string }, _ctx: AuthContext, deps: Deps) => {
    const proposal = await tx.userChangeProposal.findUniqueOrThrow({ where: { id: request.targetId } });
    const payload = proposal.payload as unknown as Payload;
    const now = deps.clock.now();
    if (payload.kind === "INVITE") {
      const token = randomToken(32);
      const expiresAt = new Date(now.getTime() + INVITATION_VALIDITY_DAYS * 86_400_000);
      await tx.invitation.create({ data: { bankId: proposal.bankId, corporateId: proposal.corporateId, email: payload.email, displayName: payload.displayName, tokenHash: tokenHash(token), userChangeProposalId: proposal.id, expiresAt, createdAt: now } });
      // Sandbox transport: nothing leaves the platform. Only the hash is kept with the invitation.
      await tx.localInboxMessage.create({ data: { toEmail: payload.email, kind: "invitation", body: JSON.stringify({ path: `/invite/${token}`, expiresAt: expiresAt.toISOString() }), createdAt: now } });
      await tx.userChangeProposal.update({ where: { id: proposal.id }, data: { status: "APPROVED" } });
    } else {
      const membership = await tx.membership.findUniqueOrThrow({ where: { id: proposal.targetMembershipId as string } });
      if (payload.kind === "REACTIVATE") {
        if (membership.status !== "SUSPENDED") throw conflict("This member is not suspended.");
        await tx.membership.update({ where: { id: membership.id }, data: { status: "ACTIVE", suspendedAt: null, version: { increment: 1 } } });
      } else {
        if (membership.roles.includes("CORPORATE_ADMIN") && !payload.access.roles.includes("CORPORATE_ADMIN")) await assertNotLastAdmin(tx, proposal.corporateId, membership.id);
        await writeAccess(tx, membership, payload.access);
      }
      await tx.userChangeProposal.update({ where: { id: proposal.id }, data: { status: "EFFECTIVE", appliedAt: now } });
    }
  },
  onRejected: async (tx: Tx, request: { targetId: string }) => {
    // The vote and its reason are recorded by the approval service.
    await tx.userChangeProposal.update({ where: { id: request.targetId }, data: { status: "REJECTED" } });
  },
  onExpired: async (tx: Tx, request: { id: string; targetId: string }) => {
    await tx.userChangeProposal.updateMany({ where: { id: request.targetId, status: "PENDING_APPROVAL", approvalRequestId: request.id }, data: { status: "WITHDRAWN" } });
  },
};

/** Immediate, audited removal of access. The person's sessions end now. */
export async function suspendUser(deps: Deps, ctx: AuthContext, membershipId: string, reason: string, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "admin.users.suspend");
  const person = requirePerson(corporateCtx);
  const personId = await inTx(deps.db, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "corporateId" = ${corporateCtx.corporateId}::uuid FOR UPDATE`;
    const target = await tx.membership.findFirst({ where: { id: membershipId, corporateId: corporateCtx.corporateId, kind: "CORPORATE" } });
    if (!target) throw notFound();
    if (target.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (target.personId === person.personId) throw new DomainError("PERMISSION_DENIED", { detail: "You cannot suspend yourself." });
    if (target.status !== "ACTIVE") throw conflict("This member is not active.");
    if (target.roles.includes("CORPORATE_ADMIN")) await assertNotLastAdmin(tx, corporateCtx.corporateId, target.id);
    await tx.membership.update({ where: { id: target.id }, data: { status: "SUSPENDED", suspendedAt: deps.clock.now(), version: { increment: 1 } } });
    await writeAudit(tx, corporateCtx, { action: "admin.user.suspended", targetType: "membership", targetId: target.id, reason, changes: { before: "ACTIVE", after: "SUSPENDED" } });
    return target.personId;
  });
  await revokeSessionsOf(deps, personId);
}

export async function getUser(deps: Deps, ctx: AuthContext, membershipId: string): Promise<UserView> {
  const user = (await listUsers(deps, ctx)).find((entry) => entry.membershipId === membershipId);
  if (!user) throw notFound();
  return user;
}

// ---------------------------------------------------------------------------------------------
// Invitations (public, token-authorized)
// ---------------------------------------------------------------------------------------------

async function findInvitation(db: DbOrTx, token: string, now: Date) {
  const invitation = await db.invitation.findUnique({ where: { tokenHash: tokenHash(token) } });
  // Unknown, used and expired tokens answer identically.
  if (!invitation || invitation.usedAt !== null || invitation.expiresAt.getTime() <= now.getTime()) throw notFound();
  return invitation;
}

export async function lookupInvitation(deps: Deps, token: string): Promise<{ email: string; displayName: string; corporate: { name: string; nameAr: string }; expiresAt: string; existingIdentity: boolean }> {
  const invitation = await findInvitation(deps.db, token, deps.clock.now());
  const corporate = await deps.db.corporate.findUniqueOrThrow({ where: { id: invitation.corporateId }, select: { legalName: true, legalNameAr: true } });
  const existing = await deps.db.person.findUnique({ where: { email: invitation.email }, select: { id: true } });
  return { email: invitation.email, displayName: invitation.displayName, corporate: { name: corporate.legalName, nameAr: corporate.legalNameAr }, expiresAt: invitation.expiresAt.toISOString(), existingIdentity: existing !== null };
}

/** Use an invitation exactly once: identity (if new), membership and the approved rights. */
export async function acceptInvitation(deps: Deps, rawInput: unknown, correlationId: string): Promise<{ email: string }> {
  const input = invitationAcceptSchema.parse(rawInput);
  const now = deps.clock.now();
  const passwordHash = await hashPassword(input.password);
  return inTx(
    deps.db,
    async (tx) => {
      const candidate = await findInvitation(tx, input.token, now);
      await tx.$queryRaw`SELECT "id" FROM "Invitation" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;
      const invitation = await findInvitation(tx, input.token, now);
      const proposal = await tx.userChangeProposal.findUniqueOrThrow({ where: { id: invitation.userChangeProposalId } });
      const payload = proposal.payload as unknown as Payload;
      if (payload.kind !== "INVITE" || proposal.status !== "APPROVED") throw notFound();
      // The rights are the ones a second person approved, checked against the agreement again.
      await assertWithinBounds(deps, tx, invitation.corporateId, payload.access);
      let person = await tx.person.findUnique({ where: { email: invitation.email } });
      if (!person) {
        person = await tx.person.create({ data: { email: invitation.email, name: invitation.displayName, emailVerified: true } });
        await tx.authAccount.create({ data: { userId: person.id, providerId: "credential", accountId: person.id, password: passwordHash } });
      }
      if (person.status !== "ACTIVE") throw notFound();
      const membership = await tx.membership.create({ data: { personId: person.id, bankId: invitation.bankId, corporateId: invitation.corporateId, kind: "CORPORATE", scopeKey: `C:${invitation.corporateId}`, roles: [], status: "ACTIVE" } });
      await writeAccess(tx, membership, payload.access);
      await tx.invitation.update({ where: { id: invitation.id }, data: { usedAt: now } });
      await tx.userChangeProposal.update({ where: { id: proposal.id }, data: { status: "EFFECTIVE", appliedAt: now, targetMembershipId: membership.id } });
      await tx.auditEvent.create({ data: { bankId: invitation.bankId, corporateId: invitation.corporateId, actorKind: "PERSON", actorPersonId: person.id, action: "admin.invitation.accepted", targetType: "membership", targetId: membership.id, correlationId, changes: { proposalId: proposal.id }, result: "SUCCESS" } });
      return { email: invitation.email };
    },
    { skipIdempotency: true },
  );
}

/** Sandbox-only local inbox: invitation links of THIS corporate, for its administrators. */
export async function listLocalInbox(deps: Deps, ctx: AuthContext): Promise<Array<{ id: string; toEmail: string; kind: string; path: string | null; expiresAt: string | null; used: boolean; createdAt: string }>> {
  const corporateCtx: CorporateContext = requireCorporate(ctx);
  requirePermission(corporateCtx, "admin.users.propose");
  const invitations = await deps.db.invitation.findMany({ where: { corporateId: corporateCtx.corporateId }, orderBy: { createdAt: "desc" }, take: 20 });
  if (invitations.length === 0) return [];
  const messages = await deps.db.localInboxMessage.findMany({ where: { kind: "invitation", toEmail: { in: invitations.map((invitation) => invitation.email) } }, orderBy: { createdAt: "desc" }, take: 50 });
  const now = deps.clock.now();
  return messages.flatMap((message) => {
    let body: { path?: string; expiresAt?: string } = {};
    try {
      body = JSON.parse(message.body) as typeof body;
    } catch {
      body = {};
    }
    const token = body.path?.split("/").pop() ?? "";
    const invitation = invitations.find((entry) => entry.email === message.toEmail && entry.tokenHash === tokenHash(token));
    // Another corporate's invitation to the same address is never shown here.
    if (!invitation) return [];
    const live = invitation.usedAt === null && invitation.expiresAt.getTime() > now.getTime();
    return [{ id: message.id, toEmail: message.toEmail, kind: message.kind, path: live ? (body.path ?? null) : null, expiresAt: body.expiresAt ?? null, used: invitation.usedAt !== null, createdAt: message.createdAt.toISOString() }];
  });
}
