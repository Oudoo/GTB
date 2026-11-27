/**
 * Permission model (SEC-02, Appendix B). Authority is a set of named permissions composed from
 * roles — there is no `isAdmin` and no role "rank". A permission alone is never sufficient:
 * every action is the INTERSECTION of active person, active membership, bank/corporate scope,
 * role permission, per-account grant, agreement entitlement and current policy/state.
 */

export const CORPORATE_ROLES = [
  "CORPORATE_ADMIN",
  "MAKER",
  "CHECKER",
  "TREASURER",
  "FINANCE",
  "PAYROLL_OFFICER",
  "VIEWER",
  "API_INTEGRATOR",
] as const;

export const BANK_ROLES = [
  "BANK_ADMIN_MAKER",
  "BANK_ADMIN_CHECKER",
  "RELATIONSHIP_MANAGER",
  "BRANCH_TELLER",
  "BRANCH_MANAGER",
  "PAYMENTS_OPERATIONS",
  "COMPLIANCE",
  "PAYROLL_SUPPORT",
] as const;

export type CorporateRole = (typeof CORPORATE_ROLES)[number];
export type BankRole = (typeof BANK_ROLES)[number];
export type RoleName = CorporateRole | BankRole;

export const PERMISSIONS = [
  // corporate — cash
  "accounts.read",
  "limits.read",
  "agreement.read",
  // corporate — payments
  "payments.read",
  "payments.create",
  "payments.cancel",
  "payments.approve",
  "beneficiaries.read",
  "beneficiaries.manage",
  // corporate — bulk
  "batches.read",
  "batches.create",
  "batches.approve",
  // corporate — payroll (detail is restricted; aggregate is separate)
  "payroll.detail",
  "payroll.aggregate.read",
  "payroll.approve",
  // corporate — collections and reporting
  "customers.read",
  "customers.manage",
  "invoices.manage",
  "deposits.read",
  "reports.request",
  // corporate — administration
  "admin.users.read",
  "admin.users.propose",
  "admin.users.suspend",
  "admin.rules.propose",
  "admin.approve",
  "alerts.read",
  "alerts.manage",
  "audit.read",
  "developer.read",
  "developer.manage",
  // bank
  "bank.corporates.read",
  "bank.agreement.propose",
  "bank.rail.read",
  "bank.rail.propose",
  "bank.governance.approve",
  "bank.corporate.suspend",
  "bank.teller.capture",
  "bank.deposits.read",
  "bank.deposit.approve",
  "bank.operations.read",
  "bank.operations.act",
  "bank.repair.approve",
  "bank.recon.manage",
  "bank.simulator.control",
  "bank.audit.read",
  "bank.payroll.support",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  // A corporate admin governs access; it carries NO money-movement or salary permission.
  CORPORATE_ADMIN: [
    "agreement.read",
    "limits.read",
    "admin.users.read",
    "admin.users.propose",
    "admin.users.suspend",
    "admin.rules.propose",
    "admin.approve",
    "audit.read",
  ],
  MAKER: [
    "accounts.read",
    "limits.read",
    "agreement.read",
    "payments.read",
    "payments.create",
    "payments.cancel",
    "beneficiaries.read",
    "beneficiaries.manage",
    "batches.read",
    "batches.create",
    "payroll.aggregate.read",
  ],
  CHECKER: [
    "accounts.read",
    "limits.read",
    "agreement.read",
    "payments.read",
    "payments.approve",
    "beneficiaries.read",
    "batches.read",
    "batches.approve",
    "payroll.aggregate.read",
    "payroll.approve",
    "admin.approve",
  ],
  TREASURER: [
    "accounts.read",
    "limits.read",
    "agreement.read",
    "payments.read",
    "payments.create",
    "payments.cancel",
    "beneficiaries.read",
    "beneficiaries.manage",
    "batches.read",
    "batches.create",
    "payroll.aggregate.read",
    "deposits.read",
    "customers.read",
    "reports.request",
    "alerts.read",
    "alerts.manage",
  ],
  FINANCE: [
    "accounts.read",
    "limits.read",
    "agreement.read",
    "payments.read",
    "beneficiaries.read",
    "batches.read",
    "payroll.aggregate.read",
    "customers.read",
    "customers.manage",
    "invoices.manage",
    "deposits.read",
    "reports.request",
    "alerts.read",
    "audit.read",
  ],
  // The only corporate role with salary detail. It cannot approve.
  PAYROLL_OFFICER: ["accounts.read", "limits.read", "agreement.read", "payroll.detail", "payroll.aggregate.read"],
  VIEWER: [
    "accounts.read",
    "limits.read",
    "agreement.read",
    "payments.read",
    "beneficiaries.read",
    "batches.read",
    "payroll.aggregate.read",
    "customers.read",
    "deposits.read",
    "reports.request",
    "alerts.read",
  ],
  API_INTEGRATOR: ["developer.read"],

  BANK_ADMIN_MAKER: ["bank.corporates.read", "bank.agreement.propose", "bank.rail.read", "bank.rail.propose", "bank.corporate.suspend"],
  BANK_ADMIN_CHECKER: [
    "bank.corporates.read",
    "bank.rail.read",
    "bank.governance.approve",
    "bank.repair.approve",
    // A repair approver must be able to read the execution and its inquiry evidence.
    "bank.operations.read",
    "bank.corporate.suspend",
  ],
  // Reads agreements and a corporate summary; no blanket transaction authority (document 01).
  RELATIONSHIP_MANAGER: ["bank.corporates.read"],
  BRANCH_TELLER: ["bank.teller.capture", "bank.deposits.read"],
  BRANCH_MANAGER: ["bank.deposits.read", "bank.deposit.approve"],
  PAYMENTS_OPERATIONS: [
    "bank.corporates.read",
    "bank.rail.read",
    "bank.operations.read",
    "bank.operations.act",
    "bank.recon.manage",
    "bank.simulator.control",
  ],
  COMPLIANCE: ["bank.corporates.read", "bank.audit.read"],
  // Minimum masked diagnostics only; never salary values (SEC-04).
  PAYROLL_SUPPORT: ["bank.operations.read", "bank.payroll.support"],
};

export function isCorporateRole(role: string): role is CorporateRole {
  return (CORPORATE_ROLES as readonly string[]).includes(role);
}

export function isBankRole(role: string): role is BankRole {
  return (BANK_ROLES as readonly string[]).includes(role);
}

/** Permissions a set of roles composes to. */
export function permissionsForRoles(roles: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    const permissions = ROLE_PERMISSIONS[role as RoleName];
    if (!permissions) continue;
    for (const permission of permissions) out.add(permission);
  }
  // "C Admin + API permission" (document 04): managing credentials/webhooks needs BOTH roles.
  if (roles.includes("CORPORATE_ADMIN") && roles.includes("API_INTEGRATOR")) out.add("developer.manage");
  return out;
}

export function rolePermissions(role: RoleName): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** Which permission lets a person vote on each approval class. Classes never substitute. */
export const APPROVAL_CLASS_PERMISSION = {
  PAYMENT: "payments.approve",
  BULK: "batches.approve",
  PAYROLL: "payroll.approve",
  CORPORATE_ADMIN: "admin.approve",
  BANK_GOVERNANCE: "bank.governance.approve",
  BANK_REPAIR: "bank.repair.approve",
  BRANCH_DEPOSIT: "bank.deposit.approve",
} as const satisfies Record<string, Permission>;

export type ApprovalClassName = keyof typeof APPROVAL_CLASS_PERMISSION;

/**
 * Sandbox API credential scopes (document 04) and the permissions each may exercise.
 * No scope maps to an approval, administration or bank permission: a bearer token can never
 * vote, change access or reach the bank workspace, whatever text is supplied as a scope.
 */
export const API_SCOPES = {
  "accounts:read": ["accounts.read", "limits.read"],
  "payments:read": ["payments.read", "beneficiaries.read"],
  "payments:write": ["payments.create", "payments.cancel", "beneficiaries.manage", "beneficiaries.read", "payments.read"],
  "batches:read": ["batches.read"],
  "batches:write": ["batches.create", "batches.read"],
  "collections:read": ["customers.read", "deposits.read"],
  "agreements:read": ["agreement.read", "limits.read"],
  "webhooks:manage": ["developer.read"],
} as const satisfies Record<string, readonly Permission[]>;

export type ApiScope = keyof typeof API_SCOPES;

export function isApiScope(value: string): value is ApiScope {
  return Object.prototype.hasOwnProperty.call(API_SCOPES, value);
}

export function permissionsForScopes(scopes: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const scope of scopes) {
    if (!isApiScope(scope)) continue;
    for (const permission of API_SCOPES[scope]) out.add(permission);
  }
  return out;
}
