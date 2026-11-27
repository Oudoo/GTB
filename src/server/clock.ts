/**
 * Clock port. Domain code never calls `new Date()` directly for business decisions; it asks
 * the injected clock. Tests use `ManualClock`; the sandbox can shift time forward through the
 * simulator (operations permission, sandbox only) so cut-off and scheduling flows can be
 * demonstrated without waiting for real time (PAY-03).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
});

/** Real time shifted by a fixed offset (sandbox clock control). */
export class OffsetClock implements Clock {
  constructor(private readonly offsetMs: number) {}
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

/** Fully controlled clock for deterministic tests. */
export class ManualClock implements Clock {
  private current: number;
  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
    if (Number.isNaN(this.current)) throw new Error("Invalid ManualClock start");
  }
  now(): Date {
    return new Date(this.current);
  }
  set(instant: Date | string): void {
    const next = new Date(instant).getTime();
    if (Number.isNaN(next)) throw new Error("Invalid instant");
    this.current = next;
  }
  advanceMs(ms: number): void {
    this.current += ms;
  }
  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }
  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000);
  }
}
