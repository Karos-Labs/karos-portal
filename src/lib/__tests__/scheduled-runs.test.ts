import { describe, expect, it } from "vitest";
import { computeNextRun, describeCadence, weeklyCadenceDays } from "@/lib/scheduled-runs";

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

describe("computeNextRun — timezone-pinned", () => {
  // Sao Paulo is UTC-3 with no DST today; Kolkata is UTC+5:30. Asserting in UTC
  // keeps these independent of the machine the suite runs on — which is the
  // whole point of the field.
  const SP = "America/Sao_Paulo";
  const utc = (y: number, mo: number, d: number, h = 0, min = 0) => Date.UTC(y, mo, d, h, min);

  it("fires at the picked wall clock in the schedule's zone, not the runtime's", () => {
    // Monday 2026-07-06, 09:00 in Sao Paulo === 12:00 UTC.
    const from = utc(2026, 6, 6, 0);
    expect(computeNextRun({ cadence: "weekly", weekday: 1, hour: 9, minute: 0, from, timeZone: SP }))
      .toBe(utc(2026, 6, 6, 12));
  });

  it("half-hour offsets land on the right instant", () => {
    // Daily 09:00 Asia/Kolkata (UTC+5:30) === 03:30 UTC.
    const from = utc(2026, 6, 6, 0);
    expect(computeNextRun({ cadence: "daily", hour: 9, minute: 0, from, timeZone: "Asia/Kolkata" }))
      .toBe(utc(2026, 6, 6, 3, 30));
  });

  it("keeps a fixed wall clock across a DST transition", () => {
    // US DST ends 2026-11-01. A daily 09:00 New York slot is 13:00 UTC before
    // and 14:00 UTC after — a hardcoded offset would drift by an hour.
    const before = computeNextRun({
      cadence: "daily", hour: 9, minute: 0, timeZone: "America/New_York",
      from: utc(2026, 9, 20, 0),
    });
    const after = computeNextRun({
      cadence: "daily", hour: 9, minute: 0, timeZone: "America/New_York",
      from: utc(2026, 10, 5, 0),
    });
    expect(new Date(before).getUTCHours()).toBe(13);
    expect(new Date(after).getUTCHours()).toBe(14);
  });

  it("monthly still clamps to the last day of a short month", () => {
    const next = computeNextRun({
      cadence: "monthly", dayOfMonth: 31, hour: 9, minute: 0, timeZone: SP,
      from: utc(2026, 8, 5, 12), // 2026-09-05
    });
    // 2026-09-30 09:00 Sao Paulo === 12:00 UTC.
    expect(next).toBe(utc(2026, 8, 30, 12));
  });

  it("ignores an unresolvable zone rather than throwing", () => {
    expect(computeNextRun({ cadence: "daily", hour: 9, minute: 0, from: MON_8AM, timeZone: "Mars/Olympus" }))
      .toBe(local(2026, 6, 6, 9));
  });

  it("always returns a time strictly in the future", () => {
    const from = utc(2026, 6, 6, 12); // exactly the 09:00 SP slot
    expect(computeNextRun({ cadence: "daily", hour: 9, minute: 0, from, timeZone: SP }))
      .toBeGreaterThan(from);
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

  it("names the zone when the schedule carries one", () => {
    expect(describeCadence({
      cadence: "weekly",
      weekday: 1,
      hour: 9,
      minute: 0,
      nextRunAt: Date.UTC(2026, 6, 6, 12),
      timeZone: "America/Sao_Paulo",
    })).toBe("Weekly · Mon 09:00 GMT-3");
  });
});

describe("weeklyCadenceDays", () => {
  it("spreads the requested post count over balanced days", () => {
    expect(weeklyCadenceDays(1)).toEqual([2]);
    expect(weeklyCadenceDays(3)).toEqual([1, 3, 5]);
    expect(weeklyCadenceDays(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
