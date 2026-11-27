import { DetailList, Money } from "@/components/ui/primitives";
import type { MoneyLike } from "@/lib/format";

export type ApprovalSummary = Record<string, unknown> & { kind?: string };

const asMoney = (value: unknown): MoneyLike | null =>
  value && typeof value === "object" && "minor" in value && "currency" in value ? (value as MoneyLike) : null;

/**
 * Last-resort renderer for a flat, already-redacted proposal summary. Feature summaries should
 * render labelled, translated fields instead; this only guarantees nothing is silently hidden.
 */
export function SummaryFields({ summary }: { summary: ApprovalSummary }) {
  const entries = Object.entries(summary).filter(
    ([key, value]) => key !== "kind" && key !== "linkPath" && value !== null && value !== undefined && (typeof value !== "object" || asMoney(value) !== null),
  );
  return (
    <DetailList
      items={entries.map(([key, value]) => {
        const money = asMoney(value);
        return { label: key, value: money ? <Money value={money} /> : <bdi>{String(value)}</bdi> };
      })}
    />
  );
}
