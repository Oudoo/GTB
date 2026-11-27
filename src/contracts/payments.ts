/** Single-payment and beneficiary wire contracts (PAY-01..03, document 04). */
import { z } from "zod";
import { accountReferenceSchema, accountSchemeSchema, instantSchema, reasonSchema, safeCode, safeText } from "./common";
import { positiveMoneyJsonSchema } from "./money";

export const SINGLE_PAYMENT_TYPES = ["INSTANT_ACCOUNT_CREDIT", "ACH_CREDIT", "OWN_ACCOUNT_TRANSFER"] as const;
export type SinglePaymentType = (typeof SINGLE_PAYMENT_TYPES)[number];

export const PAYMENT_TYPE_RAIL = {
  INSTANT_ACCOUNT_CREDIT: "LYPAY",
  ACH_CREDIT: "ACH",
  OWN_ACCOUNT_TRANSFER: "INTERNAL",
} as const satisfies Record<SinglePaymentType, "LYPAY" | "ACH" | "INTERNAL">;

export const PAYMENT_TYPE_MODULE = {
  INSTANT_ACCOUNT_CREDIT: "1.1",
  ACH_CREDIT: "1.2",
  OWN_ACCOUNT_TRANSFER: "1.5",
} as const satisfies Record<SinglePaymentType, string>;

export const executionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("IMMEDIATE") }),
  z.strictObject({
    mode: z.literal("SCHEDULED"),
    /** Requested UTC instant. The bank calendar may roll it to the next open window. */
    executeAt: instantSchema,
  }),
]);

/**
 * The currency always comes from the source account; a client cannot choose another one, and
 * the actor, tenant, fee and rail are never request fields.
 */
export const paymentInputSchema = z
  .strictObject({
    moduleId: z.enum(["1.1", "1.2", "1.5"]),
    transactionType: z.enum(SINGLE_PAYMENT_TYPES),
    sourceAccountId: z.uuid(),
    beneficiaryId: z.uuid().optional(),
    destinationAccountId: z.uuid().optional(),
    amount: positiveMoneyJsonSchema,
    purpose: safeText(3, 140),
    clientReference: safeCode(64).optional(),
    execution: executionSchema,
    /** Explicit acknowledgment of a "close match" name-check result (recorded with the proposal). */
    acknowledgeCloseMatch: z.boolean().optional(),
    /** Explicit acceptance of a rolled-forward execution window (PAY-03). */
    acceptRolledExecution: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (PAYMENT_TYPE_MODULE[value.transactionType] !== value.moduleId) {
      ctx.addIssue({ code: "custom", path: ["transactionType"], message: "transaction type does not belong to this module" });
    }
    const own = value.transactionType === "OWN_ACCOUNT_TRANSFER";
    if (own && (!value.destinationAccountId || value.beneficiaryId)) {
      ctx.addIssue({ code: "custom", path: ["destinationAccountId"], message: "an own-account transfer needs a destination account and no beneficiary" });
    }
    if (!own && (!value.beneficiaryId || value.destinationAccountId)) {
      ctx.addIssue({ code: "custom", path: ["beneficiaryId"], message: "a beneficiary is required and a destination account is not allowed" });
    }
    if (own && value.destinationAccountId === value.sourceAccountId) {
      ctx.addIssue({ code: "custom", path: ["destinationAccountId"], message: "source and destination must be different accounts" });
    }
  });

export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const cancelPaymentSchema = z.strictObject({ reason: reasonSchema });

export const voteSchema = z.strictObject({
  /** Revision of the proposal that was reviewed. */
  proposalVersion: z.int().min(1),
  /** Digest of the exact payload that was reviewed. */
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: safeText(3, 500).optional(),
});

export const rejectSchema = voteSchema.extend({ reason: reasonSchema });

export const beneficiaryInputSchema = z.strictObject({
  displayName: safeText(2, 160),
  scheme: accountSchemeSchema,
  accountReference: accountReferenceSchema,
  acknowledgeCloseMatch: z.boolean().optional(),
});

export const beneficiaryUpdateSchema = z.strictObject({
  displayName: safeText(2, 160),
  acknowledgeCloseMatch: z.boolean().optional(),
});

export const nameEnquirySchema = z.strictObject({
  scheme: accountSchemeSchema,
  accountReference: accountReferenceSchema,
  name: safeText(2, 160),
});

export const paymentListQuerySchema = z.strictObject({
  state: z.string().max(40).optional(),
  accountId: z.uuid().optional(),
  rail: z.enum(["LYPAY", "ACH", "INTERNAL"]).optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  reference: z.string().trim().max(64).optional(),
  cursor: z.string().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
