/** Collections (S7): customers, minimal invoice references, allocations and the corporate view of deposits. */
import { z } from "zod";
import { allocationSchema, customerCreateSchema, customerListQuerySchema, customerUpdateSchema, depositListQuerySchema, invoiceCreateSchema, invoiceListQuerySchema, receiptQuerySchema } from "@/contracts/collections";
import { idParamSchema } from "@/contracts/common";
import { depositReceiptPdf, getDeposit, listDeposits } from "@/server/domain/collections/deposits";
import { allocateDeposit, createCustomer, createInvoice, getCustomer, getInvoice, listCustomers, listInvoices, updateCustomer } from "@/server/domain/collections/service";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const collectionOperations: AnyOperation[] = [
  query<Record<string, never>, z.infer<typeof customerListQuerySchema>>({
    id: "listCustomers",
    method: "GET",
    path: "/customers",
    summary: "Customer register of the corporate",
    tag: "Collections",
    scope: "corporate",
    permission: "customers.read",
    credentialScope: "collections:read",
    query: customerListQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listCustomers(deps, ctx, q);
      return { data: result.items, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof customerCreateSchema>>({
    id: "createCustomer",
    method: "POST",
    path: "/customers",
    summary: "Register a customer",
    description: "The code is unique per corporate, not globally.",
    tag: "Collections",
    scope: "corporate",
    permission: "customers.manage",
    body: customerCreateSchema,
    successStatus: 201,
    execute: async ({ deps, ctx, body, newId }) => createCustomer(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getCustomer(deps, ctx, ref.id),
  }),
  query<IdParams>({
    id: "getCustomer",
    method: "GET",
    path: "/customers/{id}",
    summary: "Customer details, invoice references and totals",
    tag: "Collections",
    scope: "corporate",
    permission: "customers.read",
    credentialScope: "collections:read",
    params: idParamSchema,
    handler: async ({ deps, ctx, params }) => ({ data: await getCustomer(deps, ctx, params.id) }),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof customerUpdateSchema>>({
    id: "updateCustomer",
    method: "PATCH",
    path: "/customers/{id}",
    summary: "Update permitted customer fields, archive or restore",
    description: "The code cannot change. A customer with open invoices cannot be archived; nothing is ever deleted.",
    tag: "Collections",
    scope: "corporate",
    permission: "customers.manage",
    params: idParamSchema,
    body: customerUpdateSchema,
    ifMatch: true,
    target: ({ params }) => ({ type: "customer", id: params.id }),
    execute: async ({ deps, ctx, params, body, expectedVersion }) => updateCustomer(deps, ctx, params.id, body, expectedVersion),
    render: async ({ deps, ctx }, ref) => getCustomer(deps, ctx, ref.id),
  }),
  query<Record<string, never>, z.infer<typeof invoiceListQuerySchema>>({
    id: "listInvoices",
    method: "GET",
    path: "/invoices",
    summary: "Minimal collection invoice references",
    tag: "Collections",
    scope: "corporate",
    permission: "customers.read",
    credentialScope: "collections:read",
    query: invoiceListQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listInvoices(deps, ctx, q);
      return { data: result.items, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof invoiceCreateSchema>>({
    id: "createInvoice",
    method: "POST",
    path: "/invoices",
    summary: "Create a collection invoice reference",
    description: "Reference, customer, LYD amount and due date. Not a tax or accounting invoice.",
    tag: "Collections",
    scope: "corporate",
    permission: "invoices.manage",
    body: invoiceCreateSchema,
    successStatus: 201,
    execute: async ({ deps, ctx, body, newId }) => createInvoice(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getInvoice(deps, ctx, ref.id),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof allocationSchema>>({
    id: "allocateInvoice",
    method: "POST",
    path: "/invoices/{id}/allocate",
    summary: "Match part of a posted deposit to an invoice of the same customer",
    description: "Never more than what is left of the deposit or what is due on the invoice. Paid status is derived, never set.",
    tag: "Collections",
    scope: "corporate",
    permission: "invoices.manage",
    params: idParamSchema,
    body: allocationSchema,
    target: ({ params }) => ({ type: "invoice", id: params.id }),
    execute: async ({ deps, ctx, params, body }) => allocateDeposit(deps, ctx, params.id, body),
    render: async ({ deps, ctx }, ref) => getInvoice(deps, ctx, ref.id),
  }),
  query<Record<string, never>, z.infer<typeof depositListQuerySchema>>({
    id: "listDeposits",
    method: "GET",
    path: "/deposits",
    summary: "Branch deposits for readable accounts (90-day default window)",
    tag: "Collections",
    scope: "corporate",
    permission: "deposits.read",
    credentialScope: "collections:read",
    query: depositListQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listDeposits(deps, ctx, q);
      return { data: { items: result.items, window: result.window }, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  query<IdParams>({
    id: "getDeposit",
    method: "GET",
    path: "/deposits/{id}",
    summary: "Deposit details and status",
    description: "For a corporate reader of the credited account, or for staff of the deposit's branch.",
    tag: "Collections",
    scope: "any",
    permission: ["deposits.read", "bank.deposits.read"],
    credentialScope: "collections:read",
    params: idParamSchema,
    handler: async ({ deps, ctx, params }) => ({ data: await getDeposit(deps, ctx, params.id) }),
  }),
  query<IdParams, z.infer<typeof receiptQuerySchema>>({
    id: "downloadDepositReceipt",
    method: "GET",
    path: "/deposits/{id}/receipt",
    summary: "Receipt PDF (acknowledgment or posted) with the simulated stamp",
    description: "Rendered on demand for a reader authorized at download time. Not an official bank certificate.",
    tag: "Collections",
    scope: "any",
    permission: ["deposits.read", "bank.deposits.read"],
    params: idParamSchema,
    query: receiptQuerySchema,
    handler: async ({ deps, ctx, params, query: q }) => ({ raw: await depositReceiptPdf(deps, ctx, params.id, q.locale ?? "en") }),
  }),
];
