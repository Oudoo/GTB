"use client";

/**
 * Installed-app runtime (document 12): service-worker registration, safe update prompt,
 * and nothing else. Registration happens only in production builds over a secure context;
 * development never registers a worker.
 */
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { hasUnsavedWork } from "./busy-guard";

export function PwaRuntime() {
  const t = useTranslations("common.pwa");
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

    let cancelled = false;
    let reloading = false;

    const onControllerChange = () => {
      // Fired after the person confirmed the update. A plain GET reload: no request is replayed.
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return;
        if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setWaiting(installing);
              setHidden(false);
            }
          });
        });
        // Look for a new build whenever the app returns to the foreground.
        const check = () => {
          if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
        };
        document.addEventListener("visibilitychange", check);
      })
      .catch(() => undefined);

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const update = useCallback(() => {
    if (!waiting) return;
    if (hasUnsavedWork()) {
      // Never reload under an unsaved form, an open review or an in-flight command (PWA-07).
      setBlocked(true);
      return;
    }
    setBlocked(false);
    waiting.postMessage({ type: "SKIP_WAITING" });
  }, [waiting]);

  if (!waiting || hidden) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pwa-update"
      className="fixed inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom,0px))] z-50 mx-auto max-w-md rounded-[10px] border border-border bg-surface p-4 shadow-lg lg:bottom-6"
    >
      <p className="font-semibold">{t("updateTitle")}</p>
      <p className="mt-1 text-sm text-muted">{blocked ? t("updateBlocked") : t("updateBody")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={update}
          className="min-touch rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-strong"
        >
          {t("updateNow")}
        </button>
        <button
          type="button"
          onClick={() => setHidden(true)}
          className="min-touch rounded-lg border border-border px-4 text-sm font-semibold text-ink hover:bg-canvas"
        >
          {t("updateLater")}
        </button>
      </div>
    </div>
  );
}
