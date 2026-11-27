import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Badge, Callout, Card, CardHeader, Code, DataList, EmptyState, LinkButton, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { ageText, formatDateTime } from "@/lib/format";
import { getApproval, listApprovals, type ApprovalView } from "@/server/domain/approvals/service";
import { load, type WorkspacePage } from "@/server/page";
import { ApprovalSummaryDetail, ApprovalSummaryLine } from "./approval-summary";
import { DecisionForm } from "./client/decision-form";

/** Where the full record of a proposal's target lives, when the caller can open it. */
function targetHref(approval: ApprovalView, basePath: string): string | null {
  const summary = (approval.summary ?? {}) as { kind?: string; linkPath?: unknown };
  // A feature may name the page of its own record (locale-less, set by server code only).
  if (typeof summary.linkPath === "string" && summary.linkPath.startsWith("/") && !summary.linkPath.startsWith("//")) return summary.linkPath;
  if (approval.targetType === "payment") return `/payments/${approval.targetId}`;
  if (approval.targetType === "batch") return summary.kind === "PAYROLL" ? `/payroll/${approval.targetId}` : `/batches/${approval.targetId}`;
  if (approval.targetType === "agreementVersion") return `${basePath.replace(/\/approvals$/, "")}/agreement-versions/${approval.targetId}`;
  if (approval.targetType === "railParameter") return "/bank/rail-parameters";
  if (approval.targetType === "deposit") return `/bank/branch-approvals/${approval.targetId}`;
  return null;
}

export async function ApprovalsQueue({ page, basePath, title, description }: { page: WorkspacePage; basePath: string; title: string; description: string }) {
  const { deps, ctx, locale } = page;
  const t = await getTranslations({ locale });
  const [pending, decided] = await Promise.all([
    load(() => listApprovals(deps, ctx, { state: "PENDING", limit: 100 })),
    load(() => listApprovals(deps, ctx, { state: "DECIDED", limit: 10 })),
  ]);
  if (!pending.ok) return <LoadError code={pending.code} />;
  const now = deps.clock.now();

  const columns: Column<ApprovalView>[] = [
    { key: "what", header: t("corp.approvals.class"), primary: true, cell: (approval) => <ApprovalSummaryLine approval={approval} /> },
    { key: "amount", header: t("common.labels.amount"), numeric: true, cell: (approval) => (approval.amount ? <Money value={approval.amount} className="font-semibold" /> : "—") },
    {
      key: "count",
      header: t("corp.approvals.detail.counted"),
      cell: (approval) => (
        <span className="tabular">
          <bdi dir="ltr">
            {approval.approvalsCount}/{approval.requiredApprovals}
          </bdi>
        </span>
      ),
    },
    { key: "age", header: t("corp.approvals.age"), cell: (approval) => <time dateTime={approval.createdAt}>{ageText(approval.createdAt, now, locale)}</time> },
  ];
  const action = (approval: ApprovalView) => (
    <LinkButton href={`${basePath}/${approval.id}`} variant={approval.canAct ? "primary" : "secondary"} data-testid={approval.canAct ? "review-actionable" : "review-readonly"}>
      {approval.canAct ? t("corp.approvals.review") : t("common.actions.view")}
    </LinkButton>
  );
  const mine = pending.data.items.filter((approval) => approval.canAct);
  const others = pending.data.items.filter((approval) => !approval.canAct);

  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title={t("corp.approvals.mine")} />
          <DataList
            rows={mine}
            columns={columns}
            rowKey={(approval) => approval.id}
            caption={t("corp.approvals.mine")}
            action={action}
            empty={<EmptyState title={t("corp.approvals.empty")} description={t("corp.approvals.emptyHint")} />}
          />
        </Card>
        {others.length > 0 ? (
          <Card>
            <CardHeader title={t("corp.approvals.others")} />
            <DataList
              rows={others}
              columns={[
                ...columns,
                {
                  key: "why",
                  header: t("common.labels.status"),
                  // Tell the person WHY they cannot act, e.g. "you created this proposal".
                  cell: (approval) => <span className="text-sm text-muted">{approval.myVote ? t("corp.approvals.detail.alreadyVoted") : t(`types.eligibility.${approval.eligibility}`)}</span>,
                },
              ]}
              rowKey={(approval) => approval.id}
              caption={t("corp.approvals.others")}
              action={action}
              empty={null}
            />
          </Card>
        ) : null}
        {decided.ok && decided.data.items.length > 0 ? (
          <Card>
            <CardHeader title={t("corp.approvals.decided")} />
            <DataList
              rows={decided.data.items}
              columns={[...columns.slice(0, 2), { key: "state", header: t("common.labels.status"), cell: (approval) => <StatusBadge family="approval" state={approval.state} /> }]}
              rowKey={(approval) => approval.id}
              caption={t("corp.approvals.decided")}
              action={action}
              empty={null}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}

export async function ApprovalReview({ page, basePath, approvalId, extra }: { page: WorkspacePage; basePath: string; approvalId: string; extra?: ReactNode }) {
  const { deps, ctx, locale } = page;
  const t = await getTranslations({ locale });
  const result = await load(() => getApproval(deps, ctx, approvalId));
  if (!result.ok) return <LoadError code={result.code} />;
  const approval = result.data;
  const summary = (approval.summary ?? {}) as { kind?: string };
  const href = targetHref(approval, basePath);
  const remainingAfter = Math.max(0, approval.requiredApprovals - approval.approvalsCount - 1);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {t("corp.approvals.detail.title")}
            <StatusBadge family="approval" state={approval.state} />
          </span>
        }
        back={
          <Link href={basePath} className="text-accent hover:underline">
            ← {t("corp.approvals.title")}
          </Link>
        }
      />
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
        <Callout tone="info" role="note" testId="immutable-note">
          {t("corp.approvals.detail.immutable", {
            revision: approval.targetRevision,
            maker: approval.maker.name,
            when: formatDateTime(approval.createdAt, locale, deps.timeZone),
          })}
        </Callout>

        <Card>
          <CardHeader
            title={<ApprovalSummaryLine approval={approval} />}
            action={<Badge>{t(`types.approvalClass.${approval.klass}`)}</Badge>}
          />
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            {summary.kind === "PAYROLL" ? (
              <Callout tone="info" role="note" testId="payroll-aggregate-note">
                {t("corp.approvals.detail.payroll.aggregateNote")}
              </Callout>
            ) : null}
            <ApprovalSummaryDetail approval={approval} timeZone={deps.timeZone} />
            {extra}
            <dl className="grid grid-cols-1 gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">{t("corp.approvals.detail.counted")}</dt>
                <dd className="font-semibold" data-testid="approval-count">
                  <bdi dir="ltr">
                    {approval.approvalsCount} / {approval.requiredApprovals}
                  </bdi>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted">{t("corp.approvals.detail.digest")}</dt>
                <dd>
                  <Code className="text-xs">{approval.payloadHash}</Code>
                </dd>
              </div>
            </dl>
            {approval.votes.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {approval.votes.map((vote) => (
                  <li key={vote.personId} className="flex flex-wrap items-center gap-2">
                    <Badge tone={vote.decision === "APPROVE" ? "success" : "danger"}>{vote.decision === "APPROVE" ? t("common.actions.approve") : t("common.actions.reject")}</Badge>
                    {vote.name} · <time dateTime={vote.at}>{formatDateTime(vote.at, locale, deps.timeZone)}</time>
                    {vote.reason ? <bdi className="text-muted">— {vote.reason}</bdi> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {href ? (
              <p>
                <Link href={href} className="text-sm font-semibold text-accent hover:underline">
                  {t("corp.approvals.detail.openTarget")}
                </Link>
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title={t("corp.approvals.detail.decide")} />
          <div className="p-4 sm:p-5">
            {approval.state !== "PENDING" ? (
              <Callout tone="neutral" role="status" title={t("corp.approvals.detail.decidedTitle")} testId="decision-closed">
                <StatusBadge family="approval" state={approval.state} />
              </Callout>
            ) : approval.myVote ? (
              <Callout tone="info" role="status" testId="already-voted">{t("corp.approvals.detail.alreadyVoted")}</Callout>
            ) : approval.canAct ? (
              <DecisionForm
                approvalId={approval.id}
                version={approval.version}
                targetRevision={approval.targetRevision}
                payloadHash={approval.payloadHash}
                remainingAfterApprove={remainingAfter}
              />
            ) : (
              <Callout
                tone={approval.eligibility === "OWN_PROPOSAL" ? "warning" : "neutral"}
                role="status"
                title={approval.eligibility === "OWN_PROPOSAL" ? t("corp.approvals.detail.ownTitle") : t("corp.approvals.detail.readOnlyTitle")}
                testId="cannot-decide"
              >
                <span data-eligibility={approval.eligibility}>{t(`types.eligibility.${approval.eligibility}`)}</span>
              </Callout>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
