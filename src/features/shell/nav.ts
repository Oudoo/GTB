/**
 * Navigation model. Entries are SHOWN only when the caller holds one of the listed
 * permissions; that is a convenience, not a control — every page and API re-checks on the
 * server. Deferred products never appear here: they live on the Product catalogue page.
 */
import type { Permission } from "@/server/auth/permissions";

export type NavItem = {
  key: string;
  /** Message key under `nav` (or `nav.bank`). */
  label: string;
  href: string;
  icon: string;
  /** Any one of these permissions shows the entry. Empty = every member of the workspace. */
  anyOf: readonly Permission[];
  group: string;
  /** One of the four persistent mobile destinations (MOB-03). */
  mobile?: "home" | "payments" | "approvals";
};

export const CORPORATE_NAV: readonly NavItem[] = [
  { key: "dashboard", label: "dashboard", href: "/dashboard", icon: "home", anyOf: [], group: "cash", mobile: "home" },
  { key: "accounts", label: "accounts", href: "/accounts", icon: "wallet", anyOf: ["accounts.read"], group: "cash" },
  { key: "limits", label: "limits", href: "/limits", icon: "gauge", anyOf: ["limits.read"], group: "cash" },
  { key: "notifications", label: "notifications", href: "/notifications", icon: "bell", anyOf: ["alerts.read"], group: "cash" },

  { key: "payments", label: "payments", href: "/payments", icon: "send", anyOf: ["payments.read"], group: "pay", mobile: "payments" },
  { key: "beneficiaries", label: "beneficiaries", href: "/beneficiaries", icon: "users", anyOf: ["beneficiaries.read"], group: "pay" },
  { key: "batches", label: "batches", href: "/batches", icon: "layers", anyOf: ["batches.read"], group: "pay" },
  { key: "payroll", label: "payroll", href: "/payroll", icon: "banknote", anyOf: ["payroll.aggregate.read"], group: "pay" },
  { key: "approvals", label: "approvals", href: "/approvals", icon: "check", anyOf: ["payments.approve", "batches.approve", "payroll.approve", "admin.approve", "payments.read", "admin.users.read"], group: "pay", mobile: "approvals" },

  { key: "customers", label: "customers", href: "/customers", icon: "contact", anyOf: ["customers.read"], group: "collect" },
  { key: "deposits", label: "deposits", href: "/deposits", icon: "inbox", anyOf: ["deposits.read"], group: "collect" },
  { key: "reports", label: "reports", href: "/reports", icon: "file", anyOf: ["reports.request"], group: "collect" },

  { key: "agreement", label: "agreement", href: "/agreement", icon: "scroll", anyOf: ["agreement.read"], group: "control" },
  { key: "audit", label: "audit", href: "/audit", icon: "history", anyOf: ["audit.read"], group: "control" },
  { key: "products", label: "products", href: "/products", icon: "grid", anyOf: [], group: "control" },

  { key: "adminUsers", label: "adminUsers", href: "/admin/users", icon: "shield", anyOf: ["admin.users.read"], group: "administer" },
  { key: "adminRules", label: "adminRules", href: "/admin/approval-rules", icon: "sliders", anyOf: ["admin.users.read"], group: "administer" },
  { key: "developer", label: "developer", href: "/developer", icon: "code", anyOf: ["developer.read", "developer.manage"], group: "administer" },
];

export const BANK_NAV: readonly NavItem[] = [
  { key: "overview", label: "bank.overview", href: "/bank", icon: "home", anyOf: [], group: "govern", mobile: "home" },
  { key: "corporates", label: "bank.corporates", href: "/bank/corporates", icon: "building", anyOf: ["bank.corporates.read"], group: "govern" },
  { key: "approvals", label: "bank.approvals", href: "/bank/approvals", icon: "check", anyOf: ["bank.governance.approve", "bank.repair.approve", "bank.agreement.propose", "bank.rail.propose", "bank.operations.read"], group: "govern" },
  { key: "railParameters", label: "bank.railParameters", href: "/bank/rail-parameters", icon: "sliders", anyOf: ["bank.rail.read"], group: "govern" },

  { key: "teller", label: "bank.teller", href: "/bank/teller", icon: "inbox", anyOf: ["bank.teller.capture"], group: "branch" },
  { key: "branchApprovals", label: "bank.branchApprovals", href: "/bank/branch-approvals", icon: "check", anyOf: ["bank.deposit.approve", "bank.deposits.read"], group: "branch" },

  { key: "operations", label: "bank.operations", href: "/bank/operations", icon: "activity", anyOf: ["bank.operations.read"], group: "operate" },
  { key: "reconciliation", label: "bank.reconciliation", href: "/bank/reconciliation", icon: "scale", anyOf: ["bank.recon.manage"], group: "operate" },
  { key: "simulator", label: "bank.simulator", href: "/bank/simulator", icon: "flask", anyOf: ["bank.simulator.control"], group: "operate" },
  { key: "audit", label: "bank.audit", href: "/bank/audit", icon: "history", anyOf: ["bank.audit.read"], group: "operate" },
];

export function visibleNav(items: readonly NavItem[], permissions: ReadonlySet<string>): NavItem[] {
  return items.filter((item) => item.anyOf.length === 0 || item.anyOf.some((permission) => permissions.has(permission)));
}
