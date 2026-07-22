import { describe, expect, it } from "vitest";
import { computeNextRunAt, describeCadence, isValidCadence } from "../run-cadence";
import type { RunCadence } from "../types";

const BRT: RunCadence = { daysOfWeek: [2, 3, 4], hour: 9, minute: 0, timezone: "America/Sao_Paulo" };

/** Wall-clock hour:minute observed in a timezone for a given instant. */
function localHM(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function localWeekday(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms));
}

describe("computeNextRunAt", () => {
  it("lands on the exact local wall-clock time regardless of the server's zone", () => {
    // A Monday — next Tue/Wed/Thu slot is the following day.
    const from = Date.parse("2026-07-13T18:00:00Z"); // Mon
    const next = computeNextRunAt(BRT, from);
    expect(localHM(next, BRT.timezone)).toBe("09:00");
    expect(["Tue", "Wed", "Thu"]).toContain(localWeekday(next, BRT.timezone));
    expect(next).toBeGreaterThan(from);
  });

  it("rolls to the next matching weekday when today's slot already passed", () => {
    // Tuesday 15:00 BRT — 09:00 is gone, so the next slot is Wednesday 09:00.
    const tueAfternoon = Date.parse("2026-07-14T18:00:00Z"); // Tue ~15:00 BRT
    const next = computeNextRunAt(BRT, tueAfternoon);
    expect(localWeekday(next, BRT.timezone)).toBe("Wed");
    expect(localHM(next, BRT.timezone)).toBe("09:00");
  });

  it("from a Friday rolls forward to the next Tuesday", () => {
    const fri = Date.parse("2026-07-17T12:00:00Z"); // Fri
    const next = computeNextRunAt(BRT, fri);
    expect(localWeekday(next, BRT.timezone)).toBe("Tue");
  });

  it("returns strictly future instants and stays at local 09:00 across a DST-style zone", () => {
    // New York observes DST; assert the wall-clock is preserved either side of it.
    const ny: RunCadence = { daysOfWeek: [1], hour: 9, minute: 30, timezone: "America/New_York" };
    const beforeDst = Date.parse("2026-03-01T12:00:00Z");
    const afterDst = Date.parse("2026-04-01T12:00:00Z");
    expect(localHM(computeNextRunAt(ny, beforeDst), ny.timezone)).toBe("09:30");
    expect(localHM(computeNextRunAt(ny, afterDst), ny.timezone)).toBe("09:30");
  });
});

describe("isValidCadence", () => {
  it("accepts a well-formed cadence", () => {
    expect(isValidCadence(BRT)).toBe(true);
  });
  it("rejects empty days, out-of-range time, and bad timezones", () => {
    expect(isValidCadence({ ...BRT, daysOfWeek: [] })).toBe(false);
    expect(isValidCadence({ ...BRT, daysOfWeek: [7] })).toBe(false);
    expect(isValidCadence({ ...BRT, hour: 24 })).toBe(false);
    expect(isValidCadence({ ...BRT, minute: 60 })).toBe(false);
    expect(isValidCadence({ ...BRT, timezone: "Not/AZone" })).toBe(false);
  });
});

describe("describeCadence", () => {
  it("renders a sorted, readable summary", () => {
    expect(describeCadence(BRT)).toBe("Tue, Wed, Thu · 09:00 America/Sao_Paulo");
  });
});
