import type { ReactNode } from "react";
import { AppShell } from "@/features/shell/app-shell";
import { requireCorporatePage } from "@/server/page";

// Authenticated workspace: rendered per request, never statically cached.
export const dynamic = "force-dynamic";

export default async function CorporateLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const page = await requireCorporatePage((await params).locale);
  return <AppShell page={page}>{children}</AppShell>;
}
