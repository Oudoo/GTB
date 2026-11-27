/** Shared helpers for payment-centred integration tests (real dispatcher, real PostgreSQL). */
import { ACCOUNTS, CORPORATES, beneficiaryId, type DirectoryKey } from "@/server/seed/fixtures";
import type { ApiResult, World } from "./world";

export type PaymentData = {
  id: string;
  reference: string;
  state: string;
  version: number;
  revision: number;
  proposalHash: string | null;
  fee: { minor: string };
  totalDebit: { minor: string };
  failureCode: string | null;
  releaseBlockCode: string | null;
  executionReference: string | null;
  approval: { id: string; version: number; state: string; targetRevision: number; payloadHash: string; canAct: boolean; eligibility: string; approvalsCount: number; requiredApprovals: number } | null;
  timeline: Array<{ code: string; toState: string | null; reference: string | null }>;
};

export type PaymentOverrides = {
  minor?: string;
  beneficiary?: DirectoryKey;
  source?: keyof typeof ACCOUNTS;
  transactionType?: "INSTANT_ACCOUNT_CREDIT" | "ACH_CREDIT" | "OWN_ACCOUNT_TRANSFER";
  destination?: keyof typeof ACCOUNTS;
  reference?: string;
  executeAt?: string;
  extra?: Record<string, unknown>;
};

let sequence = 0;

/** A valid instant supplier payment from the document 07 fixture, with overridable parts. */
export function paymentBody(overrides: PaymentOverrides = {}): Record<string, unknown> {
  sequence += 1;
  const type = overrides.transactionType ?? "INSTANT_ACCOUNT_CREDIT";
  return {
    moduleId: type === "INSTANT_ACCOUNT_CREDIT" ? "1.1" : type === "ACH_CREDIT" ? "1.2" : "1.5",
    transactionType: type,
    sourceAccountId: ACCOUNTS[overrides.source ?? "A_OPERATING"].id,
    ...(type === "OWN_ACCOUNT_TRANSFER" ? { destinationAccountId: ACCOUNTS[overrides.destination ?? "A_SAVINGS"].id } : { beneficiaryId: beneficiaryId(overrides.beneficiary ?? "SUPPLIER") }),
    amount: { currency: "LYD", minor: overrides.minor ?? "125000" },
    purpose: "Synthetic test payment",
    clientReference: overrides.reference ?? `TEST-${process.pid}-${sequence}`,
    execution: overrides.executeAt ? { mode: "SCHEDULED", executeAt: overrides.executeAt } : { mode: "IMMEDIATE" },
    ...overrides.extra,
  };
}

export async function coreBalance(world: World, ref: string): Promise<bigint> {
  return (await world.db.simCoreAccount.findUniqueOrThrow({ where: { ref } })).bookedMinor;
}

/** Active holds on a core account, in minor units. */
export async function coreHolds(world: World, ref: string): Promise<bigint> {
  const holds = await world.db.simCoreHold.findMany({ where: { accountRef: ref, state: "ACTIVE" } });
  return holds.reduce((sum, hold) => sum + hold.amountMinor, 0n);
}

export async function usage(world: World, scopeKey = "CORPORATE", period: "DAY" | "MONTH" = "DAY", corporate: keyof typeof CORPORATES = "A"): Promise<{ consumed: bigint; reserved: bigint }> {
  const counters = await world.db.usageCounter.findMany({ where: { corporateId: CORPORATES[corporate].id, scopeKey, period }, orderBy: { windowStart: "desc" } });
  return { consumed: counters[0]?.consumedMinor ?? 0n, reserved: counters[0]?.reservedMinor ?? 0n };
}

/** Create and submit a payment as `maker`; returns the pending proposal. */
export async function submitPayment(world: World, overrides: PaymentOverrides = {}, makerKey = "aMaker"): Promise<PaymentData> {
  const maker = await world.as(makerKey);
  const created = await maker.post<PaymentData>("/payments", paymentBody(overrides));
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  const submitted = await maker.post<PaymentData>(`/payments/${created.data.id}/submit`, overrides.extra?.["acceptRolledExecution"] ? { acceptRolledExecution: true } : undefined, { ifMatch: created.data.version });
  if (submitted.status !== 202) throw new Error(`submit failed: ${submitted.status} ${submitted.text}`);
  return submitted.data;
}

/** Cast one approving vote on a proposal as `checkerKey`. */
export async function approve(world: World, approvalId: string, checkerKey = "aChecker1"): Promise<ApiResult> {
  const checker = await world.as(checkerKey);
  const approval = await checker.get<{ version: number; targetRevision: number; payloadHash: string }>(`/approvals/${approvalId}`);
  // A proposal the caller cannot even see: hand back that refusal.
  if (approval.status !== 200) return approval;
  return checker.post(`/approvals/${approvalId}/approve`, { proposalVersion: approval.data.targetRevision, proposalHash: approval.data.payloadHash }, { ifMatch: approval.data.version });
}

/** Maker submits, a different checker approves; the worker has NOT run yet. */
export async function payAndApprove(world: World, overrides: PaymentOverrides = {}, makerKey = "aMaker", checkerKey = "aChecker1"): Promise<PaymentData> {
  const submitted = await submitPayment(world, overrides, makerKey);
  const approved = await approve(world, (submitted.approval as NonNullable<PaymentData["approval"]>).id, checkerKey);
  if (approved.status !== 200) throw new Error(`approve failed: ${approved.status} ${approved.text}`);
  return getPayment(world, submitted.id, makerKey);
}

export async function getPayment(world: World, paymentId: string, actorKey = "aMaker"): Promise<PaymentData> {
  const actor = await world.as(actorKey);
  const response = await actor.get<PaymentData>(`/payments/${paymentId}`);
  if (response.status !== 200) throw new Error(`get failed: ${response.status} ${response.text}`);
  return response.data;
}
