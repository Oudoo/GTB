/**
 * Bank-governed rail parameters (LIM-01, GOV-003): per-item ceilings with provenance, cut-off
 * times and calendars. All values are configurable sandbox parameters — none is a confirmed
 * CBL figure — and every change goes through bank maker-checker approval. A NULL ceiling is
 * a legitimate "not configured yet" state that makes the rail fail closed.
 */
import { z } from "zod";
import { minorStringSchema, provenanceSchema } from "@/contracts/agreement";
import { reasonSchema } from "@/contracts/common";
import { DomainError, notFound } from "@/contracts/errors";
import { minorToJson, type MoneyJson } from "@/contracts/money";
import { writeAudit } from "@/server/audit/audit";
import { requireBank, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { dbDateToLocalDate } from "@/server/calendar";
import { inTx } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import { createApprovalRequest, registerApprovalTarget } from "@/server/domain/approvals/service";
import { digestOf } from "@/server/hash";

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const railParameterProposalSchema = z
  .strictObject({
    rail: z.enum(["LYPAY", "ACH", "INTERNAL", "BRANCH"]),
    currency: z.literal("LYD"),
    /** NULL = ceiling not configured: the rail is blocked until one is approved. */
    perItemMinor: minorStringSchema.nullable(),
    provenance: provenanceSchema,
    calendarId: z.uuid(),
    openLocalTime: localTime.nullable(),
    cutoffLocalTime: localTime.nullable(),
    observesClosedDays: z.boolean(),
    offlineStartLocalTime: localTime.nullable(),
    offlineEndLocalTime: localTime.nullable(),
    settlementDelaySeconds: z.int().min(0).max(86_400),
    effectiveFrom: z.iso.datetime({ offset: true }),
    changeReason: reasonSchema,
  })
  .refine((value) => (value.offlineStartLocalTime === null) === (value.offlineEndLocalTime === null), {
    message: "set both offline times or neither",
    path: ["offlineEndLocalTime"],
  })
  .refine((value) => !(value.openLocalTime && value.cutoffLocalTime) || value.openLocalTime < value.cutoffLocalTime, {
    message: "the cut-off must be after the opening time",
    path: ["cutoffLocalTime"],
  });

export type RailParameterView = {
  id: string;
  rail: string;
  currency: string;
  versionNo: number;
  status: string;
  ceiling: MoneyJson | null;
  provenance: string;
  calendarId: string;
  openLocalTime: string | null;
  cutoffLocalTime: string | null;
  observesClosedDays: boolean;
  offlineStartLocalTime: string | null;
  offlineEndLocalTime: string | null;
  settlementDelaySeconds: number;
  effectiveFrom: string;
  changeReason: string;
  proposedBy: string;
  approvalRequestId: string | null;
  /** True for the row currently in force for its rail. */
  current: boolean;
  createdAt: string;
};

export async function listRailParameters(deps: Deps, ctx: AuthContext): Promise<{
  parameters: RailParameterView[];
  calendars: Array<{ id: string; code: string; name: string; timezone: string; weekendDays: number[]; closedDays: Array<{ date: string; label: string }>; provenance: string }>;
}> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.rail.read");
  const now = deps.clock.now();
  const rows = await deps.db.railParameter.findMany({ where: { bankId: bankCtx.bankId }, orderBy: [{ rail: "asc" }, { versionNo: "desc" }] });
  const people = await deps.db.person.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.proposedByPersonId))] } }, select: { id: true, name: true } });
  const names = new Map(people.map((person) => [person.id, person.name]));
  const current = new Set<string>();
  for (const rail of ["LYPAY", "ACH", "INTERNAL", "BRANCH"]) {
    const inForce = rows
      .filter((row) => row.rail === rail && (row.status === "APPROVED" || row.status === "EFFECTIVE") && row.effectiveFrom.getTime() <= now.getTime())
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.versionNo - a.versionNo)[0];
    if (inForce) current.add(inForce.id);
  }
  const calendars = await deps.db.bankCalendar.findMany({ where: { bankId: bankCtx.bankId }, include: { closedDays: { orderBy: { date: "asc" } } } });
  return {
    parameters: rows.map((row) => ({
      id: row.id,
      rail: row.rail,
      currency: row.currency,
      versionNo: row.versionNo,
      status: row.status,
      ceiling: row.perItemMinor === null ? null : minorToJson(row.perItemMinor, row.currency),
      provenance: row.provenance,
      calendarId: row.calendarId,
      openLocalTime: row.openLocalTime,
      cutoffLocalTime: row.cutoffLocalTime,
      observesClosedDays: row.observesClosedDays,
      offlineStartLocalTime: row.offlineStartLocalTime,
      offlineEndLocalTime: row.offlineEndLocalTime,
      settlementDelaySeconds: row.settlementDelaySeconds,
      effectiveFrom: row.effectiveFrom.toISOString(),
      changeReason: row.changeReason,
      proposedBy: names.get(row.proposedByPersonId) ?? "",
      approvalRequestId: row.approvalRequestId,
      current: current.has(row.id),
      createdAt: row.createdAt.toISOString(),
    })),
    calendars: calendars.map((calendar) => ({
      id: calendar.id,
      code: calendar.code,
      name: calendar.name,
      timezone: calendar.timezone,
      weekendDays: calendar.weekendDays,
      closedDays: calendar.closedDays.map((day) => ({ date: dbDateToLocalDate(day.date), label: day.label })),
      provenance: calendar.provenance,
    })),
  };
}

export async function proposeRailParameter(deps: Deps, ctx: AuthContext, rawInput: unknown, id: string): Promise<void> {
  const bankCtx = requireBank(ctx);
  requirePermission(bankCtx, "bank.rail.propose");
  const person = requirePerson(bankCtx);
  const input = railParameterProposalSchema.parse(rawInput);
  const calendar = await deps.db.bankCalendar.findFirst({ where: { id: input.calendarId, bankId: bankCtx.bankId } });
  if (!calendar) throw notFound();
  const payloadHash = digestOf(input);
  await inTx(deps.db, async (tx) => {
    const last = await tx.railParameter.findFirst({
      where: { bankId: bankCtx.bankId, rail: input.rail, currency: input.currency },
      orderBy: { versionNo: "desc" },
    });
    const versionNo = (last?.versionNo ?? 0) + 1;
    const request = await createApprovalRequest(tx, {
      bankId: bankCtx.bankId,
      corporateId: null,
      klass: "BANK_GOVERNANCE",
      targetType: "railParameter",
      targetId: id,
      targetRevision: versionNo,
      payloadHash,
      summary: {
        kind: "RAIL_PARAMETER",
        rail: input.rail,
        ceiling: input.perItemMinor === null ? null : { currency: input.currency, minor: input.perItemMinor },
        previousCeiling: last?.perItemMinor != null ? { currency: last.currency, minor: last.perItemMinor.toString() } : null,
        provenance: input.provenance,
        cutoffLocalTime: input.cutoffLocalTime,
        effectiveFrom: input.effectiveFrom,
        changeReason: input.changeReason,
      },
      makerPersonId: person.personId,
      requiredApprovals: 1,
      activeKey: `rail:${bankCtx.bankId}:${input.rail}:${input.currency}`,
    });
    await tx.railParameter.create({
      data: {
        id,
        bankId: bankCtx.bankId,
        rail: input.rail,
        currency: input.currency,
        versionNo,
        status: "PENDING_APPROVAL",
        perItemMinor: input.perItemMinor === null ? null : BigInt(input.perItemMinor),
        provenance: input.provenance,
        calendarId: input.calendarId,
        openLocalTime: input.openLocalTime,
        cutoffLocalTime: input.cutoffLocalTime,
        observesClosedDays: input.observesClosedDays,
        offlineStartLocalTime: input.offlineStartLocalTime,
        offlineEndLocalTime: input.offlineEndLocalTime,
        settlementDelaySeconds: input.settlementDelaySeconds,
        effectiveFrom: new Date(input.effectiveFrom),
        changeReason: input.changeReason,
        payloadHash,
        proposedByPersonId: person.personId,
        approvalRequestId: request.id,
      },
    });
    await writeAudit(tx, bankCtx, {
      action: "rail.parameter.proposed",
      targetType: "railParameter",
      targetId: id,
      reason: input.changeReason,
      proposalRevision: versionNo,
      changes: { rail: input.rail, perItemMinor: input.perItemMinor, provenance: input.provenance, cutoffLocalTime: input.cutoffLocalTime },
    });
  });
}

registerApprovalTarget("railParameter", {
  onApproved: async (tx, request, ctx) => {
    const person = requirePerson(ctx);
    const parameter = await tx.railParameter.findUniqueOrThrow({ where: { id: request.targetId } });
    if (parameter.status !== "PENDING_APPROVAL") throw new DomainError("STATE_CONFLICT");
    await tx.railParameter.update({ where: { id: parameter.id }, data: { status: "APPROVED", approvedByPersonId: person.personId } });
    await writeAudit(tx, ctx, {
      action: "rail.parameter.approved",
      targetType: "railParameter",
      targetId: parameter.id,
      proposalRevision: parameter.versionNo,
      changes: { rail: parameter.rail, perItemMinor: parameter.perItemMinor, effectiveFrom: parameter.effectiveFrom.toISOString() },
    });
  },
  onRejected: async (tx, request, ctx, _deps, reason) => {
    await tx.railParameter.update({ where: { id: request.targetId }, data: { status: "REJECTED" } });
    await writeAudit(tx, ctx, { action: "rail.parameter.rejected", targetType: "railParameter", targetId: request.targetId, reason });
  },
});
