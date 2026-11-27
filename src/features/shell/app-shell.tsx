import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { SandboxPill } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { countActionable } from "@/server/domain/approvals/service";
import type { WorkspacePage } from "@/server/page";
import { load } from "@/server/page";
import { InstallAction } from "@/pwa/install-action";
import { LocaleSwitch, MobileDrawer, MobileTabBar, SidebarNav, SignOutButton, type ShellNavItem } from "./client/shell-client";
import { SessionGuard } from "./client/session-guard";
import { BANK_NAV, CORPORATE_NAV, visibleNav } from "./nav";

function Brand({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <span aria-hidden="true" className="grid size-9 place-items-center rounded-[10px] bg-white/10">
        <span className="block size-4 rounded-full border-[3px] border-[#5fc3cb] border-e-transparent" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-semibold text-white">{label}</span>
        <span className="block truncate text-xs text-white/65">{sub}</span>
      </span>
    </div>
  );
}

export async function AppShell({ page, children }: { page: WorkspacePage; children: ReactNode }) {
  const { ctx, session, deps, locale } = page;
  const t = await getTranslations({ locale });
  const bank = ctx.workspace === "BANK";
  const source = bank ? BANK_NAV : CORPORATE_NAV;
  const pending = await load(() => countActionable(deps, ctx));
  const pendingCount = pending.ok ? pending.data : 0;

  const items: ShellNavItem[] = visibleNav(source, ctx.permissions).map((item) => ({
    key: item.key,
    label: t(`nav.${item.label}` as Parameters<typeof t>[0]),
    href: item.href,
    icon: item.icon,
    group: item.group,
    ...(item.key === "approvals" && pendingCount > 0 ? { badge: pendingCount } : {}),
  }));
  const groups = (bank ? ["govern", "branch", "operate"] : ["cash", "pay", "collect", "control", "administer"]).map((key) => ({
    key,
    label: t(`nav.${bank ? "bank.groups" : "groups"}.${key}` as Parameters<typeof t>[0]),
  }));

  const membership = session.memberships.find((entry) => entry.id === ctx.membershipId);
  const arabic = locale === "ar";
  const contextName = bank
    ? ((arabic ? membership?.bankNameAr : membership?.bankName) ?? "")
    : ((arabic ? membership?.corporateNameAr : membership?.corporateName) ?? "");
  const personName = arabic ? (session.person.nameAr ?? session.person.name) : session.person.name;
  const home = bank ? "/bank" : "/dashboard";

  const byKey = (key: string) => items.find((item) => item.key === key);
  const tabs = bank
    ? []
    : [
        { ...(byKey("dashboard") as ShellNavItem), label: t("nav.home"), match: ["/dashboard"] },
        ...(byKey("payments") ? [{ ...(byKey("payments") as ShellNavItem), match: ["/payments", "/beneficiaries"] }] : []),
        ...(byKey("approvals") ? [{ ...(byKey("approvals") as ShellNavItem), match: ["/approvals"] }] : []),
        { key: "more", label: t("nav.more"), href: "/more", icon: "menu", group: "", match: ["/more"] },
      ];

  const sidebar = (
    <>
      <Brand label={t("common.brand.name")} sub={bank ? t("common.brand.bankWorkspace") : t("common.brand.product")} />
      <SidebarNav items={items} groups={groups} ariaLabel={t("common.a11y.mainNavigation")} />
    </>
  );

  return (
    <div className="min-h-dvh lg:ps-60" data-workspace={ctx.workspace}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:shadow"
      >
        {t("common.a11y.skipToContent")}
      </a>

      <aside className={`fixed inset-y-0 start-0 hidden w-60 flex-col overflow-y-auto lg:flex ${bank ? "bg-[#1b1f3a]" : "bg-nav"}`}>{sidebar}</aside>

      <header className={`pt-safe sticky top-0 z-40 border-b border-border ${bank ? "bg-[#1b1f3a] text-white lg:bg-surface lg:text-ink" : "bg-surface"}`}>
        <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:px-5">
          {bank ? (
            <MobileDrawer openLabel={t("common.a11y.openMenu")} closeLabel={t("common.a11y.closeMenu")}>
              {sidebar}
            </MobileDrawer>
          ) : null}
          <Link href={home} className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-semibold" data-testid="context-name">{contextName}</span>
            <span className={`block truncate text-xs ${bank ? "text-white/70 lg:text-muted" : "text-muted"}`}>
              {bank ? t("nav.context.bankWorkspace") : t("nav.context.corporateWorkspace")} · {personName}
            </span>
          </Link>
          <SandboxPill label={t("common.sandbox.label")} />
          <div className="hidden items-center gap-1 sm:flex">
            <InstallAction />
            <LocaleSwitch label={t("common.labels.language")} />
            {session.memberships.length > 1 ? (
              <Link href="/select-workspace" className="min-touch inline-flex items-center rounded-lg px-3 text-sm font-semibold hover:bg-canvas">
                {t("nav.context.switch")}
              </Link>
            ) : null}
            <SignOutButton />
          </div>
        </div>
      </header>

      <SessionGuard membershipId={ctx.membershipId ?? ""}>
        <main id="main" tabIndex={-1} className={`mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:py-7 ${bank ? "pb-10" : "mb-safe-nav lg:mb-0"}`}>
          {children}
        </main>
      </SessionGuard>

      {bank ? (
        <div className="pb-safe flex flex-wrap items-center justify-center gap-2 border-t border-border bg-surface px-4 py-3 sm:hidden">
          <LocaleSwitch label={t("common.labels.language")} />
          <SignOutButton />
        </div>
      ) : (
        <MobileTabBar tabs={tabs} ariaLabel={t("common.a11y.mobileNavigation")} />
      )}
    </div>
  );
}
