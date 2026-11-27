"use client";

import { clsx } from "clsx";
import {
  Activity,
  Banknote,
  Bell,
  Building2,
  Check,
  Code2,
  Contact,
  FileText,
  FlaskConical,
  Gauge,
  Grid3x3,
  History,
  Home,
  Inbox,
  Layers,
  LogOut,
  Menu,
  Scale,
  ScrollText,
  Send,
  Shield,
  SlidersHorizontal,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api-client";
import { broadcastSession } from "./session-guard";

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  wallet: Wallet,
  gauge: Gauge,
  bell: Bell,
  send: Send,
  users: Users,
  layers: Layers,
  banknote: Banknote,
  check: Check,
  contact: Contact,
  inbox: Inbox,
  file: FileText,
  scroll: ScrollText,
  history: History,
  grid: Grid3x3,
  shield: Shield,
  sliders: SlidersHorizontal,
  code: Code2,
  building: Building2,
  activity: Activity,
  scale: Scale,
  flask: FlaskConical,
  menu: Menu,
};

export type ShellNavItem = { key: string; label: string; href: string; icon: string; group: string; badge?: number };

function isActive(pathname: string, href: string): boolean {
  if (href === "/bank" || href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({ items, groups, ariaLabel }: { items: ShellNavItem[]; groups: Array<{ key: string; label: string }>; ariaLabel: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={ariaLabel} className="flex flex-col gap-5 px-3 py-4">
      {groups.map((group) => {
        const members = items.filter((item) => item.group === group.key);
        if (members.length === 0) return null;
        return (
          <div key={group.key}>
            <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-white/55 uppercase">{group.label}</p>
            <ul className="flex flex-col gap-0.5">
              {members.map((item) => {
                const Icon = ICONS[item.icon] ?? Home;
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={clsx(
                        "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-white/85 hover:bg-white/10 hover:text-white",
                        active && "bg-white/15 text-white",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-[18px] shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge ? (
                        <span className="rounded-full bg-warning-soft px-2 text-xs font-bold text-warning" data-testid={`nav-badge-${item.key}`}>
                          {item.badge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** The four persistent phone destinations: Home, Payments, Approvals, More (MOB-03). */
export function MobileTabBar({ tabs, ariaLabel }: { tabs: Array<ShellNavItem & { match: string[] }>; ariaLabel: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={ariaLabel} className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface lg:hidden" data-testid="mobile-tabbar">
      <ul className="mx-auto grid max-w-xl" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((tab) => {
          const Icon = ICONS[tab.icon] ?? Home;
          const active = tab.match.some((prefix) => isActive(pathname, prefix));
          return (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={clsx("relative flex min-h-16 flex-col items-center justify-center gap-0.5 px-1 text-xs font-semibold", active ? "text-accent" : "text-muted")}
              >
                <Icon aria-hidden="true" className="size-5" />
                <span className="max-w-full truncate">{tab.label}</span>
                {tab.badge ? (
                  <span className="absolute end-[22%] top-2 rounded-full bg-warning px-1.5 text-[10px] font-bold text-white">
                    <span className="sr-only">: </span>
                    {tab.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function LocaleSwitch({ label }: { label: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const other = locale === "ar" ? "en" : "ar";
  return (
    <Link
      href={pathname}
      locale={other}
      lang={other}
      hrefLang={other}
      aria-label={`${label}: ${other === "ar" ? "العربية" : "English"}`}
      className="min-touch inline-flex items-center justify-center rounded-lg border border-border px-3 text-sm font-semibold hover:bg-canvas"
      data-testid="locale-switch"
    >
      {other === "ar" ? "العربية" : "English"}
    </Link>
  );
}

export function SignOutButton({ className, children }: { className?: string; children?: ReactNode }) {
  const t = useTranslations("common.actions");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      data-testid="sign-out"
      onClick={async () => {
        setPending(true);
        await api("/session/logout", { method: "POST" });
        // Tell every other tab: no protected view may stay on screen after sign-out (PWA-06).
        broadcastSession("signed-out");
        router.replace("/login");
        router.refresh();
      }}
      className={clsx("min-touch inline-flex items-center gap-2 rounded-lg px-3 text-sm font-semibold hover:bg-canvas", className)}
    >
      <LogOut aria-hidden="true" className="size-4" />
      {children ?? t("signOut")}
    </button>
  );
}

/** Slide-over navigation for the bank workspace on phones. */
export function MobileDrawer({ children, openLabel, closeLabel }: { children: ReactNode; openLabel: string; closeLabel: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Close when the route changes (state adjusted during render, not in an effect).
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button
        type="button"
        aria-label={openLabel}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="min-touch inline-flex items-center justify-center rounded-lg text-white hover:bg-white/10 lg:hidden"
        data-testid="open-menu"
      >
        <Menu aria-hidden="true" className="size-6" />
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={openLabel}>
          <button type="button" aria-label={closeLabel} className="absolute inset-0 bg-ink/50" onClick={() => setOpen(false)} />
          <div className="pt-safe pb-safe absolute inset-y-0 start-0 flex w-[min(86vw,320px)] flex-col overflow-y-auto bg-nav">
            <div className="flex justify-end px-2 pt-2">
              <button type="button" aria-label={closeLabel} onClick={() => setOpen(false)} className="min-touch inline-flex items-center justify-center rounded-lg text-white hover:bg-white/10">
                <X aria-hidden="true" className="size-6" />
              </button>
            </div>
            {children}
          </div>
        </div>
      ) : null}
    </>
  );
}
