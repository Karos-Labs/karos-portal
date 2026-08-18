/**
 * Pure, client-safe helpers behind the Home KPIs widget's audience cell
 * (portal revamp, D6).
 *
 * THE MOCK IS GONE (2026-08, product owner: "all information has to be
 * accurate").
 *
 * This module used to export `mockFollowerHistory`, a seeded PRNG that invented
 * a 14-day series per client+platform — `base = 400 + rnd() * 9600`, described
 * in its own comment as "a plausible small-business baseline", with an
 * always-positive ~0.1–0.5%/day drift. `resolveFollowerHistory` fell back to it
 * whenever no stored snapshot existed, which is ALWAYS: the write side
 * (`recordClientFollowerSnapshot`, data.ts) has never had a caller, so
 * `clientFollowerSnapshots` is empty for every client and the mock path was the
 * only path. The result was an invented audience size and an invented growth
 * trend rendered as the first number on the dashboard, with no `source` marker
 * to distinguish it — unlike engagement metrics, which carry
 * `source: "mock" | "live"` on every row precisely so consumers can refuse the
 * fabricated ones.
 *
 * A number nobody measured is not a number this product prints. The fallback is
 * removed rather than badged: a "Demo data" chip does not make an invented
 * audience size safe to put beside real ones, and the surface that reads these
 * helpers now simply renders nothing until a real snapshot exists.
 *
 * What is left is the REAL half, unchanged and ready: the moment an ingestion
 * cron writes to `clientFollowerSnapshots` (X/Twitter is the cheap one —
 * `fetchTwitterFollowerGrowth` in analytics-providers.ts already returns
 * `followers_count` and needs no extra scope), the audience cell lights up on
 * its own with no further change here.
 */
import type { ClientFollowerSnapshot } from "@/lib/types";

export interface FollowerPoint {
  capturedAt: number;
  count: number;
}

/** Stored snapshots for one platform, oldest first. */
export function historyForPlatform(
  snapshots: ClientFollowerSnapshot[],
  platform: string,
): FollowerPoint[] {
  return snapshots
    .filter((s) => s.platform === platform)
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .map((s) => ({ capturedAt: s.capturedAt, count: s.count }));
}

/**
 * Real stored history, or an EMPTY series when there is none.
 *
 * The empty array is the honest answer and callers must treat it as one — see
 * the module note above for why there is no longer a second branch.
 */
export function resolveFollowerHistory(
  snapshots: ClientFollowerSnapshot[],
  platform: string,
): FollowerPoint[] {
  return historyForPlatform(snapshots, platform);
}

/** Today's total across every platform's history (its most recent point). */
export function totalFollowers(historiesByPlatform: Record<string, FollowerPoint[]>): number {
  let total = 0;
  for (const history of Object.values(historiesByPlatform)) {
    const latest = history[history.length - 1];
    if (latest) total += latest.count;
  }
  return total;
}

/** Every platform's history summed per day, for one combined sparkline. */
export function combinedFollowerSeries(
  historiesByPlatform: Record<string, FollowerPoint[]>,
): FollowerPoint[] {
  const byDay = new Map<number, number>();
  for (const history of Object.values(historiesByPlatform)) {
    for (const point of history) {
      byDay.set(point.capturedAt, (byDay.get(point.capturedAt) ?? 0) + point.count);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([capturedAt, count]) => ({ capturedAt, count }));
}

/** Percent change from the first point to the last, or null when there isn't enough history to compare. */
export function followerGrowthPct(series: FollowerPoint[]): number | null {
  if (series.length < 2) return null;
  const first = series[0].count;
  const last = series[series.length - 1].count;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}
