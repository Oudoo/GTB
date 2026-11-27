/**
 * Agreement terms contract (AGR-01, LIM-01, LIM-04, ADM-02; document 04 DTO appendix).
 * These Zod schemas are shared by the bank console form, the API and the domain service.
 * Unknown fields are rejected everywhere.
 */
import { z } from "zod";
import { MODULE_REGISTRY, TRANSACTION_TYPES, getModule, isDeliveredInR1, type TransactionTypeCode } from "./modules";

export const minorStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/, "must be a string of digits (minor units)")
  .refine((value) => BigInt(value) <= 1_000_000_000_000_000n, "amount out of range");

export const transactionTypeSchema = z.enum(TRANSACTION_TYPES as [TransactionTypeCode, ...TransactionTypeCode[]]);
export const provenanceSchema = z.enum(["DEMO_UNCONFIRMED", "BANK_CONFIRMED"]);
export const segmentSchema = z.enum(["LARGE", "MEDIUM", "SMALL"]);
const lyd = z.literal("LYD");

/**
 * A rule carries EITHER an amount OR an item count, never both (document 04). R1 executes
 * amount limits (per item / day / month) and per-batch item limits only; any other basis is
 * rejected by the schema instead of being silently ignored (LIM-01).
 */
export const amountLimitSchema = z.strictObject({
  scope: z.enum(["TYPE", "MODULE"]),
  transactionType: transactionTypeSchema.optional(),
  metric: z.literal("AMOUNT"),
  period: z.enum(["ITEM", "DAY", "MONTH"]),
  currency: lyd,
  minor: minorStringSchema,
  provenance: provenanceSchema.default("DEMO_UNCONFIRMED"),
});

export const itemLimitSchema = z.strictObject({
  scope: z.enum(["TYPE", "MODULE"]),
  transactionType: transactionTypeSchema.optional(),
  metric: z.literal("ITEMS"),
  period: z.literal("BATCH"),
  count: z.int().min(1).max(1000),
  provenance: provenanceSchema.default("DEMO_UNCONFIRMED"),
});

export const moduleLimitSchema = z.discriminatedUnion("metric", [amountLimitSchema, itemLimitSchema]);

export const feeRuleSchema = z.strictObject({
  transactionType: transactionTypeSchema,
  currency: lyd,
  /** Fixed fee per child transfer. "0" is an explicit zero tariff. */
  minor: minorStringSchema,
});

export const approvalBandSchema = z.strictObject({
  transactionType: transactionTypeSchema,
  currency: lyd,
  /** Inclusive. */
  minMinor: minorStringSchema,
  /** Exclusive. `null` is an explicit unbounded top band. */
  maxExclusiveMinor: minorStringSchema.nullable(),
  checkerCount: z.int().min(1).max(5),
});

export const moduleTermsSchema = z.strictObject({
  moduleId: z.string().regex(/^\d{1,2}\.\d$/),
  transactionTypes: z.array(transactionTypeSchema).max(8),
  currency: lyd,
  debitAccountIds: z.array(z.uuid()).max(50),
  creditAccountIds: z.array(z.uuid()).max(50),
  limits: z.array(moduleLimitSchema).max(40),
  feeRules: z.array(feeRuleSchema).max(8),
  approvalBands: z.array(approvalBandSchema).max(40),
  rowCap: z.int().min(1).max(1000).optional(),
});

export const corporateLimitSchema = z.strictObject({
  metric: z.literal("AMOUNT"),
  period: z.enum(["DAY", "MONTH"]),
  currency: lyd,
  minor: minorStringSchema,
  provenance: provenanceSchema.default("DEMO_UNCONFIRMED"),
});

export const signatureEvidenceSchema = z.strictObject({
  signerReference: z.string().trim().min(2).max(120),
  evidenceReference: z.string().trim().min(2).max(120),
  evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 hex digest"),
  acceptedAt: z.iso.datetime({ offset: true }),
  /** No real e-signature service exists in R1; evidence is always a simulated attestation. */
  simulated: z.literal(true),
});

export const agreementTermsSchema = z.strictObject({
  segment: segmentSchema,
  linkedAccounts: z.array(z.uuid()).min(1).max(50),
  moduleTerms: z.array(moduleTermsSchema).min(1).max(33),
  corporateLimits: z.array(corporateLimitSchema).max(2),
  /** Bounds the corporate admin must stay inside when proposing user limits (ADM-01). */
  userLimitEnvelope: z.strictObject({ perItemMinor: minorStringSchema, dailyMinor: minorStringSchema }),
  /** Branch deposit controls for module 3.2 (COL-02). */
  depositPolicy: z
    .strictObject({
      perDepositCapMinor: minorStringSchema,
      managerThresholdMinor: minorStringSchema,
      cashReviewThresholdMinor: minorStringSchema,
    })
    .optional(),
  /** Sandbox API call plan (demo metadata, not a production rate). */
  apiPlan: z.strictObject({ perMinute: z.int().min(1).max(6000), perDay: z.int().min(1).max(1_000_000) }).optional(),
});

export type AgreementTerms = z.infer<typeof agreementTermsSchema>;
export type ModuleTerms = z.infer<typeof moduleTermsSchema>;
export type ApprovalBand = z.infer<typeof approvalBandSchema>;
export type ModuleLimit = z.infer<typeof moduleLimitSchema>;

export const agreementProposalSchema = z.strictObject({
  effectiveFrom: z.iso.datetime({ offset: true }),
  effectiveUntil: z.iso.datetime({ offset: true }),
  signatureEvidence: z.array(signatureEvidenceSchema).min(1).max(10),
  terms: agreementTermsSchema,
  changeReason: z.string().trim().min(3).max(500),
});

export type AgreementProposal = z.infer<typeof agreementProposalSchema>;

export type TermsIssue = { path: string; code: string; message: string };

type BandLike = { minMinor: string; maxExclusiveMinor: string | null; checkerCount: number };

/**
 * Bands must start at zero and be contiguous: inclusive minimum, exclusive maximum, no gap and
 * no overlap, so an exact boundary amount matches exactly one band (ADM-02).
 */
export function validateBands(bands: readonly BandLike[]): string | null {
  if (bands.length === 0) return "at least one approval band is required";
  const sorted = [...bands].sort((a, b) => (BigInt(a.minMinor) < BigInt(b.minMinor) ? -1 : 1));
  if (BigInt((sorted[0] as BandLike).minMinor) !== 0n) return "the first band must start at 0";
  for (let i = 0; i < sorted.length; i += 1) {
    const band = sorted[i] as BandLike;
    const next = sorted[i + 1];
    if (band.checkerCount < 1) return "every band needs at least one independent checker";
    if (band.maxExclusiveMinor !== null && BigInt(band.maxExclusiveMinor) <= BigInt(band.minMinor)) {
      return "a band maximum must be greater than its minimum";
    }
    if (next) {
      if (band.maxExclusiveMinor === null) return "only the last band may be unbounded";
      if (BigInt(band.maxExclusiveMinor) !== BigInt(next.minMinor)) return "bands must be contiguous without gaps or overlaps";
    }
  }
  return null;
}

/** Transaction types that move money out and therefore need a fee tariff and approval bands. */
const NEEDS_FEE_AND_BANDS: ReadonlySet<TransactionTypeCode> = new Set([
  "INSTANT_ACCOUNT_CREDIT",
  "ACH_CREDIT",
  "OWN_ACCOUNT_TRANSFER",
  "BULK_CREDIT",
  "PAYROLL_SALARY",
  "PAYROLL_ALLOWANCE",
]);

/**
 * Structural and policy validation of proposed terms against the module registry and the
 * corporate's own accounts. Returns every issue; an empty list means the terms are complete
 * enough to be signed and activated (AGR-01..03).
 */
export function validateAgreementTerms(terms: AgreementTerms, corporateAccountIds: ReadonlySet<string>): TermsIssue[] {
  const issues: TermsIssue[] = [];
  const push = (path: string, code: string, message: string) => issues.push({ path, code, message });

  const linked = new Set(terms.linkedAccounts);
  if (linked.size !== terms.linkedAccounts.length) push("linkedAccounts", "DUPLICATE", "linked accounts must be unique");
  for (const accountId of linked) {
    if (!corporateAccountIds.has(accountId)) push("linkedAccounts", "ACCOUNT_NOT_ALLOWED", "account does not belong to this corporate");
  }

  const seenModules = new Set<string>();
  terms.moduleTerms.forEach((moduleTerms, index) => {
    const base = `moduleTerms.${index}`;
    const definition = getModule(moduleTerms.moduleId);
    if (!definition) {
      push(`${base}.moduleId`, "MODULE_UNKNOWN", "module is not in the catalogue");
      return;
    }
    if (seenModules.has(definition.catalogueId)) push(`${base}.moduleId`, "DUPLICATE", "module listed more than once");
    seenModules.add(definition.catalogueId);
    if (!isDeliveredInR1(definition)) {
      // A crafted request can never switch on a deferred module (AGR-03).
      push(`${base}.moduleId`, "MODULE_UNAVAILABLE", `module ${definition.catalogueId} is not available in this release`);
      return;
    }
    const allowed = new Set<string>(definition.r1TransactionTypes);
    const enabledTypes = new Set<string>();
    for (const type of moduleTerms.transactionTypes) {
      if (!allowed.has(type)) push(`${base}.transactionTypes`, "TRANSACTION_TYPE_DISABLED", `${type} is not available for module ${definition.catalogueId}`);
      if (enabledTypes.has(type)) push(`${base}.transactionTypes`, "DUPLICATE", `${type} listed more than once`);
      enabledTypes.add(type);
    }
    if (definition.r1TransactionTypes.length > 0 && moduleTerms.transactionTypes.length === 0) {
      push(`${base}.transactionTypes`, "REQUIRED", "enable at least one transaction type or remove the module");
    }
    for (const [field, ids] of [
      ["debitAccountIds", moduleTerms.debitAccountIds],
      ["creditAccountIds", moduleTerms.creditAccountIds],
    ] as const) {
      for (const accountId of ids) {
        if (!linked.has(accountId)) push(`${base}.${field}`, "ACCOUNT_NOT_ALLOWED", "account is not a linked account of this agreement");
      }
    }

    const outgoing = moduleTerms.transactionTypes.filter((type) => NEEDS_FEE_AND_BANDS.has(type));
    if (outgoing.length > 0 && moduleTerms.debitAccountIds.length === 0) {
      push(`${base}.debitAccountIds`, "REQUIRED", "at least one debit account is required");
    }
    if (definition.catalogueId === "3.2" && moduleTerms.creditAccountIds.length === 0) {
      push(`${base}.creditAccountIds`, "REQUIRED", "at least one credit account is required for deposits");
    }

    const feeTypes = new Set<string>();
    for (const fee of moduleTerms.feeRules) {
      if (!enabledTypes.has(fee.transactionType)) push(`${base}.feeRules`, "TRANSACTION_TYPE_DISABLED", `${fee.transactionType} is not enabled`);
      if (feeTypes.has(fee.transactionType)) push(`${base}.feeRules`, "DUPLICATE", `more than one fee rule for ${fee.transactionType}`);
      feeTypes.add(fee.transactionType);
    }
    for (const type of outgoing) {
      // A missing tariff is "not configured", which is different from an explicit zero (LIM-04).
      if (!feeTypes.has(type)) push(`${base}.feeRules`, "REQUIRED", `a fee rule (possibly zero) is required for ${type}`);
      const bands = moduleTerms.approvalBands.filter((band) => band.transactionType === type);
      const problem = validateBands(bands);
      if (problem) push(`${base}.approvalBands`, "INVALID_BANDS", `${type}: ${problem}`);
    }
    for (const band of moduleTerms.approvalBands) {
      if (!enabledTypes.has(band.transactionType)) push(`${base}.approvalBands`, "TRANSACTION_TYPE_DISABLED", `${band.transactionType} is not enabled`);
    }

    const limitKeys = new Set<string>();
    moduleTerms.limits.forEach((limit, limitIndex) => {
      const path = `${base}.limits.${limitIndex}`;
      if (limit.scope === "TYPE") {
        if (!limit.transactionType) push(path, "REQUIRED", "a TYPE limit needs a transaction type");
        else if (!enabledTypes.has(limit.transactionType)) push(path, "TRANSACTION_TYPE_DISABLED", `${limit.transactionType} is not enabled`);
      } else if (limit.transactionType) {
        push(path, "INVALID", "a MODULE limit must not name a transaction type");
      }
      const key = `${limit.scope}|${limit.transactionType ?? ""}|${limit.metric}|${limit.period}`;
      if (limitKeys.has(key)) push(path, "DUPLICATE", "duplicate limit rule");
      limitKeys.add(key);
    });
    if ((definition.catalogueId === "2.1" || definition.catalogueId === "2.2") && !moduleTerms.rowCap) {
      push(`${base}.rowCap`, "REQUIRED", "a row cap is required for batch modules");
    }
  });

  const periods = new Set<string>();
  for (const limit of terms.corporateLimits) {
    if (periods.has(limit.period)) push("corporateLimits", "DUPLICATE", `more than one corporate ${limit.period} limit`);
    periods.add(limit.period);
  }
  if (BigInt(terms.userLimitEnvelope.perItemMinor) > BigInt(terms.userLimitEnvelope.dailyMinor)) {
    push("userLimitEnvelope", "INVALID", "the per-item user bound cannot exceed the daily user bound");
  }
  const corporateDay = terms.corporateLimits.find((limit) => limit.period === "DAY");
  if (corporateDay && BigInt(terms.userLimitEnvelope.dailyMinor) > BigInt(corporateDay.minor)) {
    // A user limit may never be above the corporate limit (catalogue p.4).
    push("userLimitEnvelope.dailyMinor", "INVALID", "the daily user bound cannot exceed the corporate daily limit");
  }
  if (seenModules.has("3.2") && !terms.depositPolicy) {
    push("depositPolicy", "REQUIRED", "deposit policy is required when branch deposits are enabled");
  }
  return issues;
}

export const R1_ENABLEABLE_MODULES = MODULE_REGISTRY.filter(isDeliveredInR1).map((definition) => definition.catalogueId);
