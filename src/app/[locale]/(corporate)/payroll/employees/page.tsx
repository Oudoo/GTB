import { getTranslations } from "next-intl/server";
import { Field, Input, Select, describe } from "@/components/ui/form";
import { Badge, Button, Callout, Card, CardHeader, Code, DataList, EmptyState, LinkButton, PageHeader, type Column } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status";
import { EmployeeAddForm, EmployeeEditForm } from "@/features/batches/client/employee-forms";
import { Forbidden, LoadError } from "@/features/common/states";
import { Link } from "@/i18n/navigation";
import { listEmployees, type EmployeeView } from "@/server/domain/payroll/employees";
import { can, load, requireCorporatePage } from "@/server/page";

const FILTERS = ["ACTIVE", "INACTIVE", "UNVERIFIED"] as const;
type Search = { search?: string; status?: string; cursor?: string };

/** Employee master: payroll officers only. Nobody else receives this page's content. */
export default async function EmployeesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "payroll.detail")) return <Forbidden />;
  const query = await searchParams;
  const status = FILTERS.find((entry) => entry === query.status);
  const search = query.search?.trim().slice(0, 80) ?? "";
  const result = await load(() => listEmployees(deps, ctx, { ...(search ? { search } : {}), ...(status ? { status } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), limit: 50 }));
  const nextHref = (cursor: string) => {
    const next = new URLSearchParams();
    if (search) next.set("search", search);
    if (status) next.set("status", status);
    next.set("cursor", cursor);
    return `/payroll/employees?${next.toString()}`;
  };
  const columns: Column<EmployeeView>[] = [
    {
      key: "code",
      header: t("payroll.employees.code"),
      primary: true,
      cell: (employee) => (
        <span>
          <Code>{employee.employeeCode}</Code> <bdi>{employee.name}</bdi>
        </span>
      ),
    },
    { key: "account", header: t("payroll.employees.account"), cell: (employee) => <Code>{employee.accountReference}</Code> },
    { key: "check", header: t("payroll.employees.check"), cell: (employee) => <StatusBadge family="match" state={employee.accountMatchStatus} /> },
    {
      key: "status",
      header: t("payroll.employees.status"),
      cell: (employee) => (
        <span className="flex flex-wrap gap-1.5" data-payable={employee.payable}>
          <Badge tone={employee.active ? "success" : "neutral"}>{employee.active ? t("payroll.employees.active") : t("payroll.employees.inactive")}</Badge>
          {!employee.payable ? <Badge tone="warning">{t("payroll.employees.notPayable")}</Badge> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t("payroll.employees.title")}
        description={t("payroll.employees.description")}
        back={
          <Link href="/payroll" className="text-accent hover:underline">
            ← {t("batches.payroll.title")}
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        <Card>
          <form method="get" className="grid grid-cols-1 gap-3 border-b border-border px-4 py-4 sm:grid-cols-3 sm:px-5">
            <Field id="search" label={t("payroll.employees.search")}>
              <Input {...describe("search", {})} name="search" defaultValue={search} maxLength={80} />
            </Field>
            <Field id="status" label={t("payroll.employees.filter")}>
              <Select {...describe("status", {})} name="status" defaultValue={status ?? ""}>
                <option value="">{t("payroll.employees.filterAll")}</option>
                {FILTERS.map((entry) => (
                  <option key={entry} value={entry}>
                    {t(`payroll.employees.filter${entry}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="secondary" className="w-full">
                {t("common.actions.filter")}
              </Button>
            </div>
          </form>
          {!result.ok ? (
            <div className="p-4">
              <LoadError code={result.code} />
            </div>
          ) : (
            <>
              <p className="border-b border-border px-4 py-3 text-sm text-muted sm:px-5" data-testid="employee-counts">
                {t("payroll.employees.counts", result.data.counts)}
              </p>
              <div data-testid="employee-list">
                <DataList
                  rows={result.data.items}
                  columns={columns}
                  rowKey={(employee) => employee.id}
                  caption={t("payroll.employees.caption")}
                  empty={<EmptyState title={t("payroll.employees.empty")} description={t("payroll.employees.emptyHint")} />}
                  action={(employee) => (
                    <details className="w-full max-w-xl text-start">
                      <summary className="min-touch inline-flex cursor-pointer items-center rounded-lg px-3 text-sm font-semibold text-accent" data-testid={`edit-${employee.employeeCode}`}>
                        {t("payroll.employees.edit")}
                      </summary>
                      <div className="mt-2 w-full rounded-lg border border-border p-3 md:min-w-[420px]">
                        <p className="mb-2 font-semibold">{t("payroll.employees.editTitle", { code: employee.employeeCode })}</p>
                        <EmployeeEditForm employee={employee} />
                      </div>
                    </details>
                  )}
                />
              </div>
              {result.data.nextCursor ? (
                <div className="border-t border-border p-4 text-center">
                  <LinkButton href={nextHref(result.data.nextCursor)} variant="secondary">
                    {t("common.actions.loadMore")}
                  </LinkButton>
                </div>
              ) : null}
            </>
          )}
        </Card>
        <Card>
          <CardHeader title={t("payroll.employees.addTitle")} />
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <EmployeeAddForm />
            <Callout tone="info">{t("payroll.employees.importDeferred")}</Callout>
          </div>
        </Card>
      </div>
    </>
  );
}
