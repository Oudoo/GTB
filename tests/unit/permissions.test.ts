/**
 * The permission matrix of document 02, Appendix B, as an executable table (SEC-02, APR-02,
 * SEC-04, API-01). It checks what each role composes to and — more importantly — what it must
 * never compose to. Identity separation (the same person cannot approve their own proposal
 * whatever roles they hold) is proven against PostgreSQL in the integration tests; this file
 * guards the role map itself against an accidental widening.
 */
import { describe, expect, it } from "vitest";
import { CREDENTIAL_SCOPES } from "@/contracts/developer";
import {
  API_SCOPES,
  APPROVAL_CLASS_PERMISSION,
  BANK_ROLES,
  CORPORATE_ROLES,
  PERMISSIONS,
  permissionsForRoles,
  permissionsForScopes,
  rolePermissions,
  type Permission,
  type RoleName,
} from "@/server/auth/permissions";

const of = (...roles: RoleName[]) => permissionsForRoles(roles);
const has = (roles: RoleName[], permission: Permission) => of(...roles).has(permission);
const APPROVALS = Object.values(APPROVAL_CLASS_PERMISSION) as Permission[];
/** Permissions that create, change or decide something. */
const WRITES = PERMISSIONS.filter((permission) => /\.(create|cancel|approve|manage|propose|suspend|capture|act|control|detail)$/.test(permission) || permission === "reports.request");

describe("workspaces never mix", () => {
  it("no corporate role holds a bank permission and no bank role a corporate one", () => {
    for (const role of CORPORATE_ROLES) expect(rolePermissions(role).filter((permission) => permission.startsWith("bank.")), role).toEqual([]);
    for (const role of BANK_ROLES) expect(rolePermissions(role).filter((permission) => !permission.startsWith("bank.")), role).toEqual([]);
  });

  it("every permission in the catalogue belongs to some role; unknown role names add nothing", () => {
    const granted = new Set<Permission>([...CORPORATE_ROLES, ...BANK_ROLES].flatMap((role) => [...rolePermissions(role)]));
    // Managing API credentials is composed from two roles, never granted by one.
    expect(PERMISSIONS.filter((permission) => !granted.has(permission))).toEqual(["developer.manage"]);
    expect([...permissionsForRoles(["SUPERUSER", "ADMIN", "isAdmin", ""])]).toEqual([]);
    expect([...permissionsForRoles(["VIEWER", "ROOT"])].sort()).toEqual([...rolePermissions("VIEWER")].sort());
  });
});

describe("corporate roles (Appendix B)", () => {
  it("a maker and a treasurer create payments and batches and cannot approve anything", () => {
    for (const role of ["MAKER", "TREASURER"] as const) {
      expect(has([role], "payments.create")).toBe(true);
      expect(has([role], "batches.create")).toBe(true);
      expect(APPROVALS.filter((permission) => has([role], permission)), role).toEqual([]);
      expect(has([role], "payroll.detail")).toBe(false);
    }
  });

  it("a checker approves payments, batches, payroll totals and access changes, and creates none of them", () => {
    expect(APPROVALS.filter((permission) => has(["CHECKER"], permission)).sort()).toEqual(["admin.approve", "batches.approve", "payments.approve", "payroll.approve"]);
    for (const permission of ["payments.create", "batches.create", "payroll.detail", "beneficiaries.manage", "admin.users.propose", "customers.manage"] as const) expect(has(["CHECKER"], permission), permission).toBe(false);
    // Approving a payroll total needs the aggregate, not the detail.
    expect(has(["CHECKER"], "payroll.aggregate.read")).toBe(true);
  });

  it("salary detail belongs to the payroll officer alone, who can approve nothing and pay nothing else", () => {
    const holders = [...CORPORATE_ROLES, ...BANK_ROLES].filter((role) => rolePermissions(role).includes("payroll.detail"));
    expect(holders).toEqual(["PAYROLL_OFFICER"]);
    expect(APPROVALS.filter((permission) => has(["PAYROLL_OFFICER"], permission))).toEqual([]);
    for (const permission of ["payments.create", "batches.create", "payments.read", "reports.request", "audit.read", "customers.read"] as const) expect(has(["PAYROLL_OFFICER"], permission), permission).toBe(false);
  });

  it("a corporate administrator governs access and holds no money or salary permission", () => {
    const admin = [...of("CORPORATE_ADMIN")].sort();
    expect(admin).toEqual(["admin.approve", "admin.rules.propose", "admin.users.propose", "admin.users.read", "admin.users.suspend", "agreement.read", "audit.read", "limits.read"]);
    expect(admin.filter((permission) => /^(payments|batches|payroll|beneficiaries|accounts|customers|invoices|deposits|reports)\./.test(permission))).toEqual([]);
  });

  it("a viewer only reads (and may request a report of what they can read)", () => {
    expect(WRITES.filter((permission) => has(["VIEWER"], permission))).toEqual(["reports.request"]);
    expect(has(["VIEWER"], "payroll.aggregate.read")).toBe(true);
    expect(has(["VIEWER"], "audit.read")).toBe(false);
  });

  it("finance manages customers, invoices and reports and moves no money", () => {
    expect(WRITES.filter((permission) => has(["FINANCE"], permission)).sort()).toEqual(["customers.manage", "invoices.manage", "reports.request"]);
  });

  it("managing API credentials needs the administrator AND the integrator role", () => {
    expect([...of("API_INTEGRATOR")]).toEqual(["developer.read"]);
    expect(has(["CORPORATE_ADMIN"], "developer.manage")).toBe(false);
    expect(has(["API_INTEGRATOR"], "developer.manage")).toBe(false);
    expect(has(["CORPORATE_ADMIN", "API_INTEGRATOR"], "developer.manage")).toBe(true);
    expect(has(["MAKER", "API_INTEGRATOR"], "developer.manage")).toBe(false);
  });

  it("combining maker and checker composes both sets — which is why the vote checks the person, not the role", () => {
    const dual = of("MAKER", "CHECKER");
    expect(dual.has("payments.create") && dual.has("payments.approve")).toBe(true);
    expect(dual.has("payroll.detail")).toBe(false);
    expect([...dual].filter((permission) => permission.startsWith("bank."))).toEqual([]);
  });
});

describe("bank roles (Appendix B)", () => {
  it("the proposing administrator cannot approve; the approving administrator cannot propose", () => {
    expect(has(["BANK_ADMIN_MAKER"], "bank.agreement.propose") && has(["BANK_ADMIN_MAKER"], "bank.rail.propose")).toBe(true);
    expect(APPROVALS.filter((permission) => has(["BANK_ADMIN_MAKER"], permission))).toEqual([]);
    expect(APPROVALS.filter((permission) => has(["BANK_ADMIN_CHECKER"], permission)).sort()).toEqual(["bank.governance.approve", "bank.repair.approve"]);
    expect(has(["BANK_ADMIN_CHECKER"], "bank.agreement.propose") || has(["BANK_ADMIN_CHECKER"], "bank.rail.propose")).toBe(false);
  });

  it("a teller captures and cannot approve; a branch manager approves and cannot capture", () => {
    expect([...of("BRANCH_TELLER")].sort()).toEqual(["bank.deposits.read", "bank.teller.capture"]);
    expect([...of("BRANCH_MANAGER")].sort()).toEqual(["bank.deposit.approve", "bank.deposits.read"]);
  });

  it("operations can inquire and propose a repair but only a bank administrator (checker) approves it", () => {
    expect(has(["PAYMENTS_OPERATIONS"], "bank.operations.act")).toBe(true);
    expect(has(["PAYMENTS_OPERATIONS"], "bank.repair.approve")).toBe(false);
    expect(has(["PAYMENTS_OPERATIONS"], "bank.governance.approve")).toBe(false);
    expect([...BANK_ROLES].filter((role) => rolePermissions(role).includes("bank.repair.approve"))).toEqual(["BANK_ADMIN_CHECKER"]);
  });

  it("relationship manager, compliance and payroll support read within their purpose and change nothing", () => {
    expect([...of("RELATIONSHIP_MANAGER")]).toEqual(["bank.corporates.read"]);
    expect([...of("COMPLIANCE")].sort()).toEqual(["bank.audit.read", "bank.corporates.read"]);
    expect([...of("PAYROLL_SUPPORT")].sort()).toEqual(["bank.operations.read", "bank.payroll.support"]);
    // The masked payroll diagnostic is for the seeded support role only.
    expect([...BANK_ROLES].filter((role) => rolePermissions(role).includes("bank.payroll.support"))).toEqual(["PAYROLL_SUPPORT"]);
  });

  it("only operations may drive the sandbox simulator", () => {
    expect([...BANK_ROLES].filter((role) => rolePermissions(role).includes("bank.simulator.control"))).toEqual(["PAYMENTS_OPERATIONS"]);
  });
});

describe("approval classes", () => {
  it("each class has its own permission, so a vote of one class can never serve another", () => {
    expect(new Set(APPROVALS).size).toBe(Object.keys(APPROVAL_CLASS_PERMISSION).length);
    expect(Object.keys(APPROVAL_CLASS_PERMISSION).sort()).toEqual(["BANK_GOVERNANCE", "BANK_REPAIR", "BRANCH_DEPOSIT", "BULK", "CORPORATE_ADMIN", "PAYMENT", "PAYROLL"]);
  });

  it("no single role both prepares and approves a money movement, a deposit, a repair or a bank change", () => {
    const pairs: Array<[Permission, Permission]> = [
      ["payments.create", "payments.approve"],
      ["batches.create", "batches.approve"],
      ["payroll.detail", "payroll.approve"],
      ["bank.agreement.propose", "bank.governance.approve"],
      ["bank.rail.propose", "bank.governance.approve"],
      ["bank.teller.capture", "bank.deposit.approve"],
      ["bank.operations.act", "bank.repair.approve"],
    ];
    for (const [prepare, approve] of pairs) {
      const both = [...CORPORATE_ROLES, ...BANK_ROLES].filter((role) => rolePermissions(role).includes(prepare) && rolePermissions(role).includes(approve));
      expect(both, `${prepare} with ${approve}`).toEqual([]);
    }
  });
});

describe("API credential scopes (API-01)", () => {
  it("no scope reaches an approval, administration, salary detail, a report or the bank workspace", () => {
    const everything = permissionsForScopes(Object.keys(API_SCOPES));
    expect([...everything].filter((permission) => /\.approve$|^admin\.|^bank\.|^payroll\.|^reports\.|^audit\.|^developer\.manage$|^alerts\./.test(permission))).toEqual([]);
  });

  it("a scope name that does not exist grants nothing, whatever text is supplied", () => {
    expect([...permissionsForScopes(["payments:approve", "admin:*", "*", "bank:admin", "payroll:read", ""])]).toEqual([]);
    expect([...permissionsForScopes(["accounts:read", "payments:approve"])].sort()).toEqual(["accounts.read", "limits.read"]);
  });

  it("only read scopes, payment writes and webhook management can be granted to a token", () => {
    expect([...CREDENTIAL_SCOPES].sort()).toEqual(["accounts:read", "agreements:read", "batches:read", "collections:read", "payments:read", "payments:write", "webhooks:manage"]);
    for (const scope of CREDENTIAL_SCOPES) expect(Object.keys(API_SCOPES)).toContain(scope);
    // A token can prepare a payment; it can never vote on one, and it cannot upload a batch.
    const grantable = permissionsForScopes(CREDENTIAL_SCOPES);
    expect(grantable.has("payments.create")).toBe(true);
    expect(grantable.has("payments.approve")).toBe(false);
    expect(grantable.has("batches.create")).toBe(false);
    expect(grantable.has("payroll.aggregate.read")).toBe(false);
  });
});
