/**
 * Corporate dashboard read model. Everything is scoped to the caller's grants and permissions;
 * payroll appears only as aggregates elsewhere and never here as row detail.
 */
import { hasPermission, requireBank, requireCorporate, type AuthContext } from "@/server/auth/context";
import type { Deps } from "@/server/deps";
import { listAccounts, type AccountView } from "@/server/domain/accounts/service";
import { loadAgreementStatus, type AgreementState } from "@/server/domain/agreements/policy";
import { listApprovals, type ApprovalView } from "@/server/domain/approvals/service";
import { listPayments, type PaymentView } from "@/server/domain/payments/service";
import { queueDiagnostics, type QueueDiagnostics } from "@/server/jobs/queue";

export type DashboardView = {
  agreementState: AgreementState;
  accounts: AccountView[] | null;
  approvals: { actionable: ApprovalView[]; actionableCount: number } | null;
  scheduled: PaymentView[] | null;
  recent: PaymentView[] | null;
  attention: PaymentView[] | null;
  unreadAlerts: number;
  asOf: string;
};

export async function getDashboard(deps: Deps, ctx: AuthContext): Promise<DashboardView> {
  const corporateCtx = requireCorporate(ctx);
  const status = await loadAgreementStatus(deps.db, corporateCtx.corporateId, deps.clock.now());
  const canPayments = hasPermission(corporateCtx, "payments.read");

  const accounts = hasPermission(corporateCtx, "accounts.read") ? await listAccounts(deps, corporateCtx) : null;
  const queue = await listApprovals(deps, corporateCtx, { state: "PENDING", limit: 50 });
  const actionable = queue.items.filter((item) => item.canAct);

  let scheduled: PaymentView[] | null = null;
  let recent: PaymentView[] | null = null;
  let attention: PaymentView[] | null = null;
  if (canPayments) {
    scheduled = (await listPayments(deps, corporateCtx, { state: "SCHEDULED", limit: 5 })).items;
    recent = (await listPayments(deps, corporateCtx, { limit: 5 })).items;
    const unknown = (await listPayments(deps, corporateCtx, { state: "STATUS_UNKNOWN", limit: 5 })).items;
    const blocked = (await listPayments(deps, corporateCtx, { state: "APPROVED", limit: 5 })).items.filter((payment) => payment.releaseBlockCode !== null);
    attention = [...unknown, ...blocked];
  }
  const unreadAlerts =
    corporateCtx.principal.kind === "person"
      ? await deps.db.notification.count({
          where: { recipientPersonId: corporateCtx.principal.personId, corporateId: corporateCtx.corporateId, readAt: null },
        })
      : 0;

  return {
    agreementState: status.state,
    accounts,
    approvals: { actionable: actionable.slice(0, 5), actionableCount: actionable.length },
    scheduled,
    recent,
    attention,
    unreadAlerts,
    asOf: deps.clock.now().toISOString(),
  };
}

export type BankOverviewView = {
  bank: { code: string; name: string; nameAr: string };
  branch: { code: string; name: string; nameAr: string } | null;
  /** Null when the role cannot read corporates (e.g. a teller). */
  corporates: { total: number; byState: Array<{ state: AgreementState; count: number }> } | null;
  approvals: { actionable: ApprovalView[]; actionableCount: number };
  /** Null when the role has no operations access. */
  worker: { lastSeenAt: string | null; healthy: boolean; queue: QueueDiagnostics } | null;
  asOf: string;
};

/** A worker is considered healthy when it reported within this many seconds. */
export const WORKER_HEALTHY_SECONDS = 30;

/** Landing page of the bank workspace. Each block appears only with its own permission. */
export async function getBankOverview(deps: Deps, ctx: AuthContext): Promise<BankOverviewView> {
  const bankCtx = requireBank(ctx);
  const now = deps.clock.now();
  const bank = await deps.db.bank.findUniqueOrThrow({ where: { id: bankCtx.bankId } });
  const branch = bankCtx.branchId ? await deps.db.branch.findFirst({ where: { id: bankCtx.branchId, bankId: bankCtx.bankId } }) : null;

  let corporates: BankOverviewView["corporates"] = null;
  if (hasPermission(bankCtx, "bank.corporates.read")) {
    const rows = await deps.db.corporate.findMany({ where: { bankId: bankCtx.bankId }, select: { id: true } });
    const counts = new Map<AgreementState, number>();
    for (const row of rows) {
      const status = await loadAgreementStatus(deps.db, row.id, now);
      counts.set(status.state, (counts.get(status.state) ?? 0) + 1);
    }
    corporates = { total: rows.length, byState: [...counts.entries()].map(([state, count]) => ({ state, count })) };
  }

  const queue = await listApprovals(deps, bankCtx, { state: "PENDING", limit: 50 });
  const actionable = queue.items.filter((item) => item.canAct);

  let worker: BankOverviewView["worker"] = null;
  if (hasPermission(bankCtx, "bank.operations.read")) {
    // The heartbeat is wall-clock liveness of a process, independent of the sandbox clock.
    const heartbeat = await deps.db.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: "desc" } });
    const wallNow = Date.now();
    worker = {
      lastSeenAt: heartbeat?.lastSeenAt.toISOString() ?? null,
      healthy: heartbeat ? wallNow - heartbeat.lastSeenAt.getTime() <= WORKER_HEALTHY_SECONDS * 1000 : false,
      queue: await queueDiagnostics(deps.db, now),
    };
  }

  return {
    bank: { code: bank.code, name: bank.name, nameAr: bank.nameAr },
    branch: branch ? { code: branch.code, name: branch.name, nameAr: branch.nameAr } : null,
    corporates,
    approvals: { actionable: actionable.slice(0, 5), actionableCount: actionable.length },
    worker,
    asOf: now.toISOString(),
  };
}
