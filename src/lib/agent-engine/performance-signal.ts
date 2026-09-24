import { keepCurrentMetricDefinitions } from "@/lib/analytics";

/**
 * What this account's own published posts say worked — in the shape the engine
 * already reads.
 *
 * ## The gap this closes
 *
 * `preferredByPerformance` in the engine picks the format, archetype or hook a
 * client's numbers favour. Its own comment says where the numbers come from:
 *
 *   > The run does NOT compute this from raw metrics — it never sees them.
 *   > Performance ingestion (N6) writes outliers into `what-works.json` with a
 *   > `lift`, and this reads them.
 *
 * **N6 does not exist.** The consumer is written, covered by tests and wired
 * into Instagram; `context/learning/<platform>/what-works` has never been
 * written by anything, so every run reads an absent document and falls back to
 * its own default. The loop the product is named for closes on a reviewer's
 * click and nothing else.
 *
 * The portal already has the input: `clientMarketingAnalytics`, one row per
 * (client, asset, platform), with a normalised 0–100 `engagementScore`. This
 * is the projection between them, and it is deliberately pure — no Firestore,
 * no fetch — so the arithmetic that will steer what a client publishes can be
 * argued with in a test.
 *
 * ## Three rules it will not bend
 *
 * **Live rows only.** `source` is `"mock" | "live"`, and mock rows exist in
 * quantity. Teaching an agent that a format works because a placeholder said
 * so is worse than teaching it nothing — it would be confident and invented,
 * and it would look exactly like evidence.
 *
 * **One metric generation.** Meta has already redefined `impressions` →
 * `views` mid-series. `keepCurrentMetricDefinitions` drops the older
 * generation rather than averaging two different meanings of one number.
 *
 * **A floor on sample size, per trait and per account.** Lift computed over
 * two posts is noise with a decimal point. Below the floor the trait is left
 * out entirely rather than emitted with a caveat nobody reads.
 */

/** One published post's measured outcome, as this projection needs it. */
export interface MeasuredPost {
  assetId: string;
  platform: string;
  engagementScore: number;
  source: "mock" | "live";
  metricsVersion?: number;
  /**
   * What this post WAS — the archetype, template or format id the engine
   * matches on (`"carousel-edu"`, `"thread"`, `"how-to"`). Absent for a post
   * whose producer recorded none, which is not the same as a post that failed:
   * it simply cannot vote.
   */
  trait?: string | null;
}

/** An entry of `what-works.json`'s `outliers`, which is the engine's own shape. */
export interface PerformanceOutlier {
  postRef: string;
  trait: string;
  /** Relative to this account's own median. 1.0 is "no different". */
  lift: number;
}

export interface WhatWorksProjection {
  outliers: PerformanceOutlier[];
  regeneratedAt: string;
  /** Why the projection is empty, when it is. Never shown to a client — this is for whoever asks why an agent ignored the numbers. */
  refusal?: string;
}

/** Posts per trait before it may vote. Two posts is noise with a decimal point. */
export const MIN_POSTS_PER_TRAIT = 3;
/** Posts in the account before ANY trait may vote, so one busy week cannot define a brand. */
export const MIN_POSTS_PER_ACCOUNT = 8;
/** Lift further from 1.0 than this to be worth carrying. Below it, the engine's floor would drop it anyway. */
export const MIN_INTERESTING_LIFT = 0.15;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * MEDIAN AND NOT MEAN, everywhere.
 *
 * One post that went unusually well is the single most common shape in this
 * data, and a mean lets it define the account it is an outlier of — so the
 * baseline rises, every other trait reads as underperforming, and the agent
 * learns to copy the one post nobody can explain.
 */
export function projectWhatWorks(
  posts: readonly MeasuredPost[],
  platform: string,
  now: Date = new Date(),
): WhatWorksProjection {
  const regeneratedAt = now.toISOString();
  const empty = (refusal: string): WhatWorksProjection => ({ outliers: [], regeneratedAt, refusal });

  const live = keepCurrentMetricDefinitions(
    posts.filter((p) => p.platform === platform && p.source === "live"),
  );
  if (live.length < MIN_POSTS_PER_ACCOUNT) {
    return empty(
      `${live.length} live post(s) measured on ${platform}; ${MIN_POSTS_PER_ACCOUNT} needed before this account's numbers mean anything.`,
    );
  }

  const accountMedian = median(live.map((p) => p.engagementScore));
  if (accountMedian <= 0) {
    // Every lift would divide by zero or explode. An account with no measured
    // engagement has not earned an opinion about its own formats.
    return empty(`no measured engagement on ${platform} yet — every post scores zero.`);
  }

  const byTrait = new Map<string, MeasuredPost[]>();
  for (const post of live) {
    const trait = post.trait?.trim();
    if (!trait) continue;
    byTrait.set(trait, [...(byTrait.get(trait) ?? []), post]);
  }

  const outliers: PerformanceOutlier[] = [];
  for (const [trait, group] of byTrait) {
    if (group.length < MIN_POSTS_PER_TRAIT) continue;
    const lift = median(group.map((p) => p.engagementScore)) / accountMedian;
    if (Math.abs(lift - 1) < MIN_INTERESTING_LIFT) continue;
    // The post named is the trait's own best, so a reviewer chasing "why does
    // it think this works" lands on a real post rather than on a bucket.
    const best = [...group].sort((a, b) => b.engagementScore - a.engagementScore)[0]!;
    outliers.push({ postRef: best.assetId, trait, lift: Math.round(lift * 100) / 100 });
  }

  if (outliers.length === 0) {
    return empty(
      `no trait on ${platform} has ${MIN_POSTS_PER_TRAIT} live posts and a median clear of the account's by ${MIN_INTERESTING_LIFT}.`,
    );
  }

  // Strongest first, which is the order a reader scans and the order the
  // engine's own matcher benefits from.
  outliers.sort((a, b) => b.lift - a.lift);
  return { outliers, regeneratedAt };
}
