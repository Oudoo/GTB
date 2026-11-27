import { BatchDetailView } from "@/features/batches/batch-views";
import { requireCorporatePage } from "@/server/page";

export default async function Page({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ rows?: string }> }) {
  const { locale: localeParam, id } = await params;
  const { deps, ctx, locale } = await requireCorporatePage(localeParam);
  return <BatchDetailView kind="BULK" deps={deps} ctx={ctx} locale={locale} id={id} rowFilter={(await searchParams).rows} />;
}
