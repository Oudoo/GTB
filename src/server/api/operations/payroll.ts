/**
 * Payroll employee master (S6, PYR-01). Every operation needs the payroll-detail permission and
 * a signed-in person: there is no API-credential scope that reaches employee data.
 * Payroll RUNS use the shared batch operations with kind=PAYROLL.
 */
import { z } from "zod";
import { idParamSchema } from "@/contracts/common";
import { employeeCreateSchema, employeeImportCommitSchema, employeeListQuerySchema, employeeUpdateSchema } from "@/contracts/payroll";
import { commitEmployeeImport, createEmployee, getEmployee, getEmployeeImport, listEmployees, previewEmployeeImport, updateEmployee } from "@/server/domain/payroll/employees";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const payrollOperations: AnyOperation[] = [
  query<Record<string, never>, z.infer<typeof employeeListQuerySchema>>({
    id: "listEmployees",
    method: "GET",
    path: "/payroll/employees",
    summary: "Employee master of the corporate (payroll officers only)",
    description: "Returns names and account identifiers; the read is audited without its content.",
    tag: "Payroll",
    scope: "corporate",
    permission: "payroll.detail",
    query: employeeListQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listEmployees(deps, ctx, q);
      return { data: { items: result.items, counts: result.counts }, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof employeeCreateSchema>>({
    id: "createEmployee",
    method: "POST",
    path: "/payroll/employees",
    summary: "Add an employee and check the account name",
    description: "The employee code is unique per corporate. An account that does not pass the name check is stored but cannot be paid.",
    tag: "Payroll",
    scope: "corporate",
    permission: "payroll.detail",
    body: employeeCreateSchema,
    successStatus: 201,
    execute: async ({ deps, ctx, body, newId }) => createEmployee(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getEmployee(deps, ctx, ref.id),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof employeeUpdateSchema>>({
    id: "updateEmployee",
    method: "PATCH",
    path: "/payroll/employees/{id}",
    summary: "Change an employee's name, account or active status",
    description: "A changed name or account is checked again. Earlier payroll runs keep the snapshot they were validated with.",
    tag: "Payroll",
    scope: "corporate",
    permission: "payroll.detail",
    params: idParamSchema,
    body: employeeUpdateSchema,
    ifMatch: true,
    target: ({ params }) => ({ type: "payrollEmployee", id: params.id }),
    execute: async ({ deps, ctx, params, body, expectedVersion }) => updateEmployee(deps, ctx, params.id, body, expectedVersion),
    render: async ({ deps, ctx }, ref) => getEmployee(deps, ctx, ref.id),
  }),
  command({
    id: "previewEmployeeImport",
    method: "POST",
    path: "/payroll/employees/import",
    summary: "Preview an employee file without changing the master",
    description: "Fields: templateVersion, file. The same bounded parser as batches; every valid row is name-checked. The preview expires after 30 minutes.",
    tag: "Payroll",
    scope: "corporate",
    permission: "payroll.detail",
    multipart: true,
    maxBodyBytes: 6 * 1024 * 1024,
    successStatus: 201,
    execute: async ({ deps, ctx, form, newId }) => previewEmployeeImport(deps, ctx, form, newId),
    render: async ({ deps, ctx }, ref) => getEmployeeImport(deps, ctx, ref.id),
  }),
  query<IdParams>({
    id: "getEmployeeImport",
    method: "GET",
    path: "/payroll/employees/imports/{id}",
    summary: "A previewed or committed employee import",
    tag: "Payroll",
    scope: "corporate",
    permission: "payroll.detail",
    params: idParamSchema,
    handler: async ({ deps, ctx, params }) => ({ data: await getEmployeeImport(deps, ctx, params.id) }),
  }),
  command<IdParams, Record<string, never>, z.infer<typeof employeeImportCommitSchema>>({
    id: "commitEmployeeImport",
    method: "POST",
    path: "/payroll/employees/imports/{id}/commit",
    summary: "Persist exactly the previewed valid rows",
    description: "Bound to the preview digest; one transaction; invalid rows are left out only with an explicit confirmation.",
    tag: "Payroll",
    scope: "corporate",
    permission: "payroll.detail",
    params: idParamSchema,
    body: employeeImportCommitSchema,
    ifMatch: true,
    target: ({ params }) => ({ type: "importSession", id: params.id }),
    execute: async ({ deps, ctx, params, body, expectedVersion }) => commitEmployeeImport(deps, ctx, params.id, body, expectedVersion),
    render: async ({ deps, ctx }, ref) => getEmployeeImport(deps, ctx, ref.id),
  }),
];
