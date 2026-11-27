import { AuditTrail } from "@/features/audit/audit-page";
import { requireCorporatePage } from "@/server/page";

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await requireCorporatePage((await params).locale);
  return <AuditTrail page={page} basePath="/audit" searchParams={await searchParams} />;
}
