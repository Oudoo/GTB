/**
 * Bank business time (LIM-02, PAY-03). Instants are stored in UTC; daily and monthly limit
 * windows, cut-offs and closed days are decided in the BANK's time zone (Africa/Tripoli in the
 * sandbox), never in the host's or the user's zone. A month is a calendar month.
 *
 * The calendar data (weekend days, closed dates, cut-offs) is synthetic fixture policy held in
 * the database; nothing here knows a real holiday.
 */

/** Calendar date in the bank time zone, `YYYY-MM-DD`. */
export type LocalDate = string;
/** Local wall-clock time, `HH:MM` (24h). */
export type LocalTime = string;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function localParts(instant: Date, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out["year"] as number,
    month: out["month"] as number,
    day: out["day"] as number,
    hour: out["hour"] as number,
    minute: out["minute"] as number,
    second: out["second"] as number,
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export function isLocalDate(value: string): boolean {
  const match = LOCAL_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
}

export function assertLocalDate(value: string): LocalDate {
  if (!isLocalDate(value)) throw new Error(`Invalid local date: ${value}`);
  return value;
}

/** Business date of an instant in the bank time zone. */
export function businessDateOf(instant: Date, timeZone: string): LocalDate {
  const p = localParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTimeOf(instant: Date, timeZone: string): LocalTime {
  const p = localParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset (minutes east of UTC) of a zone at an instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The UTC instant at which the bank's wall clock shows `date` `time`. */
export function zonedInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const d = LOCAL_DATE.exec(assertLocalDate(date)) as RegExpExecArray;
  const t = LOCAL_TIME.exec(time);
  if (!t) throw new Error(`Invalid local time: ${time}`);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0);
  // Two passes settle the offset across a zone transition.
  let guess = wall - offsetMinutes(new Date(wall), timeZone) * 60_000;
  guess = wall - offsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess);
}

export function startOfBusinessDay(date: LocalDate, timeZone: string): Date {
  return zonedInstant(date, "00:00", timeZone);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = LOCAL_DATE.exec(assertLocalDate(date)) as RegExpExecArray;
  const next = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + days));
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = LOCAL_DATE.exec(assertLocalDate(from)) as RegExpExecArray;
  const b = LOCAL_DATE.exec(assertLocalDate(to)) as RegExpExecArray;
  const ms =
    Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) - Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  return Math.round(ms / 86_400_000);
}

/** First day of the calendar month containing `date`. */
export function monthStart(date: LocalDate): LocalDate {
  return `${assertLocalDate(date).slice(0, 7)}-01`;
}

export function nextMonthStart(date: LocalDate): LocalDate {
  const d = LOCAL_DATE.exec(assertLocalDate(date)) as RegExpExecArray;
  const next = new Date(Date.UTC(Number(d[1]), Number(d[2]), 1));
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-01`;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  const d = LOCAL_DATE.exec(assertLocalDate(date)) as RegExpExecArray;
  const day = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))).getUTCDay();
  return day === 0 ? 7 : day;
}

/** A `DATE` column value for a local date (midnight UTC, as PostgreSQL DATE round-trips). */
export function localDateToDbDate(date: LocalDate): Date {
  return new Date(`${assertLocalDate(date)}T00:00:00.000Z`);
}

export function dbDateToLocalDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}

export type CalendarSpec = Readonly<{
  timeZone: string;
  /** ISO weekdays that are closed for clearing. */
  weekendDays: readonly number[];
  closedDates: ReadonlySet<LocalDate>;
}>;

export function isBusinessDay(date: LocalDate, calendar: CalendarSpec): boolean {
  return !calendar.weekendDays.includes(isoWeekday(date)) && !calendar.closedDates.has(date);
}

export function nextBusinessDay(date: LocalDate, calendar: CalendarSpec, inclusive: boolean): LocalDate {
  let candidate = inclusive ? date : addDays(date, 1);
  for (let i = 0; i < 370; i += 1) {
    if (isBusinessDay(candidate, calendar)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error("Calendar has no business day within a year");
}

export type RailWindowSpec = Readonly<{
  /** NULL/undefined = open around the clock. */
  openLocalTime?: LocalTime | null;
  /** Exclusive: a request at exactly the cut-off is after it. */
  cutoffLocalTime?: LocalTime | null;
  observesClosedDays: boolean;
  /** Core offline window in local time; may wrap midnight. Both or neither. */
  offlineStartLocalTime?: LocalTime | null;
  offlineEndLocalTime?: LocalTime | null;
}>;

export type ExecutionWindow = Readonly<{
  /** Earliest instant the rail will take the instruction. */
  executeAt: Date;
  businessDate: LocalDate;
  /** True when the requested instant had to move later. */
  rolled: boolean;
  reason?: "BEFORE_OPEN" | "AFTER_CUTOFF" | "CLOSED_DAY" | "CORE_OFFLINE";
}>;

function inOfflineWindow(time: LocalTime, start: LocalTime, end: LocalTime): boolean {
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

/**
 * Decide when an instruction requested for `requested` can execute on a rail.
 * LYPay-style rails (no cut-off, no closed days) execute immediately; ACH-style rails roll to
 * the next open window; internal postings wait out a configured core offline window.
 */
export function resolveExecutionWindow(
  requested: Date,
  rail: RailWindowSpec,
  calendar: CalendarSpec,
): ExecutionWindow {
  const tz = calendar.timeZone;
  const date = businessDateOf(requested, tz);
  const time = localTimeOf(requested, tz);

  if (rail.offlineStartLocalTime && rail.offlineEndLocalTime) {
    if (inOfflineWindow(time, rail.offlineStartLocalTime, rail.offlineEndLocalTime)) {
      const wraps = rail.offlineStartLocalTime > rail.offlineEndLocalTime;
      const endDate = wraps && time >= rail.offlineStartLocalTime ? addDays(date, 1) : date;
      const executeAt = zonedInstant(endDate, rail.offlineEndLocalTime, tz);
      return { executeAt, businessDate: businessDateOf(executeAt, tz), rolled: true, reason: "CORE_OFFLINE" };
    }
  }

  const open = rail.openLocalTime ?? null;
  const cutoff = rail.cutoffLocalTime ?? null;
  const closedToday = rail.observesClosedDays && !isBusinessDay(date, calendar);

  if (!closedToday) {
    if (open && time < open) {
      const executeAt = zonedInstant(date, open, tz);
      return { executeAt, businessDate: date, rolled: true, reason: "BEFORE_OPEN" };
    }
    if (!cutoff || time < cutoff) {
      return { executeAt: requested, businessDate: date, rolled: false };
    }
  }

  const nextDate = rail.observesClosedDays ? nextBusinessDay(date, calendar, false) : addDays(date, 1);
  const executeAt = zonedInstant(nextDate, open ?? "00:00", tz);
  return {
    executeAt,
    businessDate: nextDate,
    rolled: true,
    reason: closedToday ? "CLOSED_DAY" : "AFTER_CUTOFF",
  };
}

/** Maximum demo scheduling horizon (PAY-03). */
export const SCHEDULING_HORIZON_DAYS = 30;

export function withinSchedulingHorizon(now: Date, executeAt: Date, timeZone: string): boolean {
  if (executeAt.getTime() <= now.getTime()) return false;
  return daysBetween(businessDateOf(now, timeZone), businessDateOf(executeAt, timeZone)) <= SCHEDULING_HORIZON_DAYS;
}

export type UsageWindows = Readonly<{ day: LocalDate; month: LocalDate }>;

/** The limit windows an instant belongs to: its business day and its calendar month. */
export function usageWindows(instant: Date, timeZone: string): UsageWindows {
  const day = businessDateOf(instant, timeZone);
  return { day, month: monthStart(day) };
}
