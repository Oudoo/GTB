import { AuditTrail } from "@/features/audit/audit-page";
import { requireBankPage } from "@/server/page";

export default async function BankAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await requireBankPage((await params).locale);
  return <AuditTrail page={page} basePath="/bank/audit" searchParams={await searchParams} />;
}
