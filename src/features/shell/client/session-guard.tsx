"use client";

/**
 * Connectivity and session lifecycle guard (PWA-05, PWA-06, MOB-103).
 *
 * - `navigator.onLine` is only a hint. Connectivity is established by a real authenticated
 *   round-trip to `/api/v1/session`.
 * - While the connection or the session is unverified, everything inside the workspace is
 *   masked and inert: no stale balance is presented as current and no action can be taken.
 * - Revalidation runs when the tab returns to the foreground, on `pageshow` (including
 *   back/forward-cache restores) and when the browser reports it is back online. Server state
 *   is re-read before the content is shown again.
 * - Sign-out or a workspace switch in one tab is broadcast to the others. Nothing here writes
 *   banking data to any browser storage.
 */
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api-client";

const CHANNEL = "alqarib-session";
type SessionSignal = "signed-out" | "context-changed";

export function broadcastSession(signal: SessionSignal): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ signal });
  channel.close();
}

type GuardState = "ok" | "checking" | "offline" | "ended";

export function SessionGuard({ membershipId, children }: { membershipId: string; children: ReactNode }) {
  const t = useTranslations("common");
  const router = useRouter();
  const [state, setState] = useState<GuardState>("ok");
  const checking = useRef(false);
  // Wall-clock time of the last verified round-trip; set on mount, never read during render.
  const lastOk = useRef(0);
  useEffect(() => {
    lastOk.current = Date.now();
  }, []);

  const revalidate = useCallback(
    async (reason: "foreground" | "online" | "pageshow" | "poll") => {
      if (checking.current) return;
      checking.current = true;
      // Returning from the background or from the back/forward cache: hide first, verify, show.
      if (reason !== "poll") setState((current) => (current === "ok" ? "checking" : current));
      const result = await api<{ context: { membershipId: string | null } | null }>("/session");
      checking.current = false;
      if (result.ok) {
        if (!result.data.context || result.data.context.membershipId !== membershipId) {
          // Another tab switched workspace: this view belongs to a different context now.
          setState("ended");
          router.replace("/");
          router.refresh();
          return;
        }
        lastOk.current = Date.now();
        setState((current) => {
          if (current !== "ok") router.refresh();
          return "ok";
        });
        return;
      }
      if (result.network) {
        setState("offline");
        return;
      }
      if (result.code === "UNAUTHENTICATED") {
        setState("ended");
        router.replace("/login?ended=1");
        router.refresh();
      }
    },
    [membershipId, router],
  );

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void revalidate("foreground");
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void revalidate("pageshow");
    };
    const onOnline = () => void revalidate("online");
    const onOffline = () => setState("offline");
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event: MessageEvent<{ signal?: SessionSignal }>) => {
        if (event.data?.signal === "signed-out") {
          setState("ended");
          router.replace("/login?ended=1");
          router.refresh();
        } else if (event.data?.signal === "context-changed") {
          void revalidate("foreground");
        }
      };
    }
    // While offline, keep probing so the content returns only after a verified round-trip.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setState((current) => {
        if (current === "offline" || Date.now() - lastOk.current > 120_000) void revalidate("poll");
        return current;
      });
    }, 5_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(timer);
      channel?.close();
    };
  }, [revalidate, router]);

  const masked = state !== "ok";
  return (
    <>
      {masked ? (
        <div role="status" aria-live="assertive" data-testid="connection-mask" data-state={state} className="sticky top-0 z-30 border-b border-warning/40 bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
          {state === "offline" ? t("offline.banner") : state === "ended" ? t("offline.sessionEnded") : t("offline.checking")}
        </div>
      ) : null}
      {/* `inert` removes the masked subtree from focus order and the accessibility tree. */}
      <div inert={masked} aria-hidden={masked} data-masked={masked} className={masked ? "pointer-events-none select-none opacity-0" : undefined}>
        {children}
      </div>
    </>
  );
}
