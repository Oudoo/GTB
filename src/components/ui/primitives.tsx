/**
 * Small accessible building blocks (document 05): 44px touch targets, visible focus, logical
 * properties for RTL, colour always paired with text. Server-component friendly.
 */
import { clsx } from "clsx";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { amountText, type MoneyLike } from "@/lib/format";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "sandbox";

const TONE: Record<Tone, string> = {
  neutral: "bg-canvas text-ink border-border",
  info: "bg-info-soft text-info border-info/30",
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  sandbox: "bg-sandbox-soft text-sandbox border-sandbox/30",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap", TONE[tone], className)}>
      {children}
    </span>
  );
}

const BUTTON_BASE =
  "min-touch inline-flex items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55";

const BUTTON_VARIANT = {
  primary: "bg-accent text-white hover:bg-accent-strong",
  secondary: "border border-border-strong bg-surface text-ink hover:bg-canvas",
  danger: "bg-danger text-white hover:opacity-90",
  ghost: "text-accent hover:bg-accent-soft",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANT;

export function buttonClass(variant: ButtonVariant = "primary", className?: string): string {
  return clsx(BUTTON_BASE, BUTTON_VARIANT[variant], className);
}

export function Button({ variant = "primary", className, type = "button", ...props }: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

export function LinkButton({ variant = "primary", className, ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}

export function Card({
  children,
  className,
  as = "section",
  ...props
}: { children: ReactNode; className?: string; as?: "section" | "div" | "article" } & Omit<HTMLAttributes<HTMLElement>, "className" | "children">) {
  // The three allowed tags share the same attribute surface.
  const Tag = as as "section";
  return (
    <Tag className={clsx("rounded-[10px] border border-border bg-surface shadow-[0_1px_2px_rgb(16_35_63/0.06)]", className)} {...props}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {back ? <div className="mb-1 text-sm">{back}</div> : null}
        <h1 className="text-2xl leading-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * An exact amount. Digits are isolated left-to-right so they are never reversed inside Arabic
 * text, and tabular numerals keep columns aligned.
 */
export function Money({ value, className, signed }: { value: MoneyLike; className?: string; signed?: "DEBIT" | "CREDIT" }) {
  return (
    <bdi dir="ltr" className={clsx("tabular whitespace-nowrap", className)} data-money={value.minor}>
      {signed === "DEBIT" ? "−" : signed === "CREDIT" ? "+" : ""}
      <span className="text-muted">{value.currency}</span> {amountText(value)}
    </bdi>
  );
}

/** Identifiers, references and account numbers: never reordered by the bidi algorithm. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={clsx("tabular font-mono text-[0.92em] break-all", className)}>
      {children}
    </bdi>
  );
}

export function Callout({ tone = "info", title, children, role, testId }: { tone?: Tone; title?: ReactNode; children?: ReactNode; role?: "alert" | "status" | "note"; testId?: string }) {
  return (
    <div role={role ?? (tone === "danger" ? "alert" : "note")} data-testid={testId} className={clsx("rounded-lg border px-4 py-3 text-sm", TONE[tone])}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={clsx(title && "mt-1", "text-ink/90")}>{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Label/value pairs that stack on narrow screens and align in two columns on wide ones. */
export function DetailList({ items, className }: { items: Array<{ label: ReactNode; value: ReactNode; wide?: boolean; testId?: string }>; className?: string }) {
  return (
    <dl className={clsx("grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2", className)}>
      {items.map((item, index) => (
        <div key={index} className={clsx("min-w-0", item.wide && "sm:col-span-2")}>
          <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{item.label}</dt>
          <dd className="mt-0.5 break-words" data-testid={item.testId}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Right-align numeric columns (start/end aware). */
  numeric?: boolean;
  /** Hidden in the card layout's body and shown as the card title instead. */
  primary?: boolean;
  className?: string;
};

/**
 * Responsive record list (MOB-04): a real table from the `md` breakpoint, labelled cards below
 * it. Nothing is clipped on a phone and every card keeps its amount, status and action.
 */
export function DataList<T>({
  rows,
  columns,
  rowKey,
  caption,
  empty,
  action,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  caption: string;
  empty: ReactNode;
  action?: (row: T) => ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  const primary = columns.find((column) => column.primary) ?? columns[0];
  return (
    <>
      <div className="hidden md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-start text-xs tracking-wide text-muted uppercase">
              {columns.map((column) => (
                <th key={column.key} scope="col" className={clsx("px-4 py-2.5 font-semibold", column.numeric ? "text-end" : "text-start", column.className)}>
                  {column.header}
                </th>
              ))}
              {action ? <th scope="col" className="px-4 py-2.5 text-end font-semibold"><span className="sr-only">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-border last:border-0 hover:bg-canvas/60">
                {columns.map((column) => (
                  <td key={column.key} className={clsx("px-4 py-3 align-top", column.numeric ? "text-end" : "text-start", column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
                {action ? <td className="px-4 py-2 text-end align-top">{action(row)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-border md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="px-4 py-3">
            <div className="font-semibold">{primary?.cell(row)}</div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {columns
                .filter((column) => column !== primary)
                .map((column) => (
                  <div key={column.key} className="contents">
                    <dt className="text-muted">{column.header}</dt>
                    <dd className="min-w-0 text-end break-words">{column.cell(row)}</dd>
                  </div>
                ))}
            </dl>
            {action ? <div className="mt-3 flex justify-end">{action(row)}</div> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={clsx("animate-pulse rounded-md bg-border/60", className)} />;
}

export function SandboxPill({ label }: { label: string }) {
  return (
    <Badge tone="sandbox" className="uppercase tracking-wide" >
      <span aria-hidden="true">●</span>
      <span data-testid="sandbox-indicator">{label}</span>
    </Badge>
  );
}
