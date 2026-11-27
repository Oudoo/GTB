/**
 * Form controls. Every control is labelled, errors are linked with `aria-describedby`, and the
 * minimum height is 44px for touch (document 05, MOB-02).
 */
import { clsx } from "clsx";
import type { ComponentProps, ReactNode } from "react";

const CONTROL =
  "min-h-11 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-ink placeholder:text-muted/70 " +
  "focus:border-accent disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-danger";

export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
        {required ? <span className="text-danger" aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {hint ? <p id={`${id}-hint`} className="text-sm text-muted">{hint}</p> : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** `aria-describedby` / `aria-invalid` wiring for a control inside a <Field>. */
export function describe(id: string, options: { hint?: boolean; error?: boolean }) {
  const ids = [options.hint ? `${id}-hint` : null, options.error ? `${id}-error` : null].filter(Boolean).join(" ");
  return { id, ...(ids ? { "aria-describedby": ids } : {}), ...(options.error ? { "aria-invalid": true as const } : {}) };
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={clsx(CONTROL, className)} {...props} />;
}

/**
 * Amount entry: a decimal keypad on phones, never `type="number"` (no float coercion, no
 * spinner). The text is parsed to exact minor units by `parseUserAmount` (MOB-05).
 */
export function AmountInput({ className, ...props }: Omit<ComponentProps<"input">, "type" | "inputMode">) {
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      dir="ltr"
      className={clsx(CONTROL, "tabular text-start", className)}
      {...props}
    />
  );
}

export function Textarea({ className, rows = 3, ...props }: ComponentProps<"textarea">) {
  return <textarea rows={rows} className={clsx(CONTROL, "resize-y", className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={clsx(CONTROL, "appearance-auto pe-8", className)} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({ id, label, className, ...props }: Omit<ComponentProps<"input">, "type"> & { id: string; label: ReactNode }) {
  return (
    <label htmlFor={id} className={clsx("flex min-h-11 cursor-pointer items-start gap-3 py-2", className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-5 shrink-0 rounded border-border-strong accent-[var(--color-accent)]" {...props} />
      <span className="text-sm">{label}</span>
    </label>
  );
}

export function FormActions({ children, className }: { children: ReactNode; className?: string }) {
  // Sticky on phones so the primary action stays above the keyboard and the home indicator.
  return (
    <div className={clsx("sticky bottom-[calc(64px+env(safe-area-inset-bottom,0px))] z-10 -mx-4 flex flex-wrap gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 lg:bottom-0", className)}>
      {children}
    </div>
  );
}
