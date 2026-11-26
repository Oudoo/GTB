import { describe, expect, it } from "vitest";
import {
  type CalendarSpec,
  type RailWindowSpec,
  addDays,
  businessDateOf,
  daysBetween,
  isBusinessDay,
  isoWeekday,
  monthStart,
  nextBusinessDay,
  nextMonthStart,
  resolveExecutionWindow,
  usageWindows,
  withinSchedulingHorizon,
  zonedInstant,
} from "@/server/calendar";
import { ManualClock } from "@/server/clock";

const TZ = "Africa/Tripoli"; // UTC+2, the sandbox bank time zone

// Synthetic calendar fixture: Friday/Saturday closed plus one invented closed day.
const calendar: CalendarSpec = {
  timeZone: TZ,
  weekendDays: [5, 6],
  closedDates: new Set(["2026-11-25"]),
};

const ach: RailWindowSpec = { openLocalTime: "08:00", cutoffLocalTime: "14:00", observesClosedDays: true };
const lypay: RailWindowSpec = { observesClosedDays: false };
const internal: RailWindowSpec = {
  observesClosedDays: false,
  offlineStartLocalTime: "23:30",
  offlineEndLocalTime: "00:30",
};

const at = (date: string, time: string) => zonedInstant(date, time, TZ);

describe("U-CAL-01 ACH cut-off: before, at and after", () => {
  it("executes immediately before the cut-off on a business day", () => {
    // 2026-11-23 is a Monday.
    expect(isoWeekday("2026-11-23")).toBe(1);
    const requested = at("2026-11-23", "13:59");
    const window = resolveExecutionWindow(requested, ach, calendar);
    expect(window).toEqual({ executeAt: requested, businessDate: "2026-11-23", rolled: false });
  });

  it("treats the exact cut-off instant as after the cut-off", () => {
    const window = resolveExecutionWindow(at("2026-11-23", "14:00"), ach, calendar);
    expect(window.rolled).toBe(true);
    expect(window.reason).toBe("AFTER_CUTOFF");
    expect(window.businessDate).toBe("2026-11-24");
    expect(window.executeAt.toISOString()).toBe(at("2026-11-24", "08:00").toISOString());
  });

  it("rolls to the next open window after the cut-off", () => {
    const window = resolveExecutionWindow(at("2026-11-23", "18:30"), ach, calendar);
    expect(window.reason).toBe("AFTER_CUTOFF");
    expect(window.businessDate).toBe("2026-11-24");
  });

  it("waits for opening time on a business day", () => {
    const window = resolveExecutionWindow(at("2026-11-23", "06:15"), ach, calendar);
    expect(window.reason).toBe("BEFORE_OPEN");
    expect(window.businessDate).toBe("2026-11-23");
    expect(window.executeAt.toISOString()).toBe(at("2026-11-23", "08:00").toISOString());
  });
});

describe("U-CAL-02 closed-day roll", () => {
  it("skips an explicit closed date", () => {
    // Tuesday after cut-off → Wednesday 25th is closed → Thursday 26th.
    const window = resolveExecutionWindow(at("2026-11-24", "15:00"), ach, calendar);
    expect(window.businessDate).toBe("2026-11-26");
  });

  it("skips the weekend", () => {
    // Thursday after cut-off → Friday/Saturday closed → Sunday 29th.
    const window = resolveExecutionWindow(at("2026-11-26", "16:00"), ach, calendar);
    expect(window.businessDate).toBe("2026-11-29");
    expect(window.reason).toBe("AFTER_CUTOFF");
  });

  it("rolls a request made on a closed day even before the cut-off", () => {
    const window = resolveExecutionWindow(at("2026-11-27", "09:00"), ach, calendar);
    expect(window.reason).toBe("CLOSED_DAY");
    expect(window.businessDate).toBe("2026-11-29");
    expect(isBusinessDay("2026-11-27", calendar)).toBe(false);
    expect(nextBusinessDay("2026-11-27", calendar, true)).toBe("2026-11-29");
  });

  it("instant rail ignores cut-offs and closed days", () => {
    const requested = at("2026-11-27", "23:10");
    expect(resolveExecutionWindow(requested, lypay, calendar)).toEqual({
      executeAt: requested,
      businessDate: "2026-11-27",
      rolled: false,
    });
  });
});

describe("U-CAL-03 core offline window", () => {
  it("defers an internal posting requested inside the offline window (before midnight)", () => {
    const window = resolveExecutionWindow(at("2026-11-23", "23:45"), internal, calendar);
    expect(window.reason).toBe("CORE_OFFLINE");
    expect(window.executeAt.toISOString()).toBe(at("2026-11-24", "00:30").toISOString());
    expect(window.businessDate).toBe("2026-11-24");
  });

  it("defers an internal posting requested inside the offline window (after midnight)", () => {
    const window = resolveExecutionWindow(at("2026-11-24", "00:10"), internal, calendar);
    expect(window.reason).toBe("CORE_OFFLINE");
    expect(window.executeAt.toISOString()).toBe(at("2026-11-24", "00:30").toISOString());
  });

  it("posts immediately outside the window, including exactly at its end", () => {
    expect(resolveExecutionWindow(at("2026-11-24", "00:30"), internal, calendar).rolled).toBe(false);
    expect(resolveExecutionWindow(at("2026-11-23", "23:29"), internal, calendar).rolled).toBe(false);
  });
});

describe("U-CAL-04 future scheduling horizon", () => {
  it("allows up to 30 days ahead and nothing in the past", () => {
    const clock = new ManualClock(at("2026-11-23", "09:00"));
    expect(withinSchedulingHorizon(clock.now(), at("2026-12-23", "09:00"), TZ)).toBe(true);
    expect(withinSchedulingHorizon(clock.now(), at("2026-12-24", "00:00"), TZ)).toBe(false);
    expect(withinSchedulingHorizon(clock.now(), at("2026-11-23", "08:59"), TZ)).toBe(false);
    expect(withinSchedulingHorizon(clock.now(), clock.now(), TZ)).toBe(false);
  });
});

describe("U-CAL-05 month boundary and UTC vs business date", () => {
  it("uses the bank business date, not the UTC date", () => {
    // 22:30 UTC on 30 Nov is 00:30 on 1 Dec in Tripoli: a new business day AND a new month.
    const instant = new Date("2026-11-30T22:30:00.000Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(businessDateOf(instant, TZ)).toBe("2026-12-01");
    expect(usageWindows(instant, TZ)).toEqual({ day: "2026-12-01", month: "2026-12-01" });
  });

  it("keeps the previous business day just before local midnight", () => {
    const instant = new Date("2026-11-30T21:59:59.000Z");
    expect(usageWindows(instant, TZ)).toEqual({ day: "2026-11-30", month: "2026-11-01" });
  });

  it("month windows are calendar months, never 30 rolling days", () => {
    expect(monthStart("2026-01-31")).toBe("2026-01-01");
    expect(nextMonthStart("2026-01-31")).toBe("2026-02-01");
    expect(nextMonthStart("2026-12-15")).toBe("2027-01-01");
    expect(daysBetween("2026-02-01", "2026-03-01")).toBe(28);
    expect(daysBetween("2028-02-01", "2028-03-01")).toBe(29);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("is independent of the host time zone", () => {
    const previous = process.env["TZ"];
    try {
      for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
        process.env["TZ"] = zone;
        expect(businessDateOf(new Date("2026-11-30T22:30:00.000Z"), TZ)).toBe("2026-12-01");
        expect(zonedInstant("2026-11-23", "09:00", TZ).toISOString()).toBe("2026-11-23T07:00:00.000Z");
      }
    } finally {
      if (previous === undefined) delete process.env["TZ"];
      else process.env["TZ"] = previous;
    }
  });

  it("converts wall-clock time correctly in a zone with daylight saving", () => {
    // Generic correctness of the conversion helper (not a claim about any bank calendar).
    expect(zonedInstant("2026-03-29", "12:00", "Europe/Berlin").toISOString()).toBe("2026-03-29T10:00:00.000Z");
    expect(zonedInstant("2026-01-15", "12:00", "Europe/Berlin").toISOString()).toBe("2026-01-15T11:00:00.000Z");
  });
});
