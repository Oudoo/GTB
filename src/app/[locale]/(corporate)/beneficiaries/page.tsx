import { getTranslations } from "next-intl/server";
import { CommandButton } from "@/components/command";
import { Badge, Callout, Card, Code, DataList, EmptyState, LinkButton, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { Forbidden, LoadError } from "@/features/common/states";
import { BeneficiaryForm } from "@/features/payments/client/beneficiary-form";
import { listBeneficiaries, type BeneficiaryView } from "@/server/domain/payments/beneficiaries";
import { can, load, requireCorporatePage } from "@/server/page";

export default async function BeneficiariesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const { archived } = await searchParams;
  const t = await getTranslations({ locale });
  if (!can(ctx, "beneficiaries.read")) return <Forbidden />;
  const includeArchived = archived === "1";
  const result = await load(() => listBeneficiaries(deps, ctx, { includeArchived, limit: 100 }));
  const manage = can(ctx, "beneficiaries.manage");

  const columns: Column<BeneficiaryView>[] = [
    {
      key: "name",
      header: t("corp.beneficiaries.name"),
      primary: true,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <bdi>{row.displayName}</bdi>
          {row.archived ? <Badge>{t("corp.beneficiaries.archived")}</Badge> : null}
        </span>
      ),
    },
    {
      key: "account",
      header: t("corp.beneficiaries.account"),
      cell: (row) => (
        <span>
          <Code>{row.maskedReference}</Code>
          {row.bankName ? <span className="block text-xs text-muted">{row.bankName}</span> : null}
        </span>
      ),
    },
    { key: "check", header: t("corp.beneficiaries.nameCheck"), cell: (row) => <StatusBadge family="match" state={row.matchStatus} /> },
  ];

  return (
    <>
      <PageHeader title={t("corp.beneficiaries.title")} description={t("corp.beneficiaries.description")} />
      <div className="flex flex-col gap-4">
        {manage ? <BeneficiaryForm /> : null}
        <Callout tone="sandbox" role="note">{t("corp.beneficiaries.scenarioNote")}</Callout>
        <Card>
          {!result.ok ? (
            <div className="p-4">
              <LoadError code={result.code} />
            </div>
          ) : (
            <DataList
              rows={result.data.items}
              columns={columns}
              rowKey={(row) => row.id}
              caption={t("corp.beneficiaries.title")}
              empty={<EmptyState title={t("corp.beneficiaries.empty")} description={manage ? t("corp.beneficiaries.emptyHint") : undefined} />}
              action={
                manage
                  ? (row) =>
                      row.archived ? null : (
                        <CommandButton path={`/beneficiaries/${row.id}/archive`} ifMatch={row.version} variant="secondary">
                          {t("corp.beneficiaries.archive")}
                        </CommandButton>
                      )
                  : undefined
              }
            />
          )}
          <div className="border-t border-border p-3 text-center">
            <LinkButton href={includeArchived ? "/beneficiaries" : "/beneficiaries?archived=1"} variant="ghost">
              {includeArchived ? t("common.actions.clear") : t("corp.beneficiaries.showArchived")}
            </LinkButton>
          </div>
        </Card>
      </div>
    </>
  );
}
