/**
 * Marketing analytics — pure, client-safe scoring and normalization.
 *
 * This module holds NO Firestore or network access so it can be unit-tested in
 * isolation and imported from both server (the sync cron, the data layer, the
 * Task Map prompt builder) and client code. The transactional persistence lives
 * in `src/lib/data.ts`; the platform fetch orchestration lives in
 * `src/lib/integrations/analytics-providers.ts`.
 *
 * The heart of the Self-Improving Marketing Loop is one comparable number per
 * asset — `engagementScore` — computed the same way for every platform so the
 * Task Map engine can rank a LinkedIn article against a TikTok clip fairly.
 */

import type { MarketingMetrics } from "@/lib/types";

/* ── Engagement scoring ──────────────────────────────────────────────── */

/**
 * Relative weights of the three normalized performance signals. They sum to 1
 * so `engagementScore` lands cleanly on a 0–100 scale.
 * - engagementRate: the primary quality signal (how much the audience reacted)
 * - clickThrough:   intent / conversion signal (clicks ÷ impressions)
 * - videoRetention: attention signal, normalized watch time (video formats only)
 */
export const ENGAGEMENT_WEIGHTS = {
  engagementRate: 0.5,
  clickThrough: 0.3,
  videoRetention: 0.2,
} as const;

/**
 * Reference watch time (seconds) that maps to a "full marks" retention signal.
 * A post accumulating ≥ this much total watch time saturates the video term.
 * Tunable as real data arrives; kept here as the single source of truth.
 */
export const VIDEO_REFERENCE_SECONDS = 30_000;

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? 1 : n;
}

/**
 * Collapse a set of normalized metrics into a single 0–100 engagement score
 * (one decimal). Platform-agnostic by construction: it only reads the unified
 * `MarketingMetrics` shape, so scores are directly comparable across networks.
 */
export function engagementScore(m: MarketingMetrics): number {
  const ctr = m.impressions > 0 ? m.clicks / m.impressions : 0;
  const videoNorm = clamp01(m.videoViewTime / VIDEO_REFERENCE_SECONDS);
  const raw =
    ENGAGEMENT_WEIGHTS.engagementRate * clamp01(m.engagementRate) +
    ENGAGEMENT_WEIGHTS.clickThrough * clamp01(ctr) +
    ENGAGEMENT_WEIGHTS.videoRetention * videoNorm;
  return Math.round(raw * 1000) / 10;
}

/* ── Ranking ─────────────────────────────────────────────────────────── */

/** Anything carrying an `engagementScore`; keeps `rankByEngagement` reusable. */
type Scored = { engagementScore: number };

/**
 * Split a set of scored records into the highest and lowest performers.
 * Returns disjoint slices: with ≤ 2·count records the two lists never overlap,
 * so a small history doesn't report the same asset as both a win and a loss.
 */
export function rankByEngagement<T extends Scored>(
  records: T[],
  count = 5,
): { top: T[]; bottom: T[] } {
  const sorted = [...records].sort((a, b) => b.engagementScore - a.engagementScore);
  const top = sorted.slice(0, count);
  // Bottom is drawn from records not already claimed by `top`.
  const remaining = sorted.slice(top.length);
  const bottom = remaining.slice(-count).reverse(); // worst first
  return { top, bottom };
}

/* ── Briefing data-provenance gate ───────────────────────────────────── */

/** The provenance facts the gate reads — keeps it usable from any caller. */
type Sourced = { platform: string; source: "mock" | "live" };

/**
 * True when NOTHING in this set can honestly describe how the client is doing
 * right now — every row is either invented (mock) or belongs to a channel whose
 * login has expired.
 *
 * The mock half is QA F125's blocker: a client must never be shown paragraphs of
 * numbered budget advice derived from invented figures. The stale half is F145's
 * bounce: once expired channels were readmitted to the digest (so the briefing
 * could say "reconnect" rather than silently dropping a channel), their leftover
 * LIVE rows could vouch for freshness the client no longer has — analytics/sync
 * writes no new rows after a 401/403, so those rows sit there indefinitely and a
 * single one of them would have flipped the gate false and released a full,
 * unbadged briefing over otherwise-mock data. A dead channel's history is real
 * but frozen, so it cannot carry the "this is current" claim either.
 */
export function engagementIsMockOrStale(records: Sourced[], stalePlatforms: string[]): boolean {
  const staleSet = new Set(stalePlatforms);
  return records.length > 0 && records.every((r) => r.source === "mock" || staleSet.has(r.platform));
}

/* ── Platform metric normalization ───────────────────────────────────── */

/** Raw, platform-native metrics payload before normalization. */
export type RawPlatformMetrics = Record<string, number>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Compute engagementRate defensively: engagements ÷ impressions, clamped to
 * [0,1]. When impressions are missing we can't form a rate, so return 0 rather
 * than dividing by zero.
 */
function rate(engagements: number, impressions: number): number {
  if (impressions <= 0) return 0;
  return clamp01(engagements / impressions);
}

/**
 * Map a platform's native metrics payload onto the unified `MarketingMetrics`
 * shape. Each network names things differently; this switch is the ONLY place
 * that knowledge lives. Unknown platforms fall back to a best-effort mapping
 * over common field names so a newly-added channel still yields usable numbers.
 */
export function normalizePlatformMetrics(
  platform: string,
  raw: RawPlatformMetrics,
): MarketingMetrics {
  switch (platform) {
    case "linkedin": {
      const impressions = num(raw.impressionCount);
      const clicks = num(raw.clickCount);
      const engagements = num(raw.likeCount) + num(raw.commentCount) + num(raw.shareCount);
      return { impressions, clicks, engagementRate: rate(engagements, impressions), videoViewTime: 0 };
    }
    case "tiktok": {
      const impressions = num(raw.video_views);
      const clicks = num(raw.profile_views);
      const engagements = num(raw.likes) + num(raw.comments) + num(raw.shares);
      return {
        impressions,
        clicks,
        engagementRate: rate(engagements, impressions),
        videoViewTime: num(raw.total_time_watched),
      };
    }
    case "instagram": {
      const impressions = num(raw.impressions);
      // IG has no link clicks on organic posts; profile/website taps stand in.
      const clicks = num(raw.website_clicks) + num(raw.profile_visits);
      const engagements = num(raw.likes) + num(raw.comments) + num(raw.saves) + num(raw.shares);
      return { impressions, clicks, engagementRate: rate(engagements, impressions), videoViewTime: 0 };
    }
    case "facebook": {
      const impressions = num(raw.post_impressions);
      const clicks = num(raw.post_clicks);
      const engagements = num(raw.reactions) + num(raw.comments) + num(raw.shares);
      return { impressions, clicks, engagementRate: rate(engagements, impressions), videoViewTime: 0 };
    }
    case "twitter": {
      const impressions = num(raw.impression_count);
      const clicks = num(raw.url_link_clicks);
      const engagements = num(raw.like_count) + num(raw.retweet_count) + num(raw.reply_count);
      return { impressions, clicks, engagementRate: rate(engagements, impressions), videoViewTime: 0 };
    }
    case "youtube": {
      const impressions = num(raw.views);
      const clicks = num(raw.clicks);
      const engagements = num(raw.likes) + num(raw.comments);
      // YouTube reports watch time in minutes; the unified field is seconds.
      const videoViewTime = num(raw.estimatedMinutesWatched) * 60;
      return { impressions, clicks, engagementRate: rate(engagements, impressions), videoViewTime };
    }
    default: {
      // Best-effort generic mapping for platforms not yet special-cased.
      const impressions = num(raw.impressions) || num(raw.views) || num(raw.impressionCount);
      const clicks = num(raw.clicks) || num(raw.linkClicks);
      const engagements =
        num(raw.likes) + num(raw.comments) + num(raw.shares) + num(raw.reactions);
      const videoViewTime = num(raw.videoViewTime) || num(raw.total_time_watched);
      return { impressions, clicks, engagementRate: rate(engagements, impressions), videoViewTime };
    }
  }
}

/* ── Deterministic mock generation ───────────────────────────────────── */

/**
 * Small string hash (FNV-1a) → 32-bit seed. Deterministic so the same asset id
 * always mocks to the same metrics — stable across cron runs and unit tests,
 * and it never touches `Math.random`.
 */
export function hashSeed(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Mulberry32 PRNG — tiny, deterministic, seeded. Returns a [0,1) generator.
 * Exported alongside `hashSeed` so other mock generators (follower-tracking.ts)
 * share the one no-Math.random primitive rather than each rolling their own.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `mockRawMetrics` LIVED HERE AND WAS DELETED (2026-08).
 *
 * It seeded a PRNG from `platform + assetId` and invented a full native metrics
 * payload — 500–50,000 impressions, engagement at 1–8% of those — and the sync
 * cron persisted the result into `clientMarketingAnalytics` whenever a live API
 * could not answer, which for a client with no connected channel was every
 * asset. Those rows carried `source: "mock"`, but three of the four consumers
 * never read the flag: content generation quoted them as proven winners, the
 * strategy swarm narrated them to the client as measurement, and a fabricated
 * score was enough to open a paid campaign.
 *
 * The fixture itself now lives in `__tests__/analytics.test.ts`, which is the
 * only thing that ever legitimately needed it — it exercises
 * `normalizePlatformMetrics` against each network's real field names. Keeping it
 * out of `src/lib` is deliberate: there is no longer an import path a future
 * caller can reach for, which is the only durable way to stop this coming back.
 *
 * `hashSeed` and `mulberry32` below stay exported — they are general-purpose and
 * the test fixture builds on them — but nothing in production may use them to
 * manufacture a value a person will read as a measurement.
 */
