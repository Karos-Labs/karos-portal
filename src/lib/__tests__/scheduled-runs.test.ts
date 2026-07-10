import { describe, expect, it } from "vitest";
import { computeNextRun, describeCadence } from "@/lib/scheduled-runs";

/** Local-time constructor keeps assertions timezone-independent. */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m, d, h, min, 0, 0).getTime();
}

// 2026-07-06 is a Monday.
const MON_8AM = local(2026, 6, 6, 8);

describe("computeNextRun", () => {
  it("daily: same-day slot when the time is still ahead", () => {
    expect(computeNextRun({ cadence: "daily", hour: 9, minute: 0, from: MON_8AM }))
      .toBe(local(2026, 6, 6, 9));
  });

  it("daily: rolls to tomorrow once today's slot has passed", () => {
    expect(computeNextRun({ cadence: "daily", hour: 7, minute: 30, from: MON_8AM }))
      .toBe(local(2026, 6, 7, 7, 30));
  });

  it("weekly: advances to the next matching weekday", () => {
    // From Monday, the next Thursday (weekday 4) at 10:00.
    expect(computeNextRun({ cadence: "weekly", weekday: 4, hour: 10, minute: 0, from: MON_8AM }))
      .toBe(local(2026, 6, 9, 10));
  });

  it("weekly: same weekday but earlier time jumps a full week", () => {
    // Monday 08:00 asking for Monday 07:00 ⇒ next Monday.
    expect(computeNextRun({ cadence: "weekly", weekday: 1, hour: 7, minute: 0, from: MON_8AM }))
      .toBe(local(2026, 6, 13, 7));
  });

  it("monthly: fires on the requested day of month", () => {
    expect(computeNextRun({ cadence: "monthly", dayOfMonth: 15, hour: 9, minute: 0, from: MON_8AM }))
      .toBe(local(2026, 6, 15, 9));
  });

  it("monthly: clamps day 31 to the last day of a short month", () => {
    // Sept has 30 days — a "31st" schedule lands on the 30th.
    const from = local(2026, 8, 5, 8); // 2026-09-05
    const next = computeNextRun({ cadence: "monthly", dayOfMonth: 31, hour: 9, minute: 0, from });
    expect(next).toBe(local(2026, 8, 30, 9));
  });

  it("always returns a time strictly in the future", () => {
    const next = computeNextRun({ cadence: "daily", hour: 8, minute: 0, from: MON_8AM });
    expect(next).toBeGreaterThan(MON_8AM);
  });
});

describe("describeCadence", () => {
  it("summarizes a weekly cadence", () => {
    expect(describeCadence({ cadence: "weekly", weekday: 1, hour: 9, minute: 0, nextRunAt: MON_8AM }))
      .toBe("Weekly · Mon 09:00");
  });

  it("summarizes a daily cadence", () => {
    expect(describeCadence({ cadence: "daily", hour: 14, minute: 30, nextRunAt: MON_8AM }))
      .toBe("Daily · 14:30");
  });
});
