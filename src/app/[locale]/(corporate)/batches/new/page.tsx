import { BatchUploadView } from "@/features/batches/batch-views";
import { requireCorporatePage } from "@/server/page";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireCorporatePage((await params).locale);
  return <BatchUploadView kind="BULK" deps={deps} ctx={ctx} locale={locale} />;
}
