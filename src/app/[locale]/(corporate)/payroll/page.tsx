import { BatchListView } from "@/features/batches/batch-views";
import { requireCorporatePage } from "@/server/page";

export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  return <BatchListView kind="PAYROLL" deps={deps} ctx={ctx} locale={locale} cursor={(await searchParams).cursor} />;
}
