import { describe, expect, it } from "vitest";
import {
  ENGAGEMENT_WEIGHTS,
  VIDEO_REFERENCE_SECONDS,
  engagementIsMockOrStale,
  engagementScore,
  hashSeed,
  mulberry32,
  normalizePlatformMetrics,
  rankByEngagement,
} from "../analytics";
import type { RawPlatformMetrics } from "../analytics";
import type { MarketingMetrics } from "../types";

function metrics(patch: Partial<MarketingMetrics> = {}): MarketingMetrics {
  return { impressions: 1000, clicks: 0, engagementRate: 0, videoViewTime: 0, ...patch };
}

describe("engagementScore", () => {
  it("is 0 for a post with no engagement, clicks, or views", () => {
    expect(engagementScore(metrics())).toBe(0);
  });

  it("weights a perfect engagement rate at exactly its configured weight (×100)", () => {
    // engagementRate=1, no clicks, no video ⇒ score = 0.5 * 1 * 100 = 50
    expect(engagementScore(metrics({ engagementRate: 1 }))).toBe(ENGAGEMENT_WEIGHTS.engagementRate * 100);
  });

  it("credits click-through as clicks ÷ impressions", () => {
    // ctr = 500/1000 = 0.5 ⇒ 0.3 * 0.5 * 100 = 15
    expect(engagementScore(metrics({ clicks: 500 }))).toBe(15);
  });

  it("saturates the video term at the reference watch time and clamps beyond it", () => {
    const atRef = engagementScore(metrics({ videoViewTime: VIDEO_REFERENCE_SECONDS }));
    const wayOver = engagementScore(metrics({ videoViewTime: VIDEO_REFERENCE_SECONDS * 10 }));
    // 0.2 * 1 * 100 = 20, and clamped so more watch time can't exceed it.
    expect(atRef).toBe(ENGAGEMENT_WEIGHTS.videoRetention * 100);
    expect(wayOver).toBe(atRef);
  });

  it("combines all three signals onto a 0–100 scale", () => {
    // eng=1 (→50) + ctr=1 (→30) + video=full (→20) = 100
    const perfect = engagementScore(
      metrics({ clicks: 1000, engagementRate: 1, videoViewTime: VIDEO_REFERENCE_SECONDS }),
    );
    expect(perfect).toBe(100);
  });

  it("never divides by zero when impressions are 0", () => {
    expect(engagementScore(metrics({ impressions: 0, clicks: 50 }))).toBe(0);
  });

  it("guards against negative / non-finite inputs", () => {
    expect(engagementScore(metrics({ engagementRate: -1 }))).toBe(0);
    expect(engagementScore(metrics({ engagementRate: Number.NaN }))).toBe(0);
  });
});

describe("rankByEngagement", () => {
  const rec = (id: string, engagementScore: number) => ({ id, engagementScore });

  it("returns top descending and bottom worst-first", () => {
    const records = [rec("a", 10), rec("b", 90), rec("c", 50), rec("d", 30), rec("e", 70)];
    const { top, bottom } = rankByEngagement(records, 2);
    expect(top.map((r) => r.id)).toEqual(["b", "e"]);
    expect(bottom.map((r) => r.id)).toEqual(["a", "d"]);
  });

  it("never reports the same record as both a win and a loss with a small history", () => {
    const records = [rec("a", 10), rec("b", 20), rec("c", 30)];
    const { top, bottom } = rankByEngagement(records, 5);
    const overlap = top.filter((t) => bottom.some((b) => b.id === t.id));
    expect(overlap).toEqual([]);
  });

  it("handles fewer records than the requested count", () => {
    const { top, bottom } = rankByEngagement([rec("a", 5)], 5);
    expect(top.map((r) => r.id)).toEqual(["a"]);
    expect(bottom).toEqual([]);
  });
});

describe("normalizePlatformMetrics", () => {
  it("maps LinkedIn's native field names onto the unified shape", () => {
    const m = normalizePlatformMetrics("linkedin", {
      impressionCount: 1000,
      clickCount: 100,
      likeCount: 30,
      commentCount: 10,
      shareCount: 10,
    });
    expect(m.impressions).toBe(1000);
    expect(m.clicks).toBe(100);
    expect(m.engagementRate).toBeCloseTo(0.05); // (30+10+10)/1000
    expect(m.videoViewTime).toBe(0);
  });

  it("maps TikTok's video-first payload including watch time", () => {
    const m = normalizePlatformMetrics("tiktok", {
      video_views: 5000,
      profile_views: 200,
      likes: 400,
      comments: 50,
      shares: 50,
      total_time_watched: 12_000,
    });
    expect(m.impressions).toBe(5000);
    expect(m.clicks).toBe(200);
    expect(m.engagementRate).toBeCloseTo(0.1); // 500/5000
    expect(m.videoViewTime).toBe(12_000);
  });

  it("converts YouTube watch minutes to seconds", () => {
    const m = normalizePlatformMetrics("youtube", {
      views: 2000,
      clicks: 40,
      likes: 100,
      comments: 20,
      estimatedMinutesWatched: 500,
    });
    expect(m.videoViewTime).toBe(30_000); // 500 min × 60
  });

  it("clamps an impossible engagement rate to 1", () => {
    const m = normalizePlatformMetrics("twitter", {
      impression_count: 100,
      url_link_clicks: 0,
      like_count: 500,
      retweet_count: 0,
      reply_count: 0,
    });
    expect(m.engagementRate).toBe(1);
  });

  it("returns zeroes rather than NaN when impressions are absent", () => {
    const m = normalizePlatformMetrics("facebook", { reactions: 5 });
    expect(m.impressions).toBe(0);
    expect(m.engagementRate).toBe(0);
  });

  it("falls back to a generic mapping for an unknown platform", () => {
    const m = normalizePlatformMetrics("mastodon", {
      impressions: 800,
      clicks: 40,
      likes: 20,
      comments: 20,
    });
    expect(m.impressions).toBe(800);
    expect(m.clicks).toBe(40);
    expect(m.engagementRate).toBeCloseTo(0.05);
  });
});

/**
 * TEST FIXTURE ONLY — moved here from src/lib/analytics.ts (2026-08).
 *
 * It builds a realistic, platform-native raw payload per `seedKey`, which is
 * what lets the `normalizePlatformMetrics` cases below exercise each network's
 * real API field names end to end. In production it was the sync cron's
 * fallback, and the rows it produced were read downstream as measurements — so
 * it was deleted from `src/lib` entirely rather than left behind an unused
 * export. It is a fixture; it must not gain an importer outside this file.
 */
function mockRawMetrics(platform: string, seedKey: string): RawPlatformMetrics {
  const rnd = mulberry32(hashSeed(`${platform}:${seedKey}`));
  const between = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo));

  const impressions = between(500, 50_000);
  // Engagement runs ~1–8% of impressions; clicks a fraction of that.
  const engaged = Math.floor(impressions * (0.01 + rnd() * 0.07));
  const clicks = Math.floor(engaged * (0.1 + rnd() * 0.4));

  switch (platform) {
    case "linkedin":
      return {
        impressionCount: impressions,
        clickCount: clicks,
        likeCount: Math.floor(engaged * 0.7),
        commentCount: Math.floor(engaged * 0.15),
        shareCount: Math.floor(engaged * 0.15),
      };
    case "tiktok":
      return {
        video_views: impressions,
        profile_views: clicks,
        likes: Math.floor(engaged * 0.8),
        comments: Math.floor(engaged * 0.1),
        shares: Math.floor(engaged * 0.1),
        total_time_watched: between(1_000, 60_000),
      };
    case "instagram":
      return {
        impressions,
        website_clicks: Math.floor(clicks * 0.5),
        profile_visits: Math.ceil(clicks * 0.5),
        likes: Math.floor(engaged * 0.7),
        comments: Math.floor(engaged * 0.1),
        saves: Math.floor(engaged * 0.1),
        shares: Math.floor(engaged * 0.1),
      };
    case "facebook":
      return {
        post_impressions: impressions,
        post_clicks: clicks,
        reactions: Math.floor(engaged * 0.75),
        comments: Math.floor(engaged * 0.15),
        shares: Math.floor(engaged * 0.1),
      };
    case "twitter":
      return {
        impression_count: impressions,
        url_link_clicks: clicks,
        like_count: Math.floor(engaged * 0.7),
        retweet_count: Math.floor(engaged * 0.2),
        reply_count: Math.floor(engaged * 0.1),
      };
    case "youtube":
      return {
        views: impressions,
        clicks,
        likes: Math.floor(engaged * 0.85),
        comments: Math.floor(engaged * 0.15),
        estimatedMinutesWatched: between(200, 20_000),
      };
    default:
      return {
        impressions,
        clicks,
        likes: Math.floor(engaged * 0.8),
        comments: Math.floor(engaged * 0.2),
      };
  }
}

describe("mockRawMetrics", () => {
  it("is deterministic for a given platform + seed", () => {
    expect(mockRawMetrics("linkedin", "asset-1")).toEqual(mockRawMetrics("linkedin", "asset-1"));
  });

  it("varies by seed and by platform", () => {
    expect(mockRawMetrics("linkedin", "asset-1")).not.toEqual(mockRawMetrics("linkedin", "asset-2"));
    expect(mockRawMetrics("linkedin", "asset-1")).not.toEqual(mockRawMetrics("tiktok", "asset-1"));
  });

  it("emits each platform's native field names so normalization round-trips", () => {
    const raw = mockRawMetrics("tiktok", "seed");
    expect(raw).toHaveProperty("video_views");
    expect(raw).toHaveProperty("total_time_watched");
    const m = normalizePlatformMetrics("tiktok", raw);
    expect(m.impressions).toBeGreaterThan(0);
    expect(engagementScore(m)).toBeGreaterThanOrEqual(0);
    expect(engagementScore(m)).toBeLessThanOrEqual(100);
  });
});

/**
 * The AI Insights gate (QA F125 blocker + F145 verifier bounce). Everything here
 * protects one rule: a client is never shown a performance briefing unless some
 * row in it can honestly describe how they are doing RIGHT NOW.
 */
describe("engagementIsMockOrStale", () => {
  const row = (platform: string, source: "mock" | "live") => ({ platform, source });

  it("holds the gate when an expired channel's live rows sit beside all-mock healthy ones", () => {
    // The exact config the F145 bounce named: LinkedIn's token died (analytics
    // stopped writing on the 401, so its real rows are frozen in place) while
    // every healthy channel only has mock metrics. Before the fix, LinkedIn's
    // stale live rows flipped this false and released a full unbadged briefing
    // over invented figures.
    const records = [
      row("linkedin", "live"),
      row("linkedin", "live"),
      row("instagram", "mock"),
      row("youtube", "mock"),
    ];
    expect(engagementIsMockOrStale(records, ["linkedin"])).toBe(true);
  });

  it("releases the briefing as soon as one healthy channel has live rows", () => {
    const records = [row("linkedin", "live"), row("instagram", "mock"), row("youtube", "live")];
    expect(engagementIsMockOrStale(records, ["linkedin"])).toBe(false);
  });

  it("still holds on the all-mock case with no stale channels at all (F125)", () => {
    expect(engagementIsMockOrStale([row("instagram", "mock")], [])).toBe(true);
  });

  it("does not hold on live rows from healthy channels", () => {
    expect(engagementIsMockOrStale([row("instagram", "live")], [])).toBe(false);
  });

  it("is false on an empty set — no rows means the digest is empty, not dishonest", () => {
    // The route's own next branch (sampleSize === 0) owns that case: it falls
    // back to the content-pipeline summary rather than the connect empty state.
    expect(engagementIsMockOrStale([], ["linkedin"])).toBe(false);
    expect(engagementIsMockOrStale([], [])).toBe(false);
  });

  it("holds when every row belongs to stale channels, live or not", () => {
    const records = [row("linkedin", "live"), row("facebook", "mock")];
    expect(engagementIsMockOrStale(records, ["linkedin", "facebook"])).toBe(true);
  });
});
