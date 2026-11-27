/**
 * Customer register, minimal invoice references and deposit allocation (COL-01).
 *
 * A customer code is unique per corporate — never globally — and cannot change once a deposit
 * or an invoice refers to it. Customers are archived, never deleted. An invoice here is a
 * collection reference (amount, due date), not an accounting ledger: "paid" is derived from
 * append-only allocation entries of POSTED deposits and is never set by hand.
 */
import { customerCreateSchema, customerUpdateSchema, invoiceCreateSchema, allocationSchema } from "@/contracts/collections";
import { DomainError, conflict, notFound } from "@/contracts/errors";
import { minorToJson, type MoneyJson } from "@/contracts/money";
import { dbDateToLocalDate, localDateToDbDate } from "@/lib/calendar";
import { writeAudit } from "@/server/audit/audit";
import { readableAccountIds, requireCorporate, requirePermission, requirePerson, type AuthContext } from "@/server/auth/context";
import { inTx, isUniqueViolation, type Prisma } from "@/server/db/client";
import type { Deps } from "@/server/deps";
import type { Customer, InvoiceReference } from "@/generated/prisma/client";

export type CustomerView = {
  id: string;
  code: string;
  displayName: string;
  company: string;
  mobile: string;
  industry: string | null;
  tags: string[];
  billingAddress: string | null;
  archived: boolean;
  /** The code can no longer change: a deposit or an invoice refers to it. */
  referenced: boolean;
  version: number;
  createdAt: string;
};

export type InvoiceView = {
  id: string;
  customerId: string;
  reference: string;
  amount: MoneyJson;
  allocated: MoneyJson;
  due: MoneyJson;
  dueDate: string;
  status: "OPEN" | "PAID" | "CANCELLED";
  version: number;
};

export type CustomerDetail = CustomerView & {
  totals: { deposits: number; posted: MoneyJson; invoiced: MoneyJson; paid: MoneyJson; due: MoneyJson; openInvoices: number };
  invoices: InvoiceView[];
};

const customerView = (row: Customer): CustomerView => ({
  id: row.id,
  code: row.code,
  displayName: row.displayName,
  company: row.company,
  mobile: row.mobileE164,
  industry: row.industry,
  tags: row.tags,
  billingAddress: row.billingAddress,
  archived: row.archivedAt !== null,
  referenced: row.referencedAt !== null,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
});

const invoiceView = (row: InvoiceReference): InvoiceView => ({
  id: row.id,
  customerId: row.customerId,
  reference: row.reference,
  amount: minorToJson(row.amountMinor, row.currency),
  allocated: minorToJson(row.allocatedMinor, row.currency),
  due: minorToJson(row.amountMinor - row.allocatedMinor, row.currency),
  dueDate: dbDateToLocalDate(row.dueDate),
  // Derived, never stored: an invoice is paid when allocations cover it.
  status: row.status === "CANCELLED" ? "CANCELLED" : row.allocatedMinor >= row.amountMinor ? "PAID" : "OPEN",
  version: row.version,
});

export async function listCustomers(
  deps: Deps,
  ctx: AuthContext,
  query: { search?: string | undefined; includeArchived?: "true" | "false" | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: CustomerView[]; nextCursor: string | null }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "customers.read");
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const where: Prisma.CustomerWhereInput = {
    corporateId: corporateCtx.corporateId,
    ...(query.includeArchived === "true" ? {} : { archivedAt: null }),
    ...(query.search ? { OR: [{ displayName: { contains: query.search, mode: "insensitive" } }, { company: { contains: query.search, mode: "insensitive" } }, { code: { contains: query.search.toUpperCase() } }] } : {}),
  };
  const rows = await deps.db.customer.findMany({ where, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
  const page = rows.slice(0, limit);
  return { items: page.map(customerView), nextCursor: rows.length > limit ? (page[page.length - 1] as Customer).id : null };
}

export async function getCustomer(deps: Deps, ctx: AuthContext, customerId: string): Promise<CustomerDetail> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "customers.read");
  const row = await deps.db.customer.findFirst({ where: { id: customerId, corporateId: corporateCtx.corporateId } });
  if (!row) throw notFound();
  const invoices = await deps.db.invoiceReference.findMany({ where: { customerId, corporateId: corporateCtx.corporateId }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 100 });
  // Deposit figures only for accounts the caller may read.
  const readable = readableAccountIds(corporateCtx);
  const deposits = corporateCtx.permissions.has("deposits.read")
    ? await deps.db.deposit.findMany({ where: { customerId, corporateId: corporateCtx.corporateId, creditAccountId: { in: readable } }, select: { state: true, amountMinor: true } })
    : [];
  const open = invoices.filter((invoice) => invoice.status === "OPEN");
  const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
  const invoiced = sum(open.map((invoice) => invoice.amountMinor));
  const paid = sum(open.map((invoice) => invoice.allocatedMinor));
  return {
    ...customerView(row),
    totals: {
      deposits: deposits.length,
      posted: minorToJson(sum(deposits.filter((deposit) => deposit.state === "POSTED").map((deposit) => deposit.amountMinor)), "LYD"),
      invoiced: minorToJson(invoiced, "LYD"),
      paid: minorToJson(paid, "LYD"),
      due: minorToJson(invoiced - paid, "LYD"),
      openInvoices: open.filter((invoice) => invoice.allocatedMinor < invoice.amountMinor).length,
    },
    invoices: invoices.map(invoiceView),
  };
}

export async function createCustomer(deps: Deps, ctx: AuthContext, rawInput: unknown, customerId: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "customers.manage");
  const person = requirePerson(corporateCtx);
  const input = customerCreateSchema.parse(rawInput);
  try {
    await inTx(deps.db, async (tx) => {
      await tx.customer.create({
        data: {
          id: customerId,
          bankId: corporateCtx.bankId,
          corporateId: corporateCtx.corporateId,
          code: input.code,
          displayName: input.displayName,
          company: input.company,
          mobileE164: input.mobile,
          industry: input.industry ?? null,
          tags: input.tags ?? [],
          billingAddress: input.billingAddress ?? null,
          createdByPersonId: person.personId,
        },
      });
      await writeAudit(tx, corporateCtx, { action: "customer.created", targetType: "customer", targetId: customerId, changes: { code: input.code } });
    });
  } catch (error) {
    // Unique per corporate: the same code in another corporate is a different customer.
    if (isUniqueViolation(error)) throw new DomainError("DUPLICATE_RESOURCE", { detail: "A customer with this code already exists.", violations: [{ field: "code", rule: "unique", message: "A customer with this code already exists." }] });
    throw error;
  }
}

export async function updateCustomer(deps: Deps, ctx: AuthContext, customerId: string, rawInput: unknown, expectedVersion: number): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "customers.manage");
  const input = customerUpdateSchema.parse(rawInput);
  await inTx(deps.db, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId}::uuid FOR UPDATE`;
    const current = await tx.customer.findFirst({ where: { id: customerId, corporateId: corporateCtx.corporateId } });
    if (!current) throw notFound();
    if (current.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT");
    if (input.archived === true && current.archivedAt === null) {
      // An open invoice blocks archiving; history is never deleted with the customer.
      const open = await tx.invoiceReference.findMany({ where: { customerId, status: "OPEN" }, select: { amountMinor: true, allocatedMinor: true } });
      if (open.some((invoice) => invoice.allocatedMinor < invoice.amountMinor)) {
        throw new DomainError("STATE_CONFLICT", { detail: "This customer has open invoices and cannot be archived.", violations: [{ field: "archived", rule: "openInvoices", message: "Settle or cancel the open invoices first." }] });
      }
    }
    await tx.customer.update({
      where: { id: customerId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.mobile !== undefined ? { mobileE164: input.mobile } : {}),
        ...(input.industry !== undefined ? { industry: input.industry } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.billingAddress !== undefined ? { billingAddress: input.billingAddress } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? (current.archivedAt ?? deps.clock.now()) : null } : {}),
        version: { increment: 1 },
      },
    });
    const action = input.archived === true && current.archivedAt === null ? "customer.archived" : input.archived === false && current.archivedAt !== null ? "customer.restored" : "customer.updated";
    await writeAudit(tx, corporateCtx, { action, targetType: "customer", targetId: customerId, changes: { code: current.code, fields: Object.keys(input).join(",") } });
  });
}

export async function listInvoices(
  deps: Deps,
  ctx: AuthContext,
  query: { customerId?: string | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: InvoiceView[]; nextCursor: string | null }> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "customers.read");
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const rows = await deps.db.invoiceReference.findMany({
    where: { corporateId: corporateCtx.corporateId, ...(query.customerId ? { customerId: query.customerId } : {}) },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return { items: page.map(invoiceView), nextCursor: rows.length > limit ? (page[page.length - 1] as InvoiceReference).id : null };
}

export async function getInvoice(deps: Deps, ctx: AuthContext, invoiceId: string): Promise<InvoiceView> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "customers.read");
  const row = await deps.db.invoiceReference.findFirst({ where: { id: invoiceId, corporateId: corporateCtx.corporateId } });
  if (!row) throw notFound();
  return invoiceView(row);
}

export async function createInvoice(deps: Deps, ctx: AuthContext, rawInput: unknown, invoiceId: string): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "invoices.manage");
  const person = requirePerson(corporateCtx);
  const input = invoiceCreateSchema.parse(rawInput);
  if (input.amount.currency !== "LYD") throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "amount", rule: "currency", message: "Invoices are in LYD." }] });
  try {
    await inTx(deps.db, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: input.customerId, corporateId: corporateCtx.corporateId } });
      if (!customer) throw notFound();
      if (customer.archivedAt !== null) throw conflict("This customer is archived.");
      await tx.invoiceReference.create({
        data: { id: invoiceId, bankId: corporateCtx.bankId, corporateId: corporateCtx.corporateId, customerId: customer.id, reference: input.reference.toUpperCase(), amountMinor: BigInt(input.amount.minor), currency: "LYD", dueDate: localDateToDbDate(input.dueDate), createdByPersonId: person.personId },
      });
      if (customer.referencedAt === null) await tx.customer.update({ where: { id: customer.id }, data: { referencedAt: deps.clock.now() } });
      await writeAudit(tx, corporateCtx, { action: "invoice.created", targetType: "invoice", targetId: invoiceId, changes: { reference: input.reference.toUpperCase(), amountMinor: input.amount.minor, customerCode: customer.code } });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("DUPLICATE_RESOURCE", { detail: "An invoice with this reference already exists.", violations: [{ field: "reference", rule: "unique", message: "An invoice with this reference already exists." }] });
    throw error;
  }
}

/**
 * Match part of a POSTED deposit to an invoice of the SAME customer. Both rows are locked, so
 * parallel allocations cannot use the same money twice or overpay an invoice (I-39).
 */
export async function allocateDeposit(deps: Deps, ctx: AuthContext, invoiceId: string, rawInput: unknown): Promise<void> {
  const corporateCtx = requireCorporate(ctx);
  requirePermission(corporateCtx, "invoices.manage");
  const person = requirePerson(corporateCtx);
  const input = allocationSchema.parse(rawInput);
  const amount = BigInt(input.amount.minor);
  await inTx(deps.db, async (tx) => {
    // Fixed lock order (deposit, then invoice) so two allocations cannot deadlock.
    await tx.$queryRaw`SELECT "id" FROM "Deposit" WHERE "id" = ${input.depositId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "InvoiceReference" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
    const invoice = await tx.invoiceReference.findFirst({ where: { id: invoiceId, corporateId: corporateCtx.corporateId } });
    const deposit = await tx.deposit.findFirst({ where: { id: input.depositId, corporateId: corporateCtx.corporateId } });
    if (!invoice || !deposit) throw notFound();
    if (!readableAccountIds(corporateCtx).includes(deposit.creditAccountId)) throw notFound();
    const refuse = (rule: string, message: string) => new DomainError("VALIDATION_FAILED", { violations: [{ field: "amount", rule, message }] });
    if (deposit.customerId !== invoice.customerId) throw refuse("sameCustomer", "The deposit belongs to another customer.");
    if (deposit.state !== "POSTED") throw refuse("posted", "Only a posted deposit can be allocated.");
    if (invoice.status !== "OPEN") throw refuse("openInvoice", "This invoice is not open.");
    if (input.amount.currency !== deposit.currency || deposit.currency !== invoice.currency) throw refuse("currency", "The currency does not match.");
    if (amount > deposit.amountMinor - deposit.allocatedMinor) throw refuse("depositRemaining", "The amount is more than what is left of the deposit.");
    if (amount > invoice.amountMinor - invoice.allocatedMinor) throw refuse("invoiceDue", "The amount is more than what is due on the invoice.");
    await tx.depositAllocation.create({ data: { corporateId: corporateCtx.corporateId, depositId: deposit.id, invoiceId: invoice.id, amountMinor: amount, createdByPersonId: person.personId } });
    await tx.deposit.update({ where: { id: deposit.id }, data: { allocatedMinor: { increment: amount }, version: { increment: 1 } } });
    await tx.invoiceReference.update({ where: { id: invoice.id }, data: { allocatedMinor: { increment: amount }, version: { increment: 1 } } });
    await writeAudit(tx, corporateCtx, { action: "invoice.allocated", targetType: "invoice", targetId: invoice.id, changes: { invoiceReference: invoice.reference, depositReference: deposit.intakeReference, amountMinor: amount.toString() } });
  });
}
