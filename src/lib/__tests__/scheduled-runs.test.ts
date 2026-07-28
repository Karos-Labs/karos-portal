import { describe, expect, it } from "vitest";
import { computeNextRun, describeCadence, projectRunOccurrences, weeklyCadenceDays } from "@/lib/scheduled-runs";

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

  it("weekly: advances across multiple publishing days", () => {
    expect(computeNextRun({
      cadence: "weekly",
      weekdays: [1, 3, 5],
      hour: 9,
      minute: 0,
      from: MON_8AM,
    })).toBe(local(2026, 6, 6, 9));
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

  it("summarizes an always-on multi-day weekly cadence", () => {
    expect(describeCadence({
      cadence: "weekly",
      weekdays: [1, 3, 5],
      hour: 9,
      minute: 0,
      nextRunAt: MON_8AM,
    })).toBe("3× weekly · Mon, Wed, Fri 09:00");
  });
});

describe("projectRunOccurrences", () => {
  it("projects a 5x/week schedule to one occurrence per weekday, not just the next fire", () => {
    const run = {
      cadence: "weekly" as const,
      weekdays: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0,
      nextRunAt: computeNextRun({ cadence: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0, from: MON_8AM }),
    };
    const occurrences = projectRunOccurrences(run, { from: MON_8AM, horizonDays: 14 });
    // Two full Mon-Fri weeks within a 14-day horizon.
    expect(occurrences).toHaveLength(10);
    expect(occurrences[0]).toBe(local(2026, 6, 6, 9)); // Mon
    expect(occurrences[4]).toBe(local(2026, 6, 10, 9)); // Fri
    expect(occurrences[5]).toBe(local(2026, 6, 13, 9)); // next Mon
    // Strictly increasing, one per calendar day.
    for (let i = 1; i < occurrences.length; i++) expect(occurrences[i]).toBeGreaterThan(occurrences[i - 1]);
  });

  it("a one-off ('once') run yields exactly its single stored nextRunAt", () => {
    const at = local(2026, 6, 10, 9);
    expect(projectRunOccurrences({ cadence: "once", hour: 9, minute: 0, nextRunAt: at }, { from: MON_8AM })).toEqual([at]);
  });

  it("a one-off run outside the horizon yields nothing", () => {
    const farAway = local(2027, 0, 1, 9);
    expect(
      projectRunOccurrences({ cadence: "once", hour: 9, minute: 0, nextRunAt: farAway }, { from: MON_8AM, horizonDays: 14 }),
    ).toEqual([]);
  });

  it("respects a custom horizon and stops including that boundary", () => {
    const run = { cadence: "daily" as const, hour: 9, minute: 0, nextRunAt: local(2026, 6, 6, 9) };
    const occurrences = projectRunOccurrences(run, { from: MON_8AM, horizonDays: 4 });
    expect(occurrences).toEqual([
      local(2026, 6, 6, 9),
      local(2026, 6, 7, 9),
      local(2026, 6, 8, 9),
      local(2026, 6, 9, 9),
    ]);
  });
});

describe("weeklyCadenceDays", () => {
  it("spreads the requested post count over balanced days", () => {
    expect(weeklyCadenceDays(1)).toEqual([2]);
    expect(weeklyCadenceDays(3)).toEqual([1, 3, 5]);
    expect(weeklyCadenceDays(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
