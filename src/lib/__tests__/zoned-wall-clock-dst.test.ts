import { describe, expect, it } from "vitest";
import { computeNextRunAt, zonedWallToUtc } from "@/lib/run-cadence";
import { computeNextRun } from "@/lib/scheduled-runs";
import type { RunCadence } from "@/lib/types";

/** The wall clock `timezone` shows at `at`, as "YYYY-MM-DD HH:MM". */
function wallClock(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

const iso = (s: string) => Date.parse(s);

/**
 * `zonedWallToUtc` turns a schedule's INTENT (a wall clock plus a zone) into the
 * instant it fires at. Twice a year that mapping is not one-to-one, and the old
 * body's answer depended on the SIGN of the zone's offset, because it sampled
 * the offset once near the naive instant and let the second pass correct it:
 *
 *   · west of UTC, a spring-forward 02:30 America/New_York came back as 01:30
 *     EST — an hour EARLY, and BEFORE the gap it was meant to land after;
 *   · east of UTC the same shape already shifted forward correctly;
 *   · the fall-back case picked the earlier occurrence west of UTC and the
 *     later one east of it, while the comment claimed "the earlier occurrence"
 *     with no qualifier.
 *
 * The rule now: the EARLIEST instant at which the zone shows the requested wall
 * clock; and when it never shows it, the request shifted later by the gap.
 * These cases are pinned to real 2026 transitions on both sides of UTC.
 */
describe("zonedWallToUtc — a wall clock that happens twice, or not at all", () => {
  it("shifts a nonexistent spring-forward wall clock LATER, never earlier (west of UTC)", () => {
    // 2026-03-08, America/New_York: 02:00 EST jumps to 03:00 EDT. 02:30 is in
    // the gap. The old body returned 06:30Z = 01:30 EST, an hour early.
    const at = zonedWallToUtc(2026, 3, 8, 2, 30, "America/New_York");
    expect(wallClock(at, "America/New_York")).toBe("2026-03-08 03:30");
    expect(at).toBe(iso("2026-03-08T07:30:00Z"));
    expect(at).toBeGreaterThan(iso("2026-03-08T06:30:00Z"));
  });

  it("shifts a nonexistent spring-forward wall clock LATER east of UTC too", () => {
    // 2026-03-29, Europe/Berlin: 02:00 CET jumps to 03:00 CEST.
    const at = zonedWallToUtc(2026, 3, 29, 2, 30, "Europe/Berlin");
    expect(wallClock(at, "Europe/Berlin")).toBe("2026-03-29 03:30");
    expect(at).toBe(iso("2026-03-29T01:30:00Z"));
  });

  it("shifts by the size of the gap, not to a fixed hour (a 30-minute transition)", () => {
    // Australia/Lord_Howe springs forward by THIRTY minutes: 02:00 → 02:30.
    // A rule that jumped to "the next hour" would answer 03:15 here.
    const at = zonedWallToUtc(2026, 10, 4, 2, 15, "Australia/Lord_Howe");
    expect(wallClock(at, "Australia/Lord_Howe")).toBe("2026-10-04 02:45");
  });

  it("picks the EARLIER of two occurrences on a fall-back day, west of UTC", () => {
    // 2026-11-01, America/New_York: 02:00 EDT falls back to 01:00 EST, so
    // 01:30 happens twice — 05:30Z (EDT) and 06:30Z (EST).
    const at = zonedWallToUtc(2026, 11, 1, 1, 30, "America/New_York");
    expect(at).toBe(iso("2026-11-01T05:30:00Z"));
    expect(wallClock(at, "America/New_York")).toBe("2026-11-01 01:30");
  });

  it("picks the EARLIER of two occurrences on a fall-back day, east of UTC", () => {
    // 2026-10-25, Europe/Berlin: 03:00 CEST falls back to 02:00 CET, so 02:30
    // happens at 00:30Z (CEST) and again at 01:30Z (CET). The old body returned
    // the LATER one here while its comment promised the earlier.
    const at = zonedWallToUtc(2026, 10, 25, 2, 30, "Europe/Berlin");
    expect(at).toBe(iso("2026-10-25T00:30:00Z"));
    expect(wallClock(at, "Europe/Berlin")).toBe("2026-10-25 02:30");
  });

  it("never returns an instant showing a wall clock earlier than the one asked for", () => {
    // The property, over both transitions in both hemispheres and every half
    // hour of the transition day — a schedule firing EARLY is the direction
    // that puts a client's post out at a time they did not choose.
    const days: Array<[string, number, number, number]> = [
      ["America/New_York", 2026, 3, 8],
      ["America/New_York", 2026, 11, 1],
      ["Europe/Berlin", 2026, 3, 29],
      ["Europe/Berlin", 2026, 10, 25],
      ["Australia/Sydney", 2026, 4, 5],
      ["Australia/Sydney", 2026, 10, 4],
      ["Pacific/Auckland", 2026, 4, 5],
      ["America/Santiago", 2026, 9, 6],
      ["America/Sao_Paulo", 2026, 10, 18], // no DST — the control
    ];
    for (const [zone, y, mo, d] of days) {
      for (let hour = 0; hour < 24; hour++) {
        for (const minute of [0, 30]) {
          const at = zonedWallToUtc(y, mo, d, hour, minute, zone);
          const asked = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          const got = wallClock(at, zone);
          // String compare is a chronological compare in this fixed-width form.
          expect(got >= asked, `${zone} ${asked} → ${got}`).toBe(true);
        }
      }
    }
  });

  it("still round-trips every ordinary wall clock exactly", () => {
    const zones = ["UTC", "America/Sao_Paulo", "Asia/Tokyo", "Asia/Kolkata", "Europe/London"];
    for (const zone of zones) {
      for (const [y, mo, d] of [[2026, 2, 17], [2026, 7, 4], [2026, 12, 31]] as const) {
        for (const hour of [0, 9, 13, 23]) {
          const at = zonedWallToUtc(y, mo, d, hour, 45, zone);
          expect(wallClock(at, zone), `${zone} ${y}-${mo}-${d} ${hour}:45`).toBe(
            `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(hour).padStart(2, "0")}:45`,
          );
        }
      }
    }
  });
});

/**
 * The two schedulers that turn a stored cadence into a fire time both go
 * through `zonedWallToUtc`, so the gap rule has to survive their day walks —
 * this is the failure a client would actually see, an agent run going out an
 * hour before the time on the schedule.
 */
describe("both schedulers fire on the far side of a spring-forward gap", () => {
  it("computeNextRunAt (ScheduledRun) lands at 03:30, not 01:30", () => {
    // 2026-03-08 is a Sunday in New York and the day the clocks go forward.
    const cadence: RunCadence = {
      daysOfWeek: [0],
      hour: 2,
      minute: 30,
      timezone: "America/New_York",
    };
    const from = iso("2026-03-08T05:00:00Z"); // Sun 00:00 EST, before the gap
    const next = computeNextRunAt(cadence, from);
    expect(wallClock(next, "America/New_York")).toBe("2026-03-08 03:30");
    expect(next).toBeGreaterThan(from);
  });

  it("computeNextRun (PlannedScheduledRun) lands at 03:30, not 01:30", () => {
    const next = computeNextRun({
      cadence: "weekly",
      hour: 2,
      minute: 30,
      weekdays: [0],
      timeZone: "America/New_York",
      from: iso("2026-03-08T05:00:00Z"),
    });
    expect(wallClock(next, "America/New_York")).toBe("2026-03-08 03:30");
  });

  it("leaves an ordinary week alone — the gap rule is not a blanket shift", () => {
    const cadence: RunCadence = {
      daysOfWeek: [1],
      hour: 9,
      minute: 0,
      timezone: "America/New_York",
    };
    const next = computeNextRunAt(cadence, iso("2026-06-01T00:00:00Z"));
    expect(wallClock(next, "America/New_York")).toBe("2026-06-01 09:00");
  });
});
