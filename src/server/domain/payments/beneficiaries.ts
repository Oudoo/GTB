/**
 * Beneficiary registry and synthetic name enquiry (PAY-01).
 *
 * The sandbox account format (`DEMO_DOMESTIC` / `DEMO-LY-000000`) is documented fixture
 * format, not an IBAN and not a CBL standard. Creating a beneficiary authorizes nothing:
 * every payment is still checked and approved. Edits never rewrite a payment's snapshot.
 */
import { maskAccountReference } from "@/contracts/common";
import { DomainError, conflict, notFound } from "@/contracts/errors";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { writeAudit } from "@/server/audit/audit";
import { hasPermission, requireCorporate, requirePermission, type AuthContext } from "@/server/auth/context";
import { inTx, isUniqueViolation } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { requireEffectivePolicy } from "@/server/domain/agreements/policy";
import type { Beneficiary } from "@/generated/prisma/client";

export type NameEnquiryResult = {
  status: "MATCHED" | "CLOSE_MATCH" | "MISMATCH" | "NOT_FOUND";
  enteredName: string;
  /** Returned only for a match or close match; a mismatch discloses nothing. */
  returnedName: string | null;
  bankName: string | null;
  maskedReference: string;
  checkedAt: string;
};

const STATUS_MAP = { MATCH: "MATCHED", CLOSE_MATCH: "CLOSE_MATCH", MISMATCH: "MISMATCH", NOT_FOUND: "NOT_FOUND" } as const;

/**
 * Canonical account-name check through the core port. "Check failed" (adapter unavailable)
 * is a distinct error from "name mismatch" and never creates or changes anything.
 */
export async function nameEnquiry(
  deps: Deps,
  ctx: AuthContext,
  input: { scheme: string; accountReference: string; name: string },
): Promise<NameEnquiryResult> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "beneficiaries.manage");
  try {
    const match = await deps.core.validateBeneficiary(
      { bankCode: corporateCtx.bankCode, correlationId: corporateCtx.correlationId },
      { scheme: input.scheme, reference: input.accountReference, name: input.name },
    );
    return {
      status: STATUS_MAP[match.status],
      enteredName: input.name,
      returnedName: match.returnedName ?? null,
      bankName: match.bankName ?? null,
      maskedReference: maskAccountReference(input.accountReference),
      checkedAt: deps.clock.now().toISOString(),
    };
  } catch (error) {
    if (error instanceof CoreUnavailableError) throw new DomainError("NAME_CHECK_UNAVAILABLE");
    throw error;
  }
}

export type BeneficiaryView = {
  id: string;
  displayName: string;
  scheme: string;
  maskedReference: string;
  /** Full reference is shown only to roles that manage beneficiaries. */
  accountReference: string | null;
  bankName: string | null;
  matchStatus: Beneficiary["matchStatus"];
  matchedName: string | null;
  matchCheckedAt: string | null;
  closeMatchAcknowledged: boolean;
  archived: boolean;
  version: number;
  createdAt: string;
};

function view(ctx: AuthContext, row: Beneficiary): BeneficiaryView {
  return {
    id: row.id,
    displayName: row.displayName,
    scheme: row.scheme,
    maskedReference: maskAccountReference(row.accountReference),
    accountReference: hasPermission(ctx, "beneficiaries.manage") ? row.accountReference : null,
    bankName: row.bankName,
    matchStatus: row.matchStatus,
    matchedName: row.matchedName,
    matchCheckedAt: row.matchCheckedAt?.toISOString() ?? null,
    closeMatchAcknowledged: row.closeMatchAcknowledged,
    archived: row.archivedAt !== null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listBeneficiaries(
  deps: Deps,
  ctx: AuthContext,
  filter: { includeArchived?: boolean; search?: string; cursor?: string; limit?: number } = {},
): Promise<{ items: BeneficiaryView[]; nextCursor: string | null }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "beneficiaries.read");
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const rows = await deps.db.beneficiary.findMany({
    where: {
      corporateId: corporateCtx.corporateId,
      ...(filter.includeArchived ? {} : { archivedAt: null }),
      ...(filter.search ? { displayName: { contains: filter.search, mode: "insensitive" as const } } : {}),
    },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => view(corporateCtx, row)),
    nextCursor: rows.length > limit ? (page[page.length - 1] as Beneficiary).id : null,
  };
}

export async function getBeneficiary(deps: Deps, ctx: AuthContext, id: string): Promise<BeneficiaryView> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "beneficiaries.read");
  const row = await deps.db.beneficiary.findFirst({ where: { id, corporateId: corporateCtx.corporateId } });
  if (!row) throw notFound();
  return view(corporateCtx, row);
}

export async function createBeneficiary(
  deps: Deps,
  ctx: AuthContext,
  input: { displayName: string; scheme: string; accountReference: string; acknowledgeCloseMatch?: boolean | undefined },
  id: string,
): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "beneficiaries.manage");
  // Beneficiaries belong to the payment modules: writes need an effective agreement.
  await requireEffectivePolicy(deps.db, corporateCtx.corporateId, deps.clock.now());
  const check = await nameEnquiry(deps, corporateCtx, { scheme: input.scheme, accountReference: input.accountReference, name: input.displayName });
  const acknowledged = check.status === "CLOSE_MATCH" && input.acknowledgeCloseMatch === true;
  try {
    await inTx(deps.db, async (tx) => {
      await tx.beneficiary.create({
        data: {
          id,
          bankId: corporateCtx.bankId,
          corporateId: corporateCtx.corporateId,
          displayName: input.displayName,
          scheme: input.scheme,
          accountReference: input.accountReference,
          bankName: check.bankName,
          matchStatus: check.status,
          matchedName: check.returnedName,
          matchCheckedAt: deps.clock.now(),
          closeMatchAcknowledged: acknowledged,
          activeKey: `${corporateCtx.corporateId}:${input.scheme}:${input.accountReference}`,
          createdByPersonId: corporateCtx.principal.kind === "person" ? corporateCtx.principal.personId : await credentialOwner(tx, corporateCtx),
        },
      });
      await writeAudit(tx, corporateCtx, {
        action: "beneficiary.created",
        targetType: "beneficiary",
        targetId: id,
        changes: { matchStatus: check.status, maskedReference: check.maskedReference, closeMatchAcknowledged: acknowledged },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("DUPLICATE_RESOURCE", { detail: "A beneficiary with this account already exists." });
    throw error;
  }
}

async function credentialOwner(tx: Parameters<Parameters<typeof inTx>[1]>[0], ctx: AuthContext): Promise<string> {
  if (ctx.principal.kind !== "credential") throw new DomainError("PERMISSION_DENIED");
  const credential = await tx.apiCredential.findUniqueOrThrow({ where: { id: ctx.principal.credentialId }, select: { createdByPersonId: true } });
  return credential.createdByPersonId;
}

/** Update master data and re-run the name check. Past payments keep their own snapshot. */
export async function updateBeneficiary(
  deps: Deps,
  ctx: AuthContext,
  id: string,
  input: { displayName: string; acknowledgeCloseMatch?: boolean | undefined },
  expectedVersion: number,
): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "beneficiaries.manage");
  const existing = await deps.db.beneficiary.findFirst({ where: { id, corporateId: corporateCtx.corporateId } });
  if (!existing) throw notFound();
  if (existing.archivedAt) throw conflict("An archived beneficiary cannot be changed.");
  const check = await nameEnquiry(deps, corporateCtx, { scheme: existing.scheme, accountReference: existing.accountReference, name: input.displayName });
  await inTx(deps.db, async (tx) => {
    const updated = await tx.beneficiary.updateMany({
      where: { id, corporateId: corporateCtx.corporateId, version: expectedVersion, archivedAt: null },
      data: {
        displayName: input.displayName,
        matchStatus: check.status,
        matchedName: check.returnedName,
        bankName: check.bankName,
        matchCheckedAt: deps.clock.now(),
        closeMatchAcknowledged: check.status === "CLOSE_MATCH" && input.acknowledgeCloseMatch === true,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new DomainError("VERSION_CONFLICT");
    await writeAudit(tx, corporateCtx, {
      action: "beneficiary.updated",
      targetType: "beneficiary",
      targetId: id,
      changes: { before: { matchStatus: existing.matchStatus }, after: { matchStatus: check.status } },
    });
  });
}

/** Soft archive: history and payment snapshots are untouched; the account can be re-added. */
export async function archiveBeneficiary(deps: Deps, ctx: AuthContext, id: string, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "beneficiaries.manage");
  await inTx(deps.db, async (tx) => {
    const existing = await tx.beneficiary.findFirst({ where: { id, corporateId: corporateCtx.corporateId } });
    if (!existing) throw notFound();
    if (existing.archivedAt) return;
    const updated = await tx.beneficiary.updateMany({
      where: { id, version: expectedVersion, archivedAt: null },
      data: { archivedAt: deps.clock.now(), activeKey: null, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new DomainError("VERSION_CONFLICT");
    await writeAudit(tx, corporateCtx, { action: "beneficiary.archived", targetType: "beneficiary", targetId: id });
  });
}
