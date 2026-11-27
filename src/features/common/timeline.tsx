import { getLocale, getTranslations } from "next-intl/server";
import { Code } from "@/components/ui/primitives";
import { statusTone } from "@/components/ui/status";
import { formatDateTime } from "@/lib/format";

export type TimelineEntry = {
  at: string;
  code: string;
  fromState: string | null;
  toState: string | null;
  actor: string | null;
  reference: string | null;
  detail: unknown;
};

const DOT: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-border-strong",
  sandbox: "bg-sandbox",
};

/** Status timeline: every transition with actor and adapter reference (APR-01). */
export async function Timeline({ entries, timeZone }: { entries: TimelineEntry[]; timeZone: string }) {
  const t = await getTranslations();
  const locale = await getLocale();
  return (
    <ol className="flex flex-col" data-testid="timeline">
      {entries.map((entry, index) => {
        const key = `types.timeline.${entry.code}` as Parameters<typeof t>[0];
        const detail = (entry.detail ?? {}) as Record<string, unknown>;
        const failureCode = typeof detail["failureCode"] === "string" ? detail["failureCode"] : typeof detail["blockCode"] === "string" ? detail["blockCode"] : null;
        const failureKey = failureCode ? (`types.failure.${failureCode}` as Parameters<typeof t>[0]) : null;
        const errorKey = failureCode ? (`errors.${failureCode}` as Parameters<typeof t>[0]) : null;
        const reason = typeof detail["reason"] === "string" ? detail["reason"] : null;
        return (
          <li key={index} className="relative flex gap-3 pb-4 last:pb-0" data-code={entry.code} data-to={entry.toState ?? ""}>
            <span aria-hidden="true" className="flex flex-col items-center">
              <span className={`mt-1.5 size-2.5 rounded-full ${DOT[statusTone(entry.toState ?? "")] ?? DOT["neutral"]}`} />
              {index < entries.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.has(key) ? t(key) : t("types.timeline.UNKNOWN")}</p>
              {failureKey ? (
                <p className="text-sm text-danger">
                  {t.has(failureKey) ? t(failureKey) : errorKey && t.has(errorKey) ? t(errorKey) : t("types.failure.OTHER")}
                </p>
              ) : null}
              {reason ? (
                <p className="text-sm text-muted">
                  <bdi>{reason}</bdi>
                </p>
              ) : null}
              <p className="text-xs text-muted">
                <time dateTime={entry.at}>{formatDateTime(entry.at, locale, timeZone)}</time>
                {entry.actor ? <> · <bdi>{entry.actor}</bdi></> : null}
              </p>
              {entry.reference ? (
                <p className="text-xs text-muted">
                  <Code>{entry.reference}</Code>
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
