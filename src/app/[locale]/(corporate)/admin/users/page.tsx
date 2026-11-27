import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, DataList, EmptyState, LinkButton, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { MemberStatusForm, UserChangeForm } from "@/features/admin/client/admin-forms";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { amountText } from "@/lib/format";
import { listLocalInbox, listUserProposals, listUsers, type UserProposalView, type UserView } from "@/server/domain/admin/service";
import { requireEffectivePolicy } from "@/server/domain/agreements/policy";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function AdminUsersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "admin.users.read")) return <Forbidden />;
  const mayPropose = can(ctx, "admin.users.propose");
  const maySuspend = can(ctx, "admin.users.suspend");
  const [members, proposals, inbox, policy] = await Promise.all([
    load(() => listUsers(deps, ctx)),
    load(() => listUserProposals(deps, ctx)),
    mayPropose ? load(() => listLocalInbox(deps, ctx)) : null,
    load(() => requireEffectivePolicy(deps.db, ctx.corporateId as string, deps.clock.now())),
  ]);
  if (!members.ok) return <LoadError code={members.code} />;
  // Only accounts the signed agreement links can be granted.
  const linked = policy.ok ? policy.data.terms.linkedAccounts : [];
  const accounts = (await deps.db.account.findMany({ where: { corporateId: ctx.corporateId as string, id: { in: linked } }, select: { id: true, name: true, nameAr: true, maskedNumber: true }, orderBy: { name: "asc" } })).map((account) => ({ id: account.id, label: `${locale === "ar" ? account.nameAr : account.name} · ${account.maskedNumber}` }));

  const columns: Column<UserView>[] = [
    {
      key: "name",
      header: t("admin.users.name"),
      primary: true,
      cell: (member) => (
        <span>
          <bdi>{member.name}</bdi> {member.isSelf ? <Badge tone="info">{t("admin.users.you")}</Badge> : null}
          <span className="block text-sm font-normal text-muted">
            <Code>{member.email}</Code>
          </span>
        </span>
      ),
    },
    { key: "roles", header: t("admin.users.roles"), cell: (member) => <span className="flex flex-wrap gap-1">{member.roles.map((role) => <Badge key={role}>{t(`admin.roles.${role as "MAKER"}`)}</Badge>)}</span> },
    { key: "status", header: t("admin.users.status"), cell: (member) => <StatusBadge family="membership" state={member.status} /> },
    { key: "accounts", header: t("admin.users.accounts"), cell: (member) => (member.grants.length === 0 ? "—" : member.grants.map((grant) => grant.maskedNumber).join(", ")) },
    {
      key: "limits",
      header: t("admin.users.limits"),
      cell: (member) => (member.limits ? <span data-testid={`limits-${member.email.split("@")[0]}`} data-per-item={member.limits.perItem.minor}>{t("admin.users.limitsValue", { perItem: amountText(member.limits.perItem), daily: amountText(member.limits.daily) })}</span> : t("admin.users.noLimits")),
    },
  ];
  const proposalColumns: Column<UserProposalView>[] = [
    { key: "target", header: t("admin.proposals.target"), primary: true, cell: (proposal) => <span><bdi>{proposal.target.name}</bdi> <Code>{proposal.target.email}</Code></span> },
    { key: "kind", header: t("admin.proposals.kind"), cell: (proposal) => t(`admin.proposals.kinds.${proposal.kind}`) },
    { key: "status", header: t("admin.proposals.status"), cell: (proposal) => <StatusBadge family="governance" state={proposal.status} /> },
    { key: "by", header: t("admin.proposals.by"), cell: (proposal) => <bdi>{proposal.proposedBy}</bdi> },
  ];

  return (
    <>
      <PageHeader title={t("admin.users.title")} description={t("admin.users.description")} />
      <div className="flex flex-col gap-4">
        {!mayPropose ? <Callout tone="info">{t("admin.users.readOnly")}</Callout> : null}
        <Card>
          <div data-testid="member-list">
            <DataList
              rows={members.data}
              columns={columns}
              rowKey={(member) => member.membershipId}
              caption={t("admin.users.caption")}
              empty={<EmptyState title={t("admin.users.caption")} />}
              action={(member) =>
                member.isSelf || (!mayPropose && !maySuspend) ? null : (
                  <details className="w-full max-w-xl text-start">
                    <summary className="min-touch inline-flex cursor-pointer items-center rounded-lg px-3 text-sm font-semibold text-accent" data-testid={`manage-${member.email.split("@")[0]}`}>
                      {t("common.actions.edit")}
                    </summary>
                    <div className="mt-2 flex w-full flex-col gap-5 rounded-lg border border-border p-3 md:min-w-[480px]">
                      {mayPropose && member.status === "ACTIVE" ? (
                        <UserChangeForm
                          mode="change"
                          accounts={accounts}
                          member={{ membershipId: member.membershipId, roles: member.roles, grants: member.grants.map((grant) => ({ accountId: grant.accountId, read: grant.read, debit: grant.debit, approve: grant.approve, report: grant.report })), perItem: member.limits ? amountText(member.limits.perItem).replaceAll(",", "") : "", daily: member.limits ? amountText(member.limits.daily).replaceAll(",", "") : "" }}
                        />
                      ) : null}
                      {(member.status === "ACTIVE" && maySuspend) || (member.status === "SUSPENDED" && mayPropose) ? <MemberStatusForm membershipId={member.membershipId} version={member.version} suspended={member.status === "SUSPENDED"} name={member.name} /> : null}
                    </div>
                  </details>
                )
              }
            />
          </div>
        </Card>
        <Card>
          <CardHeader title={t("admin.proposals.title")} />
          {proposals.ok ? (
            <div data-testid="proposal-list">
              <DataList
                rows={proposals.data}
                columns={proposalColumns}
                rowKey={(proposal) => proposal.id}
                caption={t("admin.proposals.caption")}
                empty={<EmptyState title={t("admin.proposals.empty")} />}
                action={(proposal) =>
                  proposal.approval && proposal.status === "PENDING_APPROVAL" ? (
                    <LinkButton href={`/approvals/${proposal.approval.id}`} variant="secondary" data-testid="review-user-change">
                      {t("admin.proposals.review")}
                    </LinkButton>
                  ) : null
                }
              />
            </div>
          ) : (
            <div className="p-4">
              <LoadError code={proposals.code} />
            </div>
          )}
        </Card>
        {mayPropose ? (
          <>
            <Card>
              <CardHeader title={t("admin.change.inviteTitle")} />
              <div className="p-4 sm:p-5">
                <UserChangeForm mode="invite" accounts={accounts} />
              </div>
            </Card>
            <Card>
              <CardHeader title={t("admin.inbox.title")} description={t("admin.inbox.help")} />
              {inbox?.ok && inbox.data.length > 0 ? (
                <ul className="divide-y divide-border" data-testid="local-inbox">
                  {inbox.data.map((message) => (
                    <li key={message.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5" data-email={message.toEmail}>
                      <Code>{message.toEmail}</Code>
                      {message.path ? (
                        <Link href={message.path} className="font-semibold text-accent underline" data-testid="invitation-link">
                          {t("admin.inbox.open")}
                        </Link>
                      ) : (
                        <span className="text-sm text-muted">{t("admin.inbox.used")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title={t("admin.inbox.empty")} />
              )}
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
