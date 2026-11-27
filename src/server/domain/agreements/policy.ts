/**
 * Effective agreement and policy loading (AGR-01, LIM-01).
 *
 * "Effective" is DERIVED from time and status on every evaluation — it never depends on a
 * background job having flipped a flag. A version binds when the agreement is ACTIVE, the
 * version is APPROVED/EFFECTIVE and `effectiveFrom <= now < effectiveUntil` (end exclusive).
 */
import { agreementTermsSchema, type AgreementTerms } from "@/contracts/agreement";
import { DomainError } from "@/contracts/errors";
import { TYPE_MODULE, type TransactionTypeCode } from "@/contracts/modules";
import { dbDateToLocalDate, type CalendarSpec, type RailWindowSpec } from "@/server/calendar";
import type { DbOrTx } from "@/server/db/client";
import type { BandData, LimitRuleData, RailCeiling } from "@/server/policy/evaluate";

export type AgreementState = "ACTIVE" | "NO_AGREEMENT" | "DRAFT" | "SUSPENDED" | "CLOSED" | "NOT_YET_EFFECTIVE" | "EXPIRED";

export type ModuleEntitlementData = Readonly<{
  moduleId: string;
  allowedTypes: ReadonlySet<string>;
  debitAccountIds: ReadonlySet<string>;
  creditAccountIds: ReadonlySet<string>;
  currency: string;
  rowCap: number | null;
}>;

export type EffectivePolicy = Readonly<{
  agreementId: string;
  agreementVersionId: string;
  versionNo: number;
  segment: string;
  effectiveFrom: Date;
  effectiveUntil: Date;
  terms: AgreementTerms;
  termsHash: string;
  modules: ReadonlyMap<string, ModuleEntitlementData>;
  rules: readonly LimitRuleData[];
  /** transactionType → fixed fee per child. Absent = tariff not configured. */
  fees: ReadonlyMap<string, bigint>;
  /** transactionType → bank floor bands. */
  bankBands: ReadonlyMap<string, readonly BandData[]>;
}>;

export type AgreementStatusResult = { state: AgreementState; policy: EffectivePolicy | null; agreementId: string | null };

export async function loadAgreementStatus(db: DbOrTx, corporateId: string, at: Date): Promise<AgreementStatusResult> {
  const agreement = await db.agreement.findUnique({ where: { corporateId } });
  if (!agreement) return { state: "NO_AGREEMENT", policy: null, agreementId: null };
  if (agreement.status === "DRAFT") return { state: "DRAFT", policy: null, agreementId: agreement.id };
  if (agreement.status === "SUSPENDED") return { state: "SUSPENDED", policy: null, agreementId: agreement.id };
  if (agreement.status === "CLOSED") return { state: "CLOSED", policy: null, agreementId: agreement.id };

  const version = await db.agreementVersion.findFirst({
    where: {
      agreementId: agreement.id,
      status: { in: ["APPROVED", "EFFECTIVE"] },
      effectiveFrom: { lte: at },
      effectiveUntil: { gt: at },
    },
    include: {
      entitlements: { include: { accounts: true } },
      limitRules: true,
      feeRules: true,
      approvalRules: true,
    },
    orderBy: { versionNo: "desc" },
  });
  if (!version) {
    const future = await db.agreementVersion.count({
      where: { agreementId: agreement.id, status: { in: ["APPROVED", "EFFECTIVE"] }, effectiveFrom: { gt: at } },
    });
    return { state: future > 0 ? "NOT_YET_EFFECTIVE" : "EXPIRED", policy: null, agreementId: agreement.id };
  }

  const modules = new Map<string, ModuleEntitlementData>();
  for (const entitlement of version.entitlements) {
    modules.set(entitlement.moduleId, {
      moduleId: entitlement.moduleId,
      allowedTypes: new Set(entitlement.allowedTypes),
      debitAccountIds: new Set(entitlement.accounts.filter((a) => a.allowDebit).map((a) => a.accountId)),
      creditAccountIds: new Set(entitlement.accounts.filter((a) => a.allowCredit).map((a) => a.accountId)),
      currency: entitlement.currency,
      rowCap: entitlement.rowCap,
    });
  }
  const bankBands = new Map<string, BandData[]>();
  for (const rule of version.approvalRules) {
    const list = bankBands.get(rule.transactionType) ?? [];
    list.push({ minMinor: rule.minMinor, maxExclusiveMinor: rule.maxExclusiveMinor, checkerCount: rule.checkerCount });
    bankBands.set(rule.transactionType, list);
  }
  return {
    state: "ACTIVE",
    agreementId: agreement.id,
    policy: {
      agreementId: agreement.id,
      agreementVersionId: version.id,
      versionNo: version.versionNo,
      segment: version.segment,
      effectiveFrom: version.effectiveFrom,
      effectiveUntil: version.effectiveUntil,
      terms: agreementTermsSchema.parse(version.terms),
      termsHash: version.termsHash,
      modules,
      rules: version.limitRules.map((rule) => ({
        scope: rule.scope,
        moduleId: rule.moduleId,
        transactionType: rule.transactionType,
        metric: rule.metric,
        period: rule.period,
        currency: rule.currency,
        valueMinor: rule.valueMinor,
        itemCount: rule.itemCount,
        provenance: rule.provenance,
      })),
      fees: new Map(version.feeRules.map((fee) => [fee.transactionType as string, fee.fixedMinor])),
      bankBands,
    },
  };
}

/** No effective signed agreement → no operational mutation (AGR-01). */
export async function requireEffectivePolicy(db: DbOrTx, corporateId: string, at: Date): Promise<EffectivePolicy> {
  const status = await loadAgreementStatus(db, corporateId, at);
  if (!status.policy) {
    throw new DomainError("AGREEMENT_INACTIVE", { violations: [{ rule: "agreement.state", code: status.state }] });
  }
  return status.policy;
}

export type EntitlementCheck = {
  moduleId: string;
  transactionType?: TransactionTypeCode;
  debitAccountId?: string;
  creditAccountId?: string;
};

/** Module, transaction type and account must all be covered by the effective version. */
export function requireEntitlement(policy: EffectivePolicy, check: EntitlementCheck): ModuleEntitlementData {
  const entitlement = policy.modules.get(check.moduleId);
  if (!entitlement) throw new DomainError("MODULE_DISABLED", { violations: [{ rule: "module", code: check.moduleId }] });
  if (check.transactionType) {
    if (TYPE_MODULE[check.transactionType] !== check.moduleId || !entitlement.allowedTypes.has(check.transactionType)) {
      throw new DomainError("TRANSACTION_TYPE_DISABLED", { violations: [{ rule: "transactionType", code: check.transactionType }] });
    }
  }
  if (check.debitAccountId && !entitlement.debitAccountIds.has(check.debitAccountId)) {
    throw new DomainError("ACCOUNT_NOT_ALLOWED", { violations: [{ field: "sourceAccountId", rule: "agreement.debitAccount" }] });
  }
  if (check.creditAccountId && !entitlement.creditAccountIds.has(check.creditAccountId)) {
    throw new DomainError("ACCOUNT_NOT_ALLOWED", { violations: [{ field: "creditAccountId", rule: "agreement.creditAccount" }] });
  }
  return entitlement;
}

/** Corporate-proposed stronger bands currently in force, by transaction type. */
export async function loadCorporateBands(db: DbOrTx, corporateId: string): Promise<Map<string, BandData[]>> {
  const set = await db.corporateRuleSet.findFirst({
    where: { corporateId, status: "EFFECTIVE" },
    orderBy: { versionNo: "desc" },
  });
  const out = new Map<string, BandData[]>();
  if (!set) return out;
  const bands = set.bands as Array<{ transactionType: string; minMinor: string; maxExclusiveMinor: string | null; checkerCount: number }>;
  for (const band of bands) {
    const list = out.get(band.transactionType) ?? [];
    list.push({
      minMinor: BigInt(band.minMinor),
      maxExclusiveMinor: band.maxExclusiveMinor === null ? null : BigInt(band.maxExclusiveMinor),
      checkerCount: band.checkerCount,
    });
    out.set(band.transactionType, list);
  }
  return out;
}

export type RailPolicy = Readonly<{
  parameterId: string;
  versionNo: number;
  ceiling: RailCeiling;
  window: RailWindowSpec;
  calendar: CalendarSpec;
  settlementDelaySeconds: number;
}>;

/**
 * The bank's approved parameters for a rail at an instant, or null when none is in force.
 * A null result — like a null ceiling — makes rail execution fail closed (LIM-01).
 */
export async function loadRailPolicy(db: DbOrTx, bankId: string, rail: string, currency: string, at: Date): Promise<RailPolicy | null> {
  const parameter = await db.railParameter.findFirst({
    where: { bankId, rail: rail as never, currency, status: { in: ["APPROVED", "EFFECTIVE"] }, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: "desc" }, { versionNo: "desc" }],
  });
  if (!parameter) return null;
  const calendar = await db.bankCalendar.findUnique({ where: { id: parameter.calendarId }, include: { closedDays: true } });
  if (!calendar) return null;
  return {
    parameterId: parameter.id,
    versionNo: parameter.versionNo,
    ceiling: { perItemMinor: parameter.perItemMinor, provenance: parameter.provenance },
    window: {
      openLocalTime: parameter.openLocalTime,
      cutoffLocalTime: parameter.cutoffLocalTime,
      observesClosedDays: parameter.observesClosedDays,
      offlineStartLocalTime: parameter.offlineStartLocalTime,
      offlineEndLocalTime: parameter.offlineEndLocalTime,
    },
    calendar: {
      timeZone: calendar.timezone,
      weekendDays: calendar.weekendDays,
      closedDates: new Set(calendar.closedDays.map((day) => dbDateToLocalDate(day.date))),
    },
    settlementDelaySeconds: parameter.settlementDelaySeconds,
  };
}
