import { keepCurrentMetricDefinitions } from "@/lib/analytics";
import type { Asset, ClientFollowerSnapshot, ClientMarketingAnalytics } from "@/lib/types";

/**
 * WHAT LAST MONTH'S POSTS DID, FOR THE PERSON WHOSE POSTS THEY WERE.
 *
 * §09: *"client-facing analytics — connecting published assets to follower and
 * engagement snapshots. 'What did last month's posts do' is the renewal
 * question."* It is the renewal question and the client could not answer it:
 * the Reporting tab is SEO/GEO visibility scores, the Performance charts are
 * in a block labelled staff-only, and the one measured thing a client sees is
 * a follower count with nothing attached to it.
 *
 * All of the input already exists. `clientMarketingAnalytics` has one row per
 * published asset with a normalised 0–100 engagement score;
 * `clientFollowerSnapshots` has a daily count per platform. Nothing joined
 * them and showed the client the result.
 *
 * ## The rules, and every one of them is about honesty to a client
 *
 * **Live rows only.** `source` is `"mock" | "live"`. A client shown a mock
 * number is being lied to in a way they cannot detect, which is worse than
 * being shown nothing.
 *
 * **One metric generation.** Meta redefined `impressions` → `views`
 * mid-series; `keepCurrentMetricDefinitions` drops the older generation rather
 * than averaging two meanings of one word into a trend line.
 *
 * **A published post, or it is not in the window.** The window is the post's
 * own `publishedAt`, never the metric row's `capturedAt` — a row fetched
 * yesterday about a post from March is not last month's work.
 *
 * **A refusal, not an empty state.** "Nothing measured yet" and "measured,
 * nothing to report" are different sentences and only one of them means
 * somebody should go and connect an integration.
 */

export interface PerformedPost {
  assetId: string;
  title: string;
  platform: string;
  publishedAt: number;
  /** 0–100, as the analytics row carries it. */
  score: number;
}

export interface FollowerMovement {
  platform: string;
  from: number;
  to: number;
  /** Signed change across the window. Zero is a real answer and is shown. */
  change: number;
}

export interface MonthlyPerformance {
  posts: PerformedPost[];
  /** The best post of the window, when there is one to name. */
  best?: PerformedPost;
  /** The median score across the window — what "normal" looks like for this account. */
  median?: number;
  followers: FollowerMovement[];
  /** Why there is nothing to show. Written for the client, never naming our machinery. */
  refusal?: string;
}

/** The window this answers about. A month, because that is the question people ask. */
export const PERFORMANCE_WINDOW_DAYS = 30;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function monthlyPerformance(input: {
  assets: readonly Asset[];
  rows: readonly ClientMarketingAnalytics[];
  snapshots: readonly ClientFollowerSnapshot[];
  now: number;
}): MonthlyPerformance {
  const since = input.now - PERFORMANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const publishedInWindow = new Map(
    input.assets
      .filter((asset) => asset.publishedAt != null && asset.publishedAt >= since && asset.publishedAt <= input.now)
      .map((asset) => [asset.id, asset]),
  );

  const live = keepCurrentMetricDefinitions(input.rows.filter((row) => row.source === "live" && publishedInWindow.has(row.assetId)));
  const posts: PerformedPost[] = live
    .map((row) => {
      const asset = publishedInWindow.get(row.assetId)!;
      return {
        assetId: asset.id,
        // The asset's own title, which is the client's own words.
        title: asset.title,
        platform: row.platform,
        publishedAt: asset.publishedAt as number,
        score: row.engagementScore,
      };
    })
    .sort((a, b) => b.score - a.score);

  const followers = followerMovement(input.snapshots, since, input.now);

  if (posts.length === 0) {
    return {
      posts: [],
      followers,
      refusal: publishedInWindow.size === 0
        ? "Nothing was published in the last 30 days, so there is nothing to measure yet."
        : "Your posts from the last 30 days are published, and their numbers have not come back yet. Connecting the channel's account is what starts them.",
    };
  }

  return {
    posts,
    best: posts[0]!,
    median: median(posts.map((p) => p.score)),
    followers,
  };
}

/**
 * Follower movement per platform across the window.
 *
 * The FIRST snapshot inside the window is the baseline rather than the newest
 * one before it: a client who connected a channel three weeks ago has no
 * earlier reading, and inventing one from a later count would draw a rise that
 * never happened.
 */
function followerMovement(snapshots: readonly ClientFollowerSnapshot[], since: number, now: number): FollowerMovement[] {
  const byPlatform = new Map<string, ClientFollowerSnapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.capturedAt < since || snapshot.capturedAt > now) continue;
    byPlatform.set(snapshot.platform, [...(byPlatform.get(snapshot.platform) ?? []), snapshot]);
  }

  const out: FollowerMovement[] = [];
  for (const [platform, rows] of byPlatform) {
    const ordered = [...rows].sort((a, b) => a.capturedAt - b.capturedAt);
    // One reading is a count, not a movement: a single point cannot say
    // whether the number went up.
    if (ordered.length < 2) continue;
    const from = ordered[0]!.count;
    const to = ordered[ordered.length - 1]!.count;
    out.push({ platform, from, to, change: to - from });
  }
  return out.sort((a, b) => b.change - a.change);
}
