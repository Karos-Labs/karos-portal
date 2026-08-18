import type { Asset } from "@/lib/types";

/**
 * Content-gap detection: how much a client has scheduled per platform against
 * a forward horizon. Extracted from `buildSwarmContext` (agent-swarm.ts) —
 * that function's own gap loop was previously inlined and untested; this is
 * the same computation, now shared so the swarm's own reasoning and the
 * calendar's "is this sparse" check can never disagree about what a gap is.
 *
 * Pure and client-safe: no Firestore, no framework import.
 */

export interface PlatformGap {
  platform: string;
  /** Assets scheduled or approved, landing within the horizon. */
  scheduledCount: number;
}

/** How far ahead gap/sparse detection looks — the swarm's own 14-day window. */
export const CONTENT_GAP_HORIZON_DAYS = 14;

/**
 * One entry per requested platform (order preserved), counting only assets
 * that are `scheduled` or `approved` and land in `[now, now + horizonDays)`.
 */
export function computePlatformGaps(
  assets: readonly Pick<Asset, "scheduledAt" | "status" | "scheduledPlatform">[],
  platforms: readonly string[],
  now: number,
  horizonDays: number = CONTENT_GAP_HORIZON_DAYS,
): PlatformGap[] {
  const horizonMs = now + horizonDays * 24 * 60 * 60 * 1000;
  const scheduledByPlatform: Record<string, number> = {};
  for (const a of assets) {
    if (a.scheduledAt == null || a.scheduledAt < now || a.scheduledAt > horizonMs) continue;
    if (a.status !== "scheduled" && a.status !== "approved") continue;
    const key = a.scheduledPlatform ?? "unassigned";
    scheduledByPlatform[key] = (scheduledByPlatform[key] ?? 0) + 1;
  }
  return platforms.map((platform) => ({ platform, scheduledCount: scheduledByPlatform[platform] ?? 0 }));
}

/** True when there's at least one platform to speak of and at least one of them has nothing queued. */
export function isCalendarSparse(gaps: readonly PlatformGap[]): boolean {
  return gaps.length > 0 && gaps.some((g) => g.scheduledCount === 0);
}

/** Just the platform names with zero coverage, in input order. */
export function gapPlatformNames(gaps: readonly PlatformGap[]): string[] {
  return gaps.filter((g) => g.scheduledCount === 0).map((g) => g.platform);
}
