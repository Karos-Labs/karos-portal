import { describe, expect, it } from "vitest";
import {
  atHour,
  bestPublishHour,
  describeBestHour,
  MIN_HOUR_LIFT,
  MIN_PUBLISHES_FOR_HOUR,
  MIN_PUBLISHES_PER_HOUR,
  type MeasuredPublish,
} from "@/lib/best-hour";

/**
 * The hour a post goes out is a recommendation a reviewer accepts with one
 * click, so the refusals matter more than the answers: a wrong hour proposed
 * confidently moves every post a client publishes, and the reviewer has no way
 * to tell it was guessed. Every rule below is a rule about when this stays
 * quiet and leaves the density planner exactly as it was.
 */

/** A post at `hour` on a fixed day, so the local-hour read is the thing under test. */
function at(hour: number, engagementScore: number, over: Partial<MeasuredPublish> = {}): MeasuredPublish {
  const day = new Date(2026, 8, 14, hour, 0, 0, 0);
  return { publishedAt: day.getTime(), engagementScore, source: "live", platform: "linkedin", ...over };
}

function many(hour: number, score: number, n: number): MeasuredPublish[] {
  return Array.from({ length: n }, () => at(hour, score));
}

describe("what it refuses to conclude", () => {
  it("says nothing from mock rows, however many there are", () => {
    const mock = Array.from({ length: 40 }, () => at(18, 90, { source: "mock" }));
    const result = bestPublishHour(mock, "linkedin");
    expect(result.best).toBeUndefined();
    expect(result.refusal).toMatch(/^0 published linkedin post/);
  });

  it("waits until the account has published enough to have an hour at all", () => {
    const thin = many(9, 80, MIN_PUBLISHES_FOR_HOUR - 1);
    expect(bestPublishHour(thin, "linkedin").refusal).toMatch(/are needed before an hour means anything/);
  });

  it("will not let an hour vote on two posts", () => {
    const posts = [...many(9, 40, 10), ...many(18, 99, MIN_PUBLISHES_PER_HOUR - 1)];
    expect(bestPublishHour(posts, "linkedin").best).toBeUndefined();
  });

  it("drops a difference too small to move a post for", () => {
    const posts = [...many(9, 50, 10), ...many(18, 52, 4)];
    expect(bestPublishHour(posts, "linkedin").best).toBeUndefined();
  });

  it("refuses an account with no measured engagement rather than dividing by zero", () => {
    expect(bestPublishHour(many(9, 0, 12), "linkedin").refusal).toMatch(/every published post scores zero/);
  });

  it("ignores another platform's hours", () => {
    const posts = [...many(9, 40, 10), ...Array.from({ length: 6 }, () => at(21, 99, { platform: "instagram" }))];
    expect(bestPublishHour(posts, "linkedin").best).toBeUndefined();
  });

  it("ignores a row whose post never actually published", () => {
    // `capturedAt` says when the numbers were fetched; a row with no publish
    // moment is not evidence about publishing times. The caller drops those,
    // and a zero sneaking through must not be read as midnight.
    const posts = [...many(9, 40, 10), ...Array.from({ length: 5 }, () => at(0, 99, { publishedAt: 0 }))];
    const result = bestPublishHour(posts, "linkedin");
    expect(result.best?.hour).not.toBe(0);
  });
});

describe("what it does conclude", () => {
  it("names the hour whose median beats the account's own", () => {
    const posts = [...many(9, 40, 10), ...many(18, 80, 4)];
    const result = bestPublishHour(posts, "linkedin");
    expect(result.best).toMatchObject({ hour: 18, posts: 4 });
    expect(result.best!.lift).toBeGreaterThan(1 + MIN_HOUR_LIFT);
  });

  it("uses the median, so one runaway post cannot elect its hour", () => {
    // With a MEAN the single 1000 at 21:00 wins by itself. The median says
    // 21:00 is an ordinary hour with one lucky post in it, which it is.
    const posts = [...many(9, 60, 10), ...many(21, 30, 3), at(21, 1000, {})];
    expect(bestPublishHour(posts, "linkedin").best?.hour).not.toBe(21);
  });

  it("puts a sentence a reviewer can argue with beside the slot", () => {
    const best = bestPublishHour([...many(9, 40, 10), ...many(18, 80, 4)], "linkedin").best!;
    expect(describeBestHour(best)).toBe(`your 18:00 posts score ${best.lift}x your own median across 4 published posts`);
  });
});

describe("moving the slot", () => {
  const now = new Date(2026, 8, 14, 10, 0, 0, 0).getTime();

  it("keeps the planner's day and changes only the clock", () => {
    const slot = new Date(2026, 8, 16, 11, 30, 0, 0).getTime();
    const moved = atHour(slot, 18, now)!;
    expect(new Date(moved).getDate()).toBe(16);
    expect(new Date(moved).getHours()).toBe(18);
    expect(new Date(moved).getMinutes()).toBe(0);
  });

  it("refuses to move a slot into the past", () => {
    // A recommendation the reviewer cannot accept is worse than the one they
    // already had: the caller keeps the density planner's slot.
    const slot = new Date(2026, 8, 14, 16, 0, 0, 0).getTime();
    expect(atHour(slot, 7, now)).toBeNull();
  });
});
