import { getTranslations } from "next-intl/server";
import { Field, Input, describe } from "@/components/ui/form";
import { Badge, Button, Card, Code, DataList, EmptyState, LinkButton, Money, PageHeader, type Column } from "@/components/ui/primitives";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { ageText } from "@/lib/format";
import { executionQuerySchema, listExecutions, type ExecutionView } from "@/server/domain/operations/service";
import { can, load, requireBankPage } from "@/server/page";

const CATEGORIES = ["ATTENTION", "UNKNOWN", "OVERDUE", "FAILED", "ALL"] as const;
const LABEL = { ATTENTION: "attention", UNKNOWN: "unknown", OVERDUE: "overdue", FAILED: "failed", ALL: "all" } as const;
const TONE = { UNKNOWN: "warning", FAILED: "danger", OVERDUE: "warning", IN_FLIGHT: "info", BOOKED: "success" } as const;

export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.operations.read")) return <Forbidden />;
  const raw = await searchParams;
  const single = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]).filter(([, value]) => typeof value === "string" && value !== ""));
  const parsed = executionQuerySchema.safeParse(single);
  const query = parsed.success ? parsed.data : {};
  const result = await load(() => listExecutions(deps, ctx, { ...query, limit: 50 }));
  if (!result.ok) return <LoadError code={result.code} />;
  const { items, counts, nextCursor } = result.data;
  const category = query.category ?? "ATTENTION";
  const now = new Date();

  const columns: Column<ExecutionView>[] = [
    {
      key: "execution",
      header: t("ops.queue.execution"),
      primary: true,
      cell: (row) => (
        <span data-execution={row.executionReference}>
          <Code className="text-xs">{row.executionReference}</Code>
          <span className="block text-sm text-muted">
            <bdi>{locale === "ar" ? row.corporate.nameAr : row.corporate.name}</bdi>
            {row.instruction.reference ? <> · <Code>{row.instruction.reference}</Code></> : null}
          </span>
        </span>
      ),
    },
    {
      key: "amount",
      header: t("common.labels.amount"),
      numeric: true,
      cell: (row) => (row.instruction.amount ? <Money value={row.instruction.amount} /> : <span className="text-sm text-muted">{t("ops.queue.masked")}</span>),
    },
    { key: "rail", header: t("common.labels.rail"), cell: (row) => t(`types.rail.${row.instruction.rail}` as Parameters<typeof t>[0]) },
    {
      key: "state",
      header: t("ops.queue.state"),
      cell: (row) => (
        <span data-state={row.state} data-category={row.category}>
          <Badge tone={TONE[row.category]}>{t(`ops.state.${row.state}`)}</Badge>
          {row.failureCode ? <Code className="ms-2 text-xs">{row.failureCode}</Code> : null}
        </span>
      ),
    },
    {
      key: "inquiry",
      header: t("ops.queue.lastInquiry"),
      cell: (row) =>
        row.lastInquiryAt ? (
          <>
            {ageText(row.lastInquiryAt, now, locale)} · <Code className="text-xs">{row.lastInquiryResult}</Code>
          </>
        ) : (
          <span className="text-muted">{t("ops.queue.never")}</span>
        ),
    },
  ];

  const carry = new URLSearchParams();
  if (category !== "ATTENTION") carry.set("category", category);
  if (query.reference) carry.set("reference", query.reference);
  const next = new URLSearchParams(carry);
  if (nextCursor) next.set("cursor", nextCursor);

  return (
    <>
      <PageHeader title={t("ops.queue.title")} description={t("ops.queue.description")} />
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-3 gap-3" data-testid="ops-counts">
          {(["unknown", "overdue", "failed"] as const).map((key) => (
            <Card key={key} className="p-4">
              <p className="text-sm text-muted">{t(`ops.queue.${key}`)}</p>
              <p className="tabular text-2xl font-semibold" data-count={key}>{counts[key]}</p>
            </Card>
          ))}
        </div>
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <nav className="flex flex-wrap gap-2" aria-label={t("ops.queue.filter")}>
            {CATEGORIES.map((entry) => (
              <LinkButton key={entry} href={entry === "ATTENTION" ? "/bank/operations" : `/bank/operations?category=${entry}`} variant={entry === category ? "primary" : "secondary"} aria-current={entry === category ? "page" : undefined}>
                {t(`ops.queue.${LABEL[entry]}`)}
              </LinkButton>
            ))}
          </nav>
          <form method="get" className="flex flex-wrap items-end gap-3">
            {category !== "ATTENTION" ? <input type="hidden" name="category" value={category} /> : null}
            <Field id="reference" label={t("ops.queue.search")} className="min-w-[16rem] flex-1">
              <Input {...describe("reference", {})} name="reference" defaultValue={query.reference ?? ""} dir="ltr" maxLength={64} autoComplete="off" />
            </Field>
            <Button type="submit">{t("common.actions.search")}</Button>
          </form>
        </Card>
        <Card data-testid="ops-queue">
          <DataList
            rows={items}
            columns={columns}
            rowKey={(row) => row.id}
            caption={t("ops.queue.title")}
            empty={<EmptyState title={t("ops.queue.empty")} />}
            action={(row) => (
              <LinkButton variant="secondary" href={`/bank/operations/${row.id}`} data-testid="open-execution">
                {t("ops.queue.open")}
              </LinkButton>
            )}
          />
        </Card>
        {nextCursor ? (
          <div>
            <Link href={`/bank/operations?${next.toString()}`} className="font-semibold text-accent hover:underline">
              {t("common.actions.loadMore")}
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
