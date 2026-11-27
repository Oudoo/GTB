/**
 * Collections contracts (COL-01..03, document 04): customer register, minimal invoice
 * references, allocations and teller deposit intake. Unknown fields are rejected.
 */
import { z } from "zod";
import { safeCode, safeText } from "./common";
import { positiveMoneyJsonSchema } from "./money";

export const CUSTOMER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Company-scoped customer code: normalized to upper case, unique per corporate. */
export const customerCodeSchema = z
  .string()
  .trim()
  .regex(CUSTOMER_CODE_PATTERN)
  .transform((value) => value.toUpperCase());

/** Libyan mobile number in E.164 form. Synthetic numbers only in the sandbox. */
export const mobileSchema = z.string().trim().regex(/^\+218[0-9]{9}$/);

const tags = z.array(safeCode(32)).max(10);

export const customerCreateSchema = z.strictObject({
  code: customerCodeSchema,
  displayName: safeText(2, 160),
  company: safeText(2, 160),
  mobile: mobileSchema,
  industry: safeText(1, 80).optional(),
  tags: tags.optional(),
  billingAddress: safeText(1, 300).optional(),
});

export const customerUpdateSchema = z
  .strictObject({
    displayName: safeText(2, 160).optional(),
    company: safeText(2, 160).optional(),
    mobile: mobileSchema.optional(),
    industry: safeText(1, 80).optional(),
    tags: tags.optional(),
    billingAddress: safeText(1, 300).optional(),
    /** true archives the customer (soft), false restores it. */
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change." });

export const customerListQuerySchema = z.strictObject({
  search: safeText(1, 80).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const invoiceCreateSchema = z.strictObject({
  customerId: z.uuid(),
  reference: safeCode(64),
  amount: positiveMoneyJsonSchema,
  dueDate: z.iso.date(),
});

export const invoiceListQuerySchema = z.strictObject({
  customerId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const allocationSchema = z.strictObject({
  depositId: z.uuid(),
  amount: positiveMoneyJsonSchema,
});

export const DEPOSIT_METHODS = ["CASH", "CHEQUE"] as const;

/**
 * Teller intake. `corporateId` and `branchId` are REQUESTED context only: the teller's verified
 * session decides which bank and branch may be used (document 04).
 */
export const depositIntakeSchema = z
  .strictObject({
    corporateId: z.uuid(),
    customerCode: customerCodeSchema,
    creditAccountId: z.uuid(),
    branchId: z.uuid(),
    method: z.enum(DEPOSIT_METHODS),
    amount: positiveMoneyJsonSchema,
    /** A display reference for the depositor (e.g. a slip number). Not an identity document. */
    depositorReference: safeCode(40),
    chequeReference: safeCode(40).optional(),
  })
  .refine((value) => (value.method === "CHEQUE") === (value.chequeReference !== undefined), { message: "A cheque needs a cheque reference; cash must not have one.", path: ["chequeReference"] });

export const customerLookupQuerySchema = z.strictObject({ corporateId: z.uuid(), customerCode: customerCodeSchema });

export const depositListQuerySchema = z.strictObject({
  customerId: z.uuid().optional(),
  state: z.string().max(40).optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const receiptQuerySchema = z.strictObject({ locale: z.enum(["en", "ar"]).optional() });

export const chequeEventSchema = z.strictObject({
  outcome: z.enum(["CLEARED", "RETURNED"]),
  reason: safeText(3, 200),
});
