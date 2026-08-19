import { describe, expect, it } from "vitest";
import { inferSuggestionDates } from "@/lib/calendar-suggestion-placement";
import { sameLocalDay } from "@/lib/scheduling";

/**
 * REPORTED LIVE (2026-08, "pitch by deel"): every recommended task landed on
 * the exact same calendar day instead of being spread out.
 *
 * Root cause: `recommendPublishTimeWithDensity` (scheduling.ts) falls back to
 * its OWN plain, non-density slot — always the identical fixed instant —
 * once its internal 90-candidate walk is exhausted. A client whose calendar
 * is already booked solid for weeks (an active chain-scheduled client is a
 * completely ordinary case, not a contrived one) hits that exhaustion easily,
 * and once one suggestion is placed there `working` only grows, making
 * exhaustion MORE likely for every suggestion after it — so the whole batch
 * collapses onto one instant, worst case starting from the very first one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A stable "now": next Monday 09:00 local, so weekday-window math is deterministic regardless of when the suite runs. */
function nextMonday(): number {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  const delta = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d.getTime();
}

function distinctDayCount(dates: number[]): number {
  const seen: number[] = [];
  for (const t of dates) {
    if (!seen.some((s) => sameLocalDay(s, t))) seen.push(t);
  }
  return seen.length;
}

describe("inferSuggestionDates", () => {
  it("spreads suggestions across different days when the calendar is empty", () => {
    const now = nextMonday();
    const suggestions = [
      { id: "a", platform: "linkedin", priority: "high" as const },
      { id: "b", platform: "linkedin", priority: "medium" as const },
      { id: "c", platform: "linkedin", priority: "low" as const },
    ];
    const dates = inferSuggestionDates(suggestions, [], now);
    expect(distinctDayCount([...dates.values()])).toBe(3);
  });

  it("still spreads across different days when the near-term calendar is booked solid for weeks (the reported bug)", () => {
    const now = nextMonday();
    // Every weekday for 12 weeks already has one booked asset — a realistic
    // shape for an active client whose content chain schedules continuously,
    // and dense enough to exhaust recommendPublishTimeWithDensity's internal
    // 90-candidate walk for every platform.
    const booked: number[] = [];
    for (let dayOffset = 0; dayOffset < 84; dayOffset++) {
      const day = new Date(now + dayOffset * DAY_MS);
      const weekday = day.getDay();
      if (weekday === 0 || weekday === 6) continue;
      day.setHours(10, 0, 0, 0);
      booked.push(day.getTime());
    }

    const suggestions = [
      { id: "a", platform: "linkedin", priority: "high" as const },
      { id: "b", platform: "linkedin", priority: "medium" as const },
      { id: "c", platform: "twitter", priority: "medium" as const },
      { id: "d", platform: undefined, priority: "low" as const },
      { id: "e", platform: "instagram", priority: "low" as const },
    ];
    const dates = inferSuggestionDates(suggestions, booked, now);

    expect(dates.size).toBe(5);
    expect(distinctDayCount([...dates.values()])).toBe(5);
    // None of them may reuse a day the client's real calendar already booked.
    for (const at of dates.values()) {
      expect(booked.some((b) => sameLocalDay(b, at))).toBe(false);
    }
  });

  it("keeps assigning distinct days for a platform with no known engagement window (firstOpenDay fallback), even past the horizon", () => {
    const now = nextMonday();
    const booked: number[] = [];
    for (let dayOffset = 0; dayOffset < 40; dayOffset++) {
      const day = new Date(now + dayOffset * DAY_MS);
      day.setHours(10, 0, 0, 0);
      booked.push(day.getTime()); // every single day booked, weekends included
    }

    const suggestions = [
      { id: "a", platform: "google_business_profile", priority: "high" as const },
      { id: "b", platform: "google_business_profile", priority: "medium" as const },
      { id: "c", platform: "google_business_profile", priority: "low" as const },
    ];
    // Default 14-day horizon is fully booked, so every one of these must
    // overflow past it — but still onto three DIFFERENT days, not one.
    const dates = inferSuggestionDates(suggestions, booked, now, 14);

    expect(distinctDayCount([...dates.values()])).toBe(3);
    for (const at of dates.values()) {
      expect(booked.some((b) => sameLocalDay(b, at))).toBe(false);
    }
  });

  it("orders placement by priority (high first) even though output order follows the input array", () => {
    const now = nextMonday();
    const suggestions = [
      { id: "low-one", platform: "linkedin", priority: "low" as const },
      { id: "high-one", platform: "linkedin", priority: "high" as const },
    ];
    const dates = inferSuggestionDates(suggestions, [], now);
    // High priority is placed first, so it gets the earlier/closer slot.
    expect(dates.get("high-one")!).toBeLessThan(dates.get("low-one")!);
  });
});
