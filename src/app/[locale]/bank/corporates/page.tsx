import { getTranslations } from "next-intl/server";
import { Badge, Card, DataList, EmptyState, LinkButton, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { Forbidden, LoadError } from "@/features/common/states";
import { listBankCorporates, type BankCorporateRow } from "@/server/domain/agreements/service";
import { can, load, requireBankPage } from "@/server/page";

export default async function BankCorporatesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.corporates.read")) return <Forbidden />;
  const result = await load(() => listBankCorporates(deps, ctx));
  if (!result.ok) return <LoadError code={result.code} />;

  const columns: Column<BankCorporateRow>[] = [
    {
      key: "name",
      header: t("common.labels.corporate"),
      primary: true,
      cell: (row) => <bdi>{locale === "ar" ? row.legalNameAr : row.legalName}</bdi>,
    },
    { key: "segment", header: t("corp.agreement.segment"), cell: (row) => t(`types.segment.${row.segment}` as Parameters<typeof t>[0]) },
    {
      key: "agreement",
      header: t("bank.corporates.agreement"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge family="agreement" state={row.state === "NO_AGREEMENT" ? "DRAFT" : row.state} />
          {row.pendingProposal ? <Badge tone="warning">{t("bank.corporates.pendingProposal")}</Badge> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t("bank.corporates.title")} description={t("bank.corporates.description")} />
      <Card>
        <DataList
          rows={result.data}
          columns={columns}
          rowKey={(row) => row.id}
          caption={t("bank.corporates.title")}
          empty={<EmptyState title={t("bank.corporates.empty")} />}
          action={(row) => (
            <LinkButton variant="secondary" href={`/bank/corporates/${row.id}/agreement`} data-testid={`open-agreement-${row.id}`}>
              {t("bank.corporates.open")}
            </LinkButton>
          )}
        />
      </Card>
    </>
  );
}
