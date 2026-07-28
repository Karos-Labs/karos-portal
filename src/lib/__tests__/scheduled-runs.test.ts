import { describe, expect, it } from "vitest";
import {
  clientCadenceLabel,
  computeNextRun,
  describeCadence,
  projectRunOccurrences,
  weeklyCadenceDays,
} from "@/lib/scheduled-runs";

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

describe("clientCadenceLabel", () => {
  it("states pace, not runs, for a multi-day weekly cadence", () => {
    expect(
      clientCadenceLabel({
        cadence: "weekly",
        weekdays: [1, 3, 5],
        hour: 9,
        minute: 0,
        nextRunAt: MON_8AM,
      }),
    ).toBe("3 posts a week · Mon, Wed, Fri 09:00");
  });

  it("switches to DAYS when the schedule batches several outputs per fire", () => {
    // 3 fires × 5 outputs is 15 posts a week. Calling that "3 posts a week"
    // would be false, and naming the runs would state the batch shape — so the
    // honest client-side name for the same dial is the posting days.
    expect(
      clientCadenceLabel({
        cadence: "weekly",
        weekdays: [1, 3, 5],
        hour: 9,
        minute: 0,
        nextRunAt: MON_8AM,
        outputsPerRun: 5,
      }),
    ).toBe("3 posting days a week · Mon, Wed, Fri 09:00");
  });

  it("never prints the run mechanics the staff label carries", () => {
    const staff = describeCadence({
      cadence: "weekly",
      weekdays: [1, 3, 5],
      hour: 9,
      minute: 0,
      nextRunAt: MON_8AM,
    });
    const client = clientCadenceLabel({
      cadence: "weekly",
      weekdays: [1, 3, 5],
      hour: 9,
      minute: 0,
      nextRunAt: MON_8AM,
    });
    expect(staff).toContain("×");
    expect(client).not.toContain("×");
    expect(client.toLowerCase()).not.toContain("run");
  });

  it("keeps the wall clock and its zone — time of day is pace, not mechanics", () => {
    expect(
      clientCadenceLabel({
        cadence: "daily",
        hour: 9,
        minute: 0,
        nextRunAt: Date.UTC(2026, 6, 6, 12),
        timeZone: "America/Sao_Paulo",
      }),
    ).toBe("Every day · 09:00 GMT-3");
  });

  it("covers the single-weekday and monthly cadences", () => {
    expect(
      clientCadenceLabel({ cadence: "weekly", weekday: 1, hour: 9, minute: 0, nextRunAt: MON_8AM }),
    ).toBe("1 post a week · Mon 09:00");
    expect(
      clientCadenceLabel({ cadence: "monthly", dayOfMonth: 3, hour: 9, minute: 0, nextRunAt: MON_8AM }),
    ).toBe("Every month · 3rd 09:00");
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

  /**
   * F108. Only the FIRST occurrence comes from the stored nextRunAt, which the
   * scheduler computed in the schedule's own zone. Every later one is
   * recomputed by this function, so an unthreaded zone makes the calendar
   * disagree with itself: chip 1 right, chips 2..n on the runtime's clock (UTC
   * in production). Asserted in the schedule's zone rather than the test
   * runner's, so these hold wherever the suite runs.
   */
  describe("zone-pinned projection", () => {
    /** The wall clock the given zone reads at an instant. */
    function wall(zone: string, at: number): { hour: number; weekday: string } {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "2-digit",
        hour12: false,
        weekday: "short",
      }).formatToParts(new Date(at));
      return {
        hour: Number(parts.find((p) => p.type === "hour")!.value),
        weekday: parts.find((p) => p.type === "weekday")!.value,
      };
    }

    it("keeps every Sao Paulo occurrence at 09:00 local, not the runtime's 06:00", () => {
      const zone = "America/Sao_Paulo";
      const base = {
        cadence: "daily" as const,
        hour: 9,
        minute: 0,
      };
      const nextRunAt = computeNextRun({ ...base, from: MON_8AM, timeZone: zone });
      const occurrences = projectRunOccurrences(
        { ...base, nextRunAt },
        { from: MON_8AM, horizonDays: 14, timeZone: zone },
      );
      expect(occurrences.length).toBeGreaterThan(10);
      // The whole projection, not just the stored first fire.
      for (const at of occurrences) expect(wall(zone, at).hour).toBe(9);
    });

    it("keeps a Tokyo 22:00 weekday run on weekdays — no weekend chip", () => {
      const zone = "Asia/Tokyo";
      const base = {
        cadence: "weekly" as const,
        weekdays: [1, 2, 3, 4, 5],
        hour: 22,
        minute: 0,
      };
      const nextRunAt = computeNextRun({ ...base, from: MON_8AM, timeZone: zone });
      const occurrences = projectRunOccurrences(
        { ...base, nextRunAt },
        { from: MON_8AM, horizonDays: 21, timeZone: zone },
      );
      expect(occurrences.length).toBeGreaterThan(5);
      for (const at of occurrences) {
        const { hour, weekday } = wall(zone, at);
        expect(hour).toBe(22);
        // 22:00 in Tokyo is 13:00 UTC the same day, but 09:00 the NEXT day in
        // Auckland and the previous evening in New York — a projection on any
        // clock but Tokyo's drifts across the date line into Sat/Sun.
        expect(["Sat", "Sun"]).not.toContain(weekday);
      }
    });

    it("without a zone the walk falls back to the runtime clock (legacy rows)", () => {
      // Not an endorsement — the documented legacy behaviour, pinned so that
      // dropping the argument at a call site shows up as a diff here.
      const run = { cadence: "daily" as const, hour: 9, minute: 0, nextRunAt: local(2026, 6, 6, 9) };
      expect(projectRunOccurrences(run, { from: MON_8AM, horizonDays: 2 })).toEqual([
        local(2026, 6, 6, 9),
        local(2026, 6, 7, 9),
      ]);
    });
  });
});

describe("weeklyCadenceDays", () => {
  it("spreads the requested post count over balanced days", () => {
    expect(weeklyCadenceDays(1)).toEqual([2]);
    expect(weeklyCadenceDays(3)).toEqual([1, 3, 5]);
    expect(weeklyCadenceDays(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
