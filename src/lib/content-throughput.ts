import { clientDeliveryStamp } from "@/lib/asset-visibility";
import type { Asset } from "@/lib/types";

/**
 * HOW MUCH OF THIS CLIENT'S CONTENT ACTUALLY WENT LIVE, and whether that is
 * going up (2026-09).
 *
 * WHY THIS EXISTS. Home's "Your numbers" card carried a per-channel connection
 * list, and one card lower the analytics stack carried "Connected channels":
 * the same channels, twice, with the second copy the detailed one (account
 * names, reconnect links). The product owner asked for the duplicate to be
 * replaced with a real high-level metric rather than deleted, and of the four
 * suggested (content performance, website traffic, conversion progress, AI
 * visibility trends) this is the only one the product has data for today.
 * Traffic and conversion have no ingestion at all; AI visibility already has
 * its own meter on the same card and its own widget below it.
 *
 * WHAT IT COUNTS. Deliverables that REACHED AN AUDIENCE — `published` and
 * `delivered`. Not drafts, not approvals, not scheduled slots: those are
 * inventory, and the retired tile row this card replaced was made of exactly
 * that kind of number.
 *
 * WHICH INSTANT. `clientDeliveryStamp`, the same one the archive sorts and ages
 * by, never `createdAt`. That is the A3/A4 churn rule and it is load-bearing
 * here specifically: a week of daily posts is generated in one second, so
 * bucketing by the generation instant would draw a bar chart of our batch
 * schedule on the client's dashboard. Bucketed by delivery, the chart is the
 * client's own posting cadence, which is what the card claims to show.
 *
 * PURE. No `Date.now()` — `now` is a required argument, so a server component
 * reads the clock once per render and the tests do not need one.
 */

/** Days in the window this card reports, and in the one it compares against. */
export const THROUGHPUT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A deliverable is counted here only once it has reached the audience. */
const LIVE_STATUSES: ReadonlySet<Asset["status"]> = new Set(["published", "delivered"]);

export interface ContentThroughput {
  /** Live deliverables stamped inside the last THROUGHPUT_WINDOW_DAYS. */
  count: number;
  /** The same count for the window before it — the delta's denominator. */
  previousCount: number;
  /**
   * Percentage change against the previous window, or null when there is no
   * honest one to state.
   *
   * NULL WHEN THE PREVIOUS WINDOW IS EMPTY, deliberately. "0 → 4" is not
   * "+400%", it is a first month, and dividing by zero to get a big green
   * number is the kind of flattery this dashboard's own history keeps deleting
   * (see the seeded-follower reversal in home-kpis.tsx). No baseline, no delta.
   */
  deltaPct: number | null;
  /**
   * One count per day of the reported window, oldest first, for the mini chart.
   * Always THROUGHPUT_WINDOW_DAYS long, zeros included: a chart that drops its
   * empty days redraws its own x-axis every render, and a quiet fortnight then
   * reads as a busy one.
   *
   * DAILY, AND OVER EXACTLY THE WINDOW THE HEADLINE COUNTS (portal feedback
   * round 5, 2026-09). It was four weekly buckets, which spanned 28 days beside
   * a "last 30 days" number: the chart and the figure above it were measuring
   * different stretches of time, so `daily` sums to `count` by construction and
   * the invariant is pinned by a test. Four bars also could not show a cadence,
   * which is the only thing this chart is for; thirty can.
   *
   * A "day" is a rolling 24 hours back from `now`, not a calendar day in the
   * client's timezone. The window itself is already rolling (`count` is "the
   * last 30 days", not "this month"), so calendar buckets would have the chart
   * and the count disagreeing again, and would need a timezone this pure
   * function does not take.
   */
  daily: number[];
}

/**
 * Live deliverables per window, plus the weekly bars.
 *
 * `assets` is whatever projection the caller already holds — this function does
 * no visibility filtering of its own, on purpose: the page hands it the same
 * redacted set every other client widget reads, and a second, quieter filter
 * here is how two surfaces come to disagree about what a client has.
 */
export function contentThroughput(assets: readonly Asset[], now: number): ContentThroughput {
  const windowMs = THROUGHPUT_WINDOW_DAYS * DAY_MS;

  let count = 0;
  let previousCount = 0;
  const daily = new Array<number>(THROUGHPUT_WINDOW_DAYS).fill(0);

  for (const asset of assets) {
    if (!LIVE_STATUSES.has(asset.status)) continue;
    const at = clientDeliveryStamp(asset);
    // A stamp in the future is a scheduling artifact, not throughput.
    if (at > now) continue;
    const age = now - at;
    if (age < windowMs) {
      count += 1;
      // Same branch as the count, on purpose: every row the headline counts
      // lands in a bar, and no row outside the window can. Age is in [0,
      // windowMs) here, so the index is in range without a clamp.
      daily[THROUGHPUT_WINDOW_DAYS - 1 - Math.floor(age / DAY_MS)] += 1;
    } else if (age < 2 * windowMs) previousCount += 1;
  }

  return {
    count,
    previousCount,
    deltaPct:
      previousCount > 0 ? Math.round(((count - previousCount) / previousCount) * 100) : null,
    daily,
  };
}
