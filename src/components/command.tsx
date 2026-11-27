"use client";

/**
 * Client-side command plumbing shared by every mutating control.
 *
 * - One Idempotency-Key per logical action, kept in MEMORY only and reused if the person
 *   retries after a lost response — so a retry can never create a second effect (P-06).
 * - While a command is in flight (or its outcome is unknown) the control is disabled and the
 *   busy guard blocks an app update/reload (PWA-07).
 * - After a network failure nothing is assumed: the UI says the result is being checked and
 *   re-reads server state before offering the same action again (PWA-05).
 */
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@/i18n/navigation";
import { api, newIdempotencyKey, type ApiFailure, type ApiRequest, type ApiResult } from "@/lib/api-client";
import { markBusy } from "@/pwa/busy-guard";
import { Button, Callout, type ButtonVariant } from "./ui/primitives";

export type CommandState = { pending: boolean; failure: ApiFailure | null; unknownOutcome: boolean };

export function useCommand() {
  const router = useRouter();
  const [state, setState] = useState<CommandState>({ pending: false, failure: null, unknownOutcome: false });
  const keyRef = useRef<string | null>(null);
  const release = useRef<(() => void) | null>(null);

  useEffect(() => () => release.current?.(), []);

  const run = useCallback(
    async <T,>(path: string, request: Omit<ApiRequest, "idempotencyKey">, options: { idempotent?: boolean; refresh?: boolean } = {}): Promise<ApiResult<T>> => {
      const idempotent = options.idempotent !== false && (request.method ?? "POST") === "POST";
      // Reuse the key of an attempt whose outcome is unknown; otherwise mint a new one.
      keyRef.current ??= newIdempotencyKey();
      release.current?.();
      release.current = markBusy("command");
      setState({ pending: true, failure: null, unknownOutcome: false });
      const result = await api<T>(path, { ...request, method: request.method ?? "POST", ...(idempotent ? { idempotencyKey: keyRef.current } : {}) });
      if (result.ok) {
        keyRef.current = null;
        release.current?.();
        release.current = null;
        setState({ pending: false, failure: null, unknownOutcome: false });
        if (options.refresh !== false) router.refresh();
        return result;
      }
      if (result.network) {
        // The request may have reached the bank. Keep the key; do not allow a blind retry.
        setState({ pending: false, failure: result, unknownOutcome: true });
        return result;
      }
      // A definite answer from the server: this attempt is over, a new attempt gets a new key.
      keyRef.current = null;
      release.current?.();
      release.current = null;
      setState({ pending: false, failure: result, unknownOutcome: false });
      if (result.code === "UNAUTHENTICATED") router.refresh();
      return result;
    },
    [router],
  );

  /** After an unknown outcome: re-read authoritative state, then allow the same request again. */
  const checkServer = useCallback(() => {
    router.refresh();
    setState((current) => ({ ...current, unknownOutcome: false }));
  }, [router]);

  const reset = useCallback(() => {
    keyRef.current = null;
    release.current?.();
    release.current = null;
    setState({ pending: false, failure: null, unknownOutcome: false });
  }, []);

  return { ...state, run, checkServer, reset };
}

/** Localized, actionable description of a failed command. Never shows internals. */
export function ProblemAlert({ failure, onCheck }: { failure: ApiFailure | null; onCheck?: () => void }) {
  const t = useTranslations();
  if (!failure) return null;
  const key = `errors.${failure.code}` as Parameters<typeof t>[0];
  const message = t.has(key) ? t(key) : t("errors.INTERNAL_ERROR");
  const violations = failure.problem?.violations?.filter((violation) => violation.message) ?? [];
  return (
    <Callout tone={failure.network ? "warning" : "danger"} role="alert" testId="problem">
      <p className="font-semibold" data-code={failure.code}>{message}</p>
      {violations.length > 0 ? (
        <ul className="mt-1 list-disc ps-5">
          {violations.slice(0, 6).map((violation, index) => (
            <li key={index}>{violation.message}</li>
          ))}
        </ul>
      ) : null}
      {failure.network && onCheck ? (
        <Button variant="secondary" className="mt-3" onClick={onCheck}>
          {t("common.actions.refresh")}
        </Button>
      ) : null}
      {failure.correlationId ? (
        <p className="mt-2 text-xs text-muted">
          {t("common.labels.correlation")}: <bdi dir="ltr" className="font-mono">{failure.correlationId}</bdi>
        </p>
      ) : null}
    </Callout>
  );
}

/** A single-click command with pending state and inline error. */
export function CommandButton({
  path,
  body,
  ifMatch,
  children,
  variant = "primary",
  onSuccess,
  disabled,
  testId,
}: {
  path: string;
  body?: unknown;
  ifMatch?: number;
  children: ReactNode;
  variant?: ButtonVariant;
  onSuccess?: (data: unknown) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const t = useTranslations("common");
  const command = useCommand();
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={variant}
        disabled={disabled || command.pending || command.unknownOutcome}
        aria-busy={command.pending}
        data-testid={testId}
        onClick={async () => {
          const result = await command.run(path, { body, ...(ifMatch !== undefined ? { ifMatch } : {}) });
          if (result.ok) onSuccess?.(result.data);
        }}
      >
        {command.pending ? t("actions.working") : children}
      </Button>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
    </div>
  );
}
