import { describe, expect, it } from "vitest";
import { monthlyPerformance, PERFORMANCE_WINDOW_DAYS } from "@/lib/client-performance";

/**
 * This is the one projection in the app whose output a CLIENT reads about
 * their own money, so every rule here is a rule about honesty rather than
 * about arithmetic. A mock number shown to a client is a lie they cannot
 * detect; a follower "rise" drawn from one reading is a claim about a period
 * nobody measured; a post from March counted as last month's work is a
 * renewal conversation built on the wrong month.
 */

const NOW = new Date("2026-09-25T12:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

function asset(id: string, publishedAt: number | null, title = `Post ${id}`) {
  return { id, clientId: "c1", title, type: "social_post", status: "published", ...(publishedAt === null ? {} : { publishedAt }) } as never;
}

function row(assetId: string, score: number, over: Record<string, unknown> = {}) {
  return { id: `r-${assetId}`, clientId: "c1", assetId, platform: "linkedin", metrics: {}, engagementScore: score, source: "live", capturedAt: NOW, createdAt: NOW, ...over } as never;
}

function snapshot(platform: string, count: number, capturedAt: number) {
  return { id: `s-${platform}-${capturedAt}`, clientId: "c1", platform, count, capturedAt } as never;
}

describe("which posts are in the answer", () => {
  it("counts a post by when it was PUBLISHED, not when its numbers were fetched", () => {
    // A row fetched yesterday about a post from March is not last month's work,
    // and a renewal conversation built on it is about the wrong month.
    const old = asset("old", NOW - 90 * DAY);
    const recent = asset("new", NOW - 3 * DAY);
    const result = monthlyPerformance({
      assets: [old, recent],
      rows: [row("old", 90, { capturedAt: NOW }), row("new", 40)],
      snapshots: [],
      now: NOW,
    });
    expect(result.posts.map((p) => p.assetId)).toEqual(["new"]);
  });

  it("ignores a post that never published", () => {
    const result = monthlyPerformance({ assets: [asset("draft", null)], rows: [row("draft", 80)], snapshots: [], now: NOW });
    expect(result.posts).toEqual([]);
    expect(result.refusal).toMatch(/Nothing was published/);
  });

  it("never shows a client a mock number", () => {
    const result = monthlyPerformance({
      assets: [asset("a", NOW - DAY)],
      rows: [row("a", 95, { source: "mock" })],
      snapshots: [],
      now: NOW,
    });
    expect(result.posts).toEqual([]);
    // And the sentence is the one that asks somebody to act, not the one that
    // says nothing was published: the post WAS published.
    expect(result.refusal).toMatch(/numbers have not come back yet/);
  });

  it("drops an older metric generation rather than averaging two meanings", () => {
    const result = monthlyPerformance({
      assets: [asset("a", NOW - DAY), asset("b", NOW - 2 * DAY)],
      rows: [row("a", 50, { metricsVersion: 2 }), row("b", 99, { metricsVersion: 1 })],
      snapshots: [],
      now: NOW,
    });
    expect(result.posts.map((p) => p.assetId)).toEqual(["a"]);
  });

  it("keeps the window at the documented length", () => {
    const justInside = asset("in", NOW - (PERFORMANCE_WINDOW_DAYS - 1) * DAY);
    const justOutside = asset("out", NOW - (PERFORMANCE_WINDOW_DAYS + 1) * DAY);
    const result = monthlyPerformance({
      assets: [justInside, justOutside],
      rows: [row("in", 10), row("out", 99)],
      snapshots: [],
      now: NOW,
    });
    expect(result.posts.map((p) => p.assetId)).toEqual(["in"]);
  });
});

describe("what it says about them", () => {
  it("names the best post and what normal looks like", () => {
    const result = monthlyPerformance({
      assets: [asset("a", NOW - DAY, "The seal redesign"), asset("b", NOW - 2 * DAY), asset("c", NOW - 3 * DAY)],
      rows: [row("a", 80), row("b", 40), row("c", 20)],
      snapshots: [],
      now: NOW,
    });
    expect(result.best?.title).toBe("The seal redesign");
    expect(result.median).toBe(40);
    expect(result.posts.map((p) => p.score)).toEqual([80, 40, 20]);
  });
});

describe("follower movement", () => {
  it("measures from the first reading INSIDE the window", () => {
    // A client who connected three weeks ago has no earlier reading, and
    // inventing a baseline from a later count draws a rise nobody measured.
    const result = monthlyPerformance({
      assets: [asset("a", NOW - DAY)],
      rows: [row("a", 50)],
      snapshots: [snapshot("linkedin", 1000, NOW - 40 * DAY), snapshot("linkedin", 1200, NOW - 20 * DAY), snapshot("linkedin", 1260, NOW - DAY)],
      now: NOW,
    });
    expect(result.followers).toEqual([{ platform: "linkedin", from: 1200, to: 1260, change: 60 }]);
  });

  it("says nothing about a platform with a single reading", () => {
    const result = monthlyPerformance({
      assets: [asset("a", NOW - DAY)],
      rows: [row("a", 50)],
      snapshots: [snapshot("instagram", 500, NOW - 2 * DAY)],
      now: NOW,
    });
    expect(result.followers).toEqual([]);
  });

  it("reports a fall as readily as a rise", () => {
    const result = monthlyPerformance({
      assets: [asset("a", NOW - DAY)],
      rows: [row("a", 50)],
      snapshots: [snapshot("linkedin", 900, NOW - 10 * DAY), snapshot("linkedin", 880, NOW - DAY)],
      now: NOW,
    });
    expect(result.followers[0]).toMatchObject({ change: -20 });
  });
});
