import { getTranslations } from "next-intl/server";
import { Callout, Code, DetailList, Money } from "@/components/ui/primitives";
import type { MoneyLike } from "@/lib/format";
import type { ApprovalView } from "@/server/domain/approvals/service";

type Summary = { change?: string; targetName?: string; targetEmail?: string; reason?: string; roles?: string; previousRoles?: string | null; accounts?: number; debitAccounts?: number; approveAccounts?: number; perItemLimit?: MoneyLike | null; dailyLimit?: MoneyLike | null };
type Loose = ((key: string) => string) & { has: (key: string) => boolean };

/** What an approver decides on for an access change: who, which roles, how many accounts, which allowance. */
export async function AdminApprovalSummary({ approval }: { approval: ApprovalView; timeZone: string }) {
  const t = await getTranslations();
  const loose = t as unknown as Loose;
  const summary = (approval.summary ?? {}) as Summary;
  const roleNames = (value: string | null | undefined) =>
    (value ?? "")
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean)
      .map((role) => (loose.has(`admin.roles.${role}`) ? loose(`admin.roles.${role}`) : role))
      .join("، ") || "—";
  const kindKey = `admin.proposals.kinds.${summary.change ?? ""}`;
  return (
    <div className="flex flex-col gap-4" data-testid="admin-approval-summary" data-change={summary.change ?? ""}>
      <DetailList
        items={[
          { label: t("admin.approval.member"), value: <span><bdi>{summary.targetName}</bdi> <Code>{summary.targetEmail ?? ""}</Code></span>, wide: true, testId: "change-member" },
          { label: t("admin.approval.change"), value: loose.has(kindKey) ? loose(kindKey) : (summary.change ?? "") },
          ...(summary.roles !== undefined
            ? [
                { label: t("admin.approval.roles"), value: roleNames(summary.roles), testId: "change-roles" },
                ...(summary.previousRoles ? [{ label: t("admin.approval.previousRoles"), value: roleNames(summary.previousRoles) }] : []),
                { label: t("admin.approval.accounts"), value: summary.accounts ?? 0 },
                { label: t("admin.approval.debitAccounts"), value: summary.debitAccounts ?? 0 },
                { label: t("admin.approval.approveAccounts"), value: summary.approveAccounts ?? 0 },
                { label: t("admin.approval.perItemLimit"), value: summary.perItemLimit ? <Money value={summary.perItemLimit} /> : t("admin.users.noLimits"), testId: "change-per-item" },
                { label: t("admin.approval.dailyLimit"), value: summary.dailyLimit ? <Money value={summary.dailyLimit} /> : t("admin.users.noLimits") },
              ]
            : []),
          { label: t("admin.approval.reason"), value: <bdi>{summary.reason}</bdi>, wide: true },
        ]}
      />
      <Callout tone="info">{t("admin.approval.note")}</Callout>
    </div>
  );
}
