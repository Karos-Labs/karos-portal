/**
 * Campaign capsule grouping — pure, client-safe.
 *
 * Turns a flat list of calendar assets into "capsules": assets sharing a
 * campaignId, ordered by their scheduled slot, so the content calendar can show
 * a campaign's cross-channel journey at a glance instead of scattering its
 * pieces across the grid. No I/O — trivially unit-testable.
 */

import type { Asset } from "@/lib/types";

/** The scheduling anchor for ordering a piece on the calendar. */
export function assetScheduleTime(a: Asset): number | null {
  return a.scheduledAt ?? a.recommendedAt ?? a.publishedAt ?? null;
}

export interface CampaignCapsule {
  campaignId: string;
  title: string;
  /** Pieces ordered by their scheduled slot (nulls last, then by createdAt). */
  assets: Asset[];
  /** Earliest / latest scheduled slot across the pieces (null when none scheduled). */
  firstAt: number | null;
  lastAt: number | null;
  /** Distinct target platforms represented, in first-seen order. */
  platforms: string[];
}

function orderAssets(assets: Asset[]): Asset[] {
  return [...assets].sort((a, b) => {
    const ta = assetScheduleTime(a);
    const tb = assetScheduleTime(b);
    if (ta == null && tb == null) return a.createdAt - b.createdAt;
    if (ta == null) return 1; // unscheduled pieces sink to the end
    if (tb == null) return -1;
    return ta - tb;
  });
}

/**
 * Group assets into campaign capsules. Assets without a campaignId are returned
 * as `ungrouped` (rendered as normal). Capsules are ordered by their earliest
 * scheduled slot (unscheduled capsules last).
 */
export function groupIntoCampaignCapsules(assets: Asset[]): {
  capsules: CampaignCapsule[];
  ungrouped: Asset[];
} {
  const byCampaign = new Map<string, Asset[]>();
  const ungrouped: Asset[] = [];

  for (const a of assets) {
    if (a.campaignId) {
      const arr = byCampaign.get(a.campaignId) ?? [];
      arr.push(a);
      byCampaign.set(a.campaignId, arr);
    } else {
      ungrouped.push(a);
    }
  }

  const capsules: CampaignCapsule[] = [];
  for (const [campaignId, group] of byCampaign) {
    const ordered = orderAssets(group);
    const times = ordered.map(assetScheduleTime).filter((t): t is number => t != null);
    const platforms: string[] = [];
    for (const a of ordered) {
      if (a.scheduledPlatform && !platforms.includes(a.scheduledPlatform)) {
        platforms.push(a.scheduledPlatform);
      }
    }
    capsules.push({
      campaignId,
      title: ordered.find((a) => a.campaignTitle)?.campaignTitle ?? "Campaign",
      assets: ordered,
      firstAt: times.length ? Math.min(...times) : null,
      lastAt: times.length ? Math.max(...times) : null,
      platforms,
    });
  }

  capsules.sort((a, b) => {
    if (a.firstAt == null && b.firstAt == null) return 0;
    if (a.firstAt == null) return 1;
    if (b.firstAt == null) return -1;
    return a.firstAt - b.firstAt;
  });

  return { capsules, ungrouped };
}
