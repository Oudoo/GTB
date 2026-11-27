import { getLocale, getTranslations } from "next-intl/server";
import { Code, DataList, Money, type Column } from "@/components/ui/primitives";
import type { TermsChange } from "@/server/domain/agreements/service";

type AccountInfo = { id: string; name: string; nameAr: string; maskedNumber: string };

const MINOR_PATH = /(^|\.)(minor|[A-Za-z]*Minor)$/;
const DIGITS = /^(0|[1-9][0-9]{0,15})$/;

/**
 * Field-level differences between two immutable revisions. Amounts are shown as exact LYD
 * values, account identifiers as the corporate's own account labels, and an absent value as
 * an explicit dash — so "removed" is never confused with "zero".
 */
export async function TermsDiff({ changes, accounts }: { changes: TermsChange[]; accounts: AccountInfo[] }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const accountLabels = new Map(accounts.map((account) => [account.id, `${locale === "ar" ? account.nameAr : account.name} (${account.maskedNumber})`]));

  const pathText = (path: string) => {
    let text = path;
    for (const [id, label] of accountLabels) text = text.replaceAll(id, label);
    return text;
  };
  const value = (path: string, raw: string | null) => {
    if (raw === null) return <span className="text-muted">—</span>;
    if (MINOR_PATH.test(path) && DIGITS.test(raw)) return <Money value={{ currency: "LYD", minor: raw }} />;
    const account = accountLabels.get(raw);
    if (account) return <bdi>{account}</bdi>;
    if (raw === "true") return <span>✓</span>;
    return <Code>{raw}</Code>;
  };

  const columns: Column<TermsChange>[] = [
    { key: "path", header: t("bank.diff.path"), primary: true, cell: (change) => <Code className="text-xs">{pathText(change.path)}</Code> },
    { key: "before", header: t("bank.diff.before"), cell: (change) => <span data-before>{value(change.path, change.before)}</span> },
    { key: "after", header: t("bank.diff.after"), cell: (change) => <span data-after className="font-semibold">{value(change.path, change.after)}</span> },
  ];
  return <DataList rows={changes} columns={columns} rowKey={(change) => change.path} caption={t("bank.diff.path")} empty={null} />;
}
