import type { ReactNode } from "react";
import { AppShell } from "@/features/shell/app-shell";
import { requireBankPage } from "@/server/page";

// Authenticated workspace: rendered per request, never statically cached.
export const dynamic = "force-dynamic";

export default async function BankLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const page = await requireBankPage((await params).locale);
  return <AppShell page={page}>{children}</AppShell>;
}
