import { getLocale, getTranslations } from "next-intl/server";
import { Badge, Callout, Code, DetailList, Money } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { formatDateTime, moneyText, type MoneyLike } from "@/lib/format";
import { AdminApprovalSummary } from "@/features/admin/approval-summary";
import { BatchApprovalSummary } from "@/features/batches/approval-summary";
import { RepairApprovalSummary } from "@/features/operations/approval-summary";
import { DepositApprovalSummary } from "@/features/teller/approval-summary";
import type { ApprovalView } from "@/server/domain/approvals/service";
import { SummaryFields } from "./summary-fields";

type Summary = Record<string, unknown> & { kind?: string };
const asMoney = (value: unknown): MoneyLike | null =>
  value && typeof value === "object" && "minor" in value && "currency" in value ? (value as MoneyLike) : null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** One-line identification of a proposal for queues. Never contains payroll row detail. */
export async function ApprovalSummaryLine({ approval }: { approval: ApprovalView }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const summary = (approval.summary ?? {}) as Summary;
  const klass = t(`types.approvalClass.${approval.klass}` as Parameters<typeof t>[0]);
  let title = klass;
  let detail = "";
  if (summary.kind === "PAYMENT") {
    title = `${klass} ${text(summary.reference)}`;
    detail = text((summary.destination as Summary | undefined)?.["name"]);
  } else if (summary.kind === "AGREEMENT_VERSION" || summary.kind === "AGREEMENT_RESTORE") {
    title = `${klass} — ${locale === "ar" ? text(summary.corporateNameAr) : text(summary.corporateName)}`;
    detail = text(summary.changeReason) || text(summary.reason);
  } else if (summary.kind === "RAIL_PARAMETER") {
    title = `${klass} — ${t(`types.rail.${text(summary.rail)}` as Parameters<typeof t>[0])}`;
    detail = text(summary.changeReason);
  } else if (typeof summary.reference === "string") {
    title = `${klass} ${summary.reference}`;
    detail = text(summary.title);
  }
  return (
    <>
      <p className="font-semibold">
        <bdi>{title}</bdi>
      </p>
      <p className="truncate text-sm text-muted">
        {detail ? <bdi>{detail}</bdi> : null}
        {detail ? " · " : ""}
        {approval.maker.name}
      </p>
    </>
  );
}

/**
 * The immutable content a checker authorizes. For payments the order follows MOB-04: maker,
 * exact amount and fee, account, beneficiary, purpose, schedule, policy and quorum — with the
 * totals always visible, never inside a collapsed section.
 */
export async function ApprovalSummaryDetail({ approval, timeZone }: { approval: ApprovalView; timeZone: string }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const summary = (approval.summary ?? {}) as Summary;

  if (summary.kind === "PAYMENT") {
    const destination = (summary.destination ?? {}) as Summary;
    const source = (summary.sourceAccount ?? {}) as Summary;
    const amount = asMoney(summary.amount);
    const fee = asMoney(summary.fee);
    const total = asMoney(summary.totalDebit);
    const previousFee = asMoney(summary.previousFee);
    return (
      <div className="flex flex-col gap-4">
        {previousFee ? (
          <Callout tone="warning" title={t("corp.payments.detail.reapprovalTitle")} testId="reapproval-note">
            <bdi>{t("corp.approvals.detail.reapproval", { previous: moneyText(previousFee) })}</bdi>
          </Callout>
        ) : null}
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-canvas p-4 sm:grid-cols-3">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.amount")}</p>
            <p className="text-xl font-semibold" data-testid="review-amount">{amount ? <Money value={amount} /> : null}</p>
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.fee")}</p>
            <p className="text-xl font-semibold" data-testid="review-fee">{fee ? <Money value={fee} /> : null}</p>
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">{t("common.labels.totalDebit")}</p>
            <p className="text-xl font-semibold" data-testid="review-total">{total ? <Money value={total} /> : null}</p>
          </div>
        </div>
        <DetailList
          items={[
            {
              label: t("corp.payments.recipient"),
              testId: "review-recipient",
              value: (
                <>
                  <span className="font-semibold">{text(destination.name)}</span>
                  <span className="block text-sm text-muted">
                    <Code>{text(destination.maskedReference)}</Code>
                    {destination.bankName ? ` · ${text(destination.bankName)}` : ""}
                  </span>
                  {destination.matchStatus ? (
                    <span className="mt-1 inline-flex flex-wrap items-center gap-2">
                      <StatusBadge family="match" state={text(destination.matchStatus)} />
                      {destination.closeMatchAcknowledged ? <Badge tone="warning">{t("corp.payments.wizard.acknowledgeCloseMatch")}</Badge> : null}
                    </span>
                  ) : null}
                </>
              ),
            },
            {
              label: t("corp.payments.source"),
              value: (
                <>
                  {locale === "ar" ? text(source.nameAr) : text(source.name)}
                  <span className="block text-sm text-muted">
                    <Code>{text(source.maskedNumber)}</Code>
                  </span>
                </>
              ),
            },
            { label: t("common.labels.type"), value: t(`types.transactionType.${text(summary.transactionType)}` as Parameters<typeof t>[0]) },
            { label: t("common.labels.rail"), value: t(`types.rail.${text(summary.rail)}` as Parameters<typeof t>[0]) },
            { label: t("common.labels.purpose"), value: <bdi>{text(summary.purpose)}</bdi>, wide: true },
            {
              label: t("corp.payments.executeAt"),
              value: summary.executeAt
                ? `${formatDateTime(text(summary.executeAt), locale, timeZone)} · ${t("common.labels.bankTime", { zone: timeZone })}`
                : t("corp.payments.immediate"),
            },
            { label: t("common.labels.reference"), value: <Code>{text(summary.reference)}</Code> },
          ]}
        />
      </div>
    );
  }

  if (summary.kind === "AGREEMENT_VERSION") {
    return (
      <DetailList
        items={[
          { label: t("common.labels.corporate"), value: locale === "ar" ? text(summary.corporateNameAr) : text(summary.corporateName) },
          { label: t("common.labels.version"), value: String(summary.versionNo ?? "") },
          {
            label: t("corp.agreement.validity"),
            wide: true,
            value: t("corp.agreement.validityRange", {
              from: formatDateTime(text(summary.effectiveFrom), locale, timeZone),
              until: formatDateTime(text(summary.effectiveUntil), locale, timeZone),
            }),
          },
          { label: t("common.labels.reason"), value: <bdi>{text(summary.changeReason)}</bdi>, wide: true },
          { label: t("corp.agreement.modules"), value: <Code>{Array.isArray(summary.modules) ? summary.modules.join(", ") : ""}</Code>, wide: true },
        ]}
      />
    );
  }

  if (summary.kind === "RAIL_PARAMETER") {
    const ceiling = asMoney(summary.ceiling);
    const previous = asMoney(summary.previousCeiling);
    return (
      <DetailList
        items={[
          { label: t("common.labels.rail"), value: t(`types.rail.${text(summary.rail)}` as Parameters<typeof t>[0]) },
          { label: t("corp.limits.ceiling"), value: ceiling ? <Money value={ceiling} /> : t("corp.limits.railBlocked") },
          { label: `${t("corp.limits.ceiling")} (${t("common.labels.from")})`, value: previous ? <Money value={previous} /> : t("corp.limits.railBlocked") },
          { label: t("common.labels.status"), value: t(`types.provenance.${text(summary.provenance)}` as Parameters<typeof t>[0]) },
          { label: t("common.labels.reason"), value: <bdi>{text(summary.changeReason)}</bdi>, wide: true },
        ]}
      />
    );
  }

  if (summary.kind === "AGREEMENT_RESTORE") {
    return (
      <DetailList
        items={[
          { label: t("common.labels.corporate"), value: locale === "ar" ? text(summary.corporateNameAr) : text(summary.corporateName) },
          { label: t("common.labels.reason"), value: <bdi>{text(summary.reason)}</bdi>, wide: true },
        ]}
      />
    );
  }

  // Each remaining proposal class renders its own REDACTED summary from its feature folder.
  if (approval.klass === "BULK" || approval.klass === "PAYROLL") return <BatchApprovalSummary approval={approval} timeZone={timeZone} />;
  if (approval.klass === "CORPORATE_ADMIN") return <AdminApprovalSummary approval={approval} timeZone={timeZone} />;
  if (approval.klass === "BRANCH_DEPOSIT") return <DepositApprovalSummary approval={approval} timeZone={timeZone} />;
  if (approval.klass === "BANK_REPAIR") return <RepairApprovalSummary approval={approval} timeZone={timeZone} />;
  return <SummaryFields summary={summary} />;
}
