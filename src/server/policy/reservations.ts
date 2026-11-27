/**
 * Atomic limit reservations (LIM-03, GOV-004).
 *
 * All counters an instruction touches are locked together, in one stable order
 * (scopeKey, period, windowStart), inside the caller's transaction. Competing approvals
 * therefore serialize on the shared counters: of two requests that only fit individually,
 * exactly one reserves and the other fails with the limit error — the corporate total can
 * never be overrun, even across different debit accounts (I-13, I-14).
 *
 * Reserved → consumed happens exactly once on confirmed booking; a definitive pre-booking
 * failure releases; an unknown outcome keeps the reservation until inquiry resolves it.
 * A lease timeout or crash never releases anything by itself.
 */
import { DomainError, type ErrorCode } from "@/contracts/errors";
import { localDateToDbDate, type LocalDate, type UsageWindows } from "@/server/calendar";
import { Prisma, type DbOrTx, type Tx } from "@/server/db/client";
import { counterKey, scopeKeys, type UsageSnapshot } from "./evaluate";

export type CounterRef = Readonly<{ scopeKey: string; period: "DAY" | "MONTH" }>;

/** The usage buckets one outgoing instruction counts toward — each exactly once (LIM-02). */
export function countersFor(input: { moduleId: string; transactionType: string; userKey: string | null }): CounterRef[] {
  const refs: CounterRef[] = [];
  for (const period of ["DAY", "MONTH"] as const) {
    refs.push({ scopeKey: scopeKeys.type(input.moduleId, input.transactionType), period });
    refs.push({ scopeKey: scopeKeys.module(input.moduleId), period });
    refs.push({ scopeKey: scopeKeys.corporate(), period });
  }
  if (input.userKey !== null) refs.push({ scopeKey: scopeKeys.user(input.userKey), period: "DAY" });
  return refs;
}

const windowOf = (windows: UsageWindows, period: "DAY" | "MONTH"): LocalDate => (period === "DAY" ? windows.day : windows.month);

export type LimitLookup = ReadonlyMap<string, Readonly<{ limit: bigint | null; code: ErrorCode }>>;

export type ReservationItem = Readonly<{
  instructionId: string;
  cycle: number;
  amountMinor: bigint;
  counters: readonly CounterRef[];
}>;

type CounterRow = {
  id: string;
  scopeKey: string;
  period: "DAY" | "MONTH";
  windowStart: Date;
  consumedMinor: bigint;
  reservedMinor: bigint;
};

async function lockCounters(tx: Tx, corporateId: string, currency: string, windows: UsageWindows, refs: readonly CounterRef[]): Promise<Map<string, CounterRow>> {
  const unique = new Map<string, CounterRef>();
  for (const ref of refs) unique.set(counterKey(ref.scopeKey, ref.period), ref);
  if (unique.size === 0) return new Map();
  const tuples = [...unique.values()].map(
    (ref) => Prisma.sql`(${ref.scopeKey}, ${ref.period}::"LimitPeriod", ${localDateToDbDate(windowOf(windows, ref.period))}::date)`,
  );
  const rows = await tx.$queryRaw<CounterRow[]>`
    SELECT "id", "scopeKey", "period"::text AS period, "windowStart", "consumedMinor", "reservedMinor"
      FROM "UsageCounter"
     WHERE "corporateId" = ${corporateId}::uuid AND "currency" = ${currency}
       AND ("scopeKey", "period", "windowStart") IN (${Prisma.join(tuples)})
     ORDER BY "scopeKey", "period", "windowStart"
       FOR UPDATE`;
  return new Map(rows.map((row) => [counterKey(row.scopeKey, row.period), row]));
}

/**
 * Reserve principal for one or many instructions in the given business windows.
 * Throws the limit's DomainError (and reserves nothing) if any counter would be exceeded.
 */
export async function reserveLimits(
  tx: Tx,
  input: {
    bankId: string;
    corporateId: string;
    currency: string;
    windows: UsageWindows;
    items: readonly ReservationItem[];
    limits: LimitLookup;
  },
): Promise<void> {
  if (input.items.length === 0) return;
  const totals = new Map<string, { ref: CounterRef; amount: bigint; items: number }>();
  for (const item of input.items) {
    if (item.amountMinor <= 0n) throw new Error("Reservation amount must be positive");
    for (const ref of item.counters) {
      const key = counterKey(ref.scopeKey, ref.period);
      const entry = totals.get(key) ?? { ref, amount: 0n, items: 0 };
      entry.amount += item.amountMinor;
      entry.items += 1;
      totals.set(key, entry);
    }
  }

  // Make sure every bucket row exists, then lock them all in stable order.
  await tx.usageCounter.createMany({
    data: [...totals.values()].map(({ ref }) => ({
      bankId: input.bankId,
      corporateId: input.corporateId,
      scopeKey: ref.scopeKey,
      period: ref.period,
      windowStart: localDateToDbDate(windowOf(input.windows, ref.period)),
      currency: input.currency,
    })),
    skipDuplicates: true,
  });
  const locked = await lockCounters(tx, input.corporateId, input.currency, input.windows, [...totals.values()].map((entry) => entry.ref));

  for (const [key, entry] of totals) {
    const counter = locked.get(key);
    if (!counter) throw new Error("Usage counter missing after upsert");
    const rule = input.limits.get(key);
    if (!rule) continue;
    if (rule.limit === null || counter.consumedMinor + counter.reservedMinor + entry.amount > rule.limit) {
      const remaining = rule.limit === null ? null : rule.limit - counter.consumedMinor - counter.reservedMinor;
      throw new DomainError(rule.code, {
        violations: [
          {
            field: "amount.minor",
            rule: `${entry.ref.scopeKey.split(":")[0]?.toLowerCase()}.${entry.ref.period.toLowerCase()}`,
            ...(remaining !== null ? { remainingMinor: (remaining < 0n ? 0n : remaining).toString() } : {}),
          },
        ],
      });
    }
  }

  for (const [key, entry] of totals) {
    const counter = locked.get(key) as CounterRow;
    await tx.usageCounter.update({
      where: { id: counter.id },
      data: { reservedMinor: { increment: entry.amount }, reservedItems: { increment: entry.items } },
    });
  }
  await tx.limitReservation.createMany({
    data: input.items.flatMap((item) =>
      item.counters.map((ref) => ({
        instructionId: item.instructionId,
        counterId: (locked.get(counterKey(ref.scopeKey, ref.period)) as CounterRow).id,
        cycle: item.cycle,
        amountMinor: item.amountMinor,
        items: 1,
      })),
    ),
  });
}

type ReservationRow = { id: string; counterId: string; amountMinor: bigint; items: number };

/**
 * Finish the live reservations of an instruction cycle exactly once: CONSUMED on confirmed
 * booking, RELEASED on a definitive pre-booking failure or cancellation. Calling it again for
 * the same cycle is a no-op (the rows are no longer RESERVED).
 */
export async function settleReservations(
  tx: Tx,
  instructionId: string,
  cycle: number,
  outcome: "CONSUMED" | "RELEASED",
): Promise<number> {
  const rows = await tx.$queryRaw<ReservationRow[]>`
    SELECT r."id", r."counterId", r."amountMinor", r."items"
      FROM "LimitReservation" r
      JOIN "UsageCounter" c ON c."id" = r."counterId"
     WHERE r."instructionId" = ${instructionId}::uuid AND r."cycle" = ${cycle} AND r."state" = 'RESERVED'
     ORDER BY c."scopeKey", c."period", c."windowStart"
       FOR UPDATE OF c, r`;
  for (const row of rows) {
    await tx.usageCounter.update({
      where: { id: row.counterId },
      data: {
        reservedMinor: { decrement: row.amountMinor },
        reservedItems: { decrement: row.items },
        ...(outcome === "CONSUMED"
          ? { consumedMinor: { increment: row.amountMinor }, consumedItems: { increment: row.items } }
          : {}),
      },
    });
  }
  if (rows.length > 0) {
    await tx.limitReservation.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, state: "RESERVED" },
      data: { state: outcome },
    });
  }
  return rows.length;
}

/** Business windows the live reservations of a cycle were taken in. */
export async function reservationWindows(db: DbOrTx, instructionId: string, cycle: number): Promise<{ day: LocalDate | null; month: LocalDate | null; count: number }> {
  const rows = await db.limitReservation.findMany({
    where: { instructionId, cycle, state: "RESERVED" },
    include: { counter: { select: { period: true, windowStart: true } } },
  });
  let day: LocalDate | null = null;
  let month: LocalDate | null = null;
  for (const row of rows) {
    const value = row.counter.windowStart.toISOString().slice(0, 10);
    if (row.counter.period === "DAY") day = value;
    if (row.counter.period === "MONTH") month = value;
  }
  return { day, month, count: rows.length };
}

/** Current consumed + reserved usage for the given buckets (advisory previews, usage pages). */
export async function loadUsage(
  db: DbOrTx,
  input: { corporateId: string; currency: string; windows: UsageWindows; counters: readonly CounterRef[] },
): Promise<UsageSnapshot> {
  const out = new Map<string, { consumedMinor: bigint; reservedMinor: bigint }>();
  const scopeKeyList = [...new Set(input.counters.map((ref) => ref.scopeKey))];
  if (scopeKeyList.length === 0) return out;
  const rows = await db.usageCounter.findMany({
    where: {
      corporateId: input.corporateId,
      currency: input.currency,
      scopeKey: { in: scopeKeyList },
      OR: [
        { period: "DAY", windowStart: localDateToDbDate(input.windows.day) },
        { period: "MONTH", windowStart: localDateToDbDate(input.windows.month) },
      ],
    },
  });
  for (const row of rows) {
    if (row.period !== "DAY" && row.period !== "MONTH") continue;
    out.set(counterKey(row.scopeKey, row.period), { consumedMinor: row.consumedMinor, reservedMinor: row.reservedMinor });
  }
  return out;
}
