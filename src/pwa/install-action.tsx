"use client";

/**
 * Install assistance (PWA-02). Shown only when relevant, never required, and never repeated
 * once the person dismisses it or the app already runs standalone.
 * - Browsers that fire `beforeinstallprompt` get a real Install action.
 * - iOS Safari has no install event: we explain the manual "Add to Home Screen" steps.
 * - Everywhere else nothing is shown and the site simply works in the browser.
 * The only thing stored is the non-sensitive "dismissed" preference.
 */
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const DISMISS_KEY = "alqarib.install.dismissed";

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

type InstallEnvironment = "unavailable" | "ios" | "prompt-capable";

/** What install help applies in THIS browser. Read on the client only. */
function installEnvironment(variant: "compact" | "full"): InstallEnvironment {
  if (isStandalone()) return "unavailable";
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    dismissed = false;
  }
  if (dismissed && variant === "compact") return "unavailable";
  return isIosSafari() ? "ios" : "prompt-capable";
}

const subscribeNever = () => () => undefined;

export function InstallAction({ variant = "compact" }: { variant?: "compact" | "full" }) {
  const t = useTranslations("common.pwa");
  // Server render and hydration both see "unavailable"; the real value arrives after hydration.
  const environment = useSyncExternalStore<InstallEnvironment>(
    subscribeNever,
    () => installEnvironment(variant),
    () => "unavailable",
  );
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  const ios = environment === "ios";

  useEffect(() => {
    if (environment === "unavailable") return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setClosed(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [environment]);

  if (closed || environment === "unavailable" || (!ios && !prompt)) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* preference only */
    }
    setOpen(false);
    setClosed(true);
  };

  return (
    <>
      <button
        type="button"
        data-testid="install-action"
        onClick={async () => {
          if (prompt) {
            await prompt.prompt();
            const choice = await prompt.userChoice;
            setPrompt(null);
            if (choice.outcome === "dismissed") dismiss();
            else setClosed(true);
          } else if (ios) {
            setOpen(true);
          }
        }}
        className="min-touch inline-flex items-center gap-2 rounded-lg px-3 text-sm font-semibold hover:bg-canvas"
      >
        <Download aria-hidden="true" className="size-4" />
        {t("install")}
      </button>
      {open ? (
        <div role="dialog" aria-modal="true" aria-labelledby="ios-install-title" className="fixed inset-0 z-[70] grid place-items-end bg-ink/50 p-3 sm:place-items-center">
          <div className="pb-safe w-full max-w-sm rounded-[12px] bg-surface p-5 text-ink shadow-lg">
            <h2 id="ios-install-title" className="text-lg font-semibold">{t("iosTitle")}</h2>
            <p className="mt-2 text-sm text-muted">{t("iosBody")}</p>
            <p className="mt-2 text-sm text-muted">{t("installBody")}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => setOpen(false)} className="min-touch rounded-lg bg-accent px-4 text-sm font-semibold text-white">
                {t("updateLater")}
              </button>
              <button type="button" onClick={dismiss} className="min-touch rounded-lg border border-border px-4 text-sm font-semibold">
                {t("dismiss")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
