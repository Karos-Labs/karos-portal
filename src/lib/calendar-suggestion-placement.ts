/**
 * Target-date inference for pending Task-Map suggestions (ClientTask, status
 * "pending", karos_managed/copilot). These have no date field at all — they
 * are proposals, not scheduled content — so a suggestion needs a computed,
 * never-stored, date to appear on a calendar day cell. Recomputed fresh on
 * every render (see calendar-body.tsx), never persisted on the task itself,
 * so it can never go stale against a calendar that changes underneath it.
 *
 * Reuses `recommendPublishTimeWithDensity` (lib/scheduling.ts) — the exact
 * "next date in the platform's ideal engagement window, skipping any day
 * already at capacity" algorithm already built for manual asset scheduling
 * (recommendAssetScheduleAction). Not reinvented here.
 */

import { recommendPublishTimeWithDensity, sameLocalDay } from "@/lib/scheduling";
import { CONTENT_GAP_HORIZON_DAYS } from "@/lib/calendar-gaps";
import type { AssetType, TaskPriority } from "@/lib/types";

interface PlaceableSuggestion {
  id: string;
  platform?: string;
  priority: TaskPriority;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

/**
 * `assetType` only matters to `recommendPublishTimeWithDensity` for the
 * `"email"` special case (a different heuristic entirely) — every other type
 * resolves its schedule from `platform` directly (scheduling.ts's
 * `scheduleFor`), so any non-email nominal type is safe here. Chosen instead
 * of inventing a "suggestion" AssetType, which would mean widening a type
 * this module has no business widening.
 */
function nominalAssetType(platform: string | undefined): AssetType {
  return platform === "instagram" ? "instagram_post" : "social_post";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** First day with nothing booked at all, 10:00 local — the fallback for a platform with no known engagement window. */
function firstOpenDay(booked: readonly number[], now: number, horizonMs: number): number {
  for (let dayOffset = 0; ; dayOffset++) {
    const day = new Date(now + dayOffset * DAY_MS);
    day.setHours(10, 0, 0, 0);
    if (day.getTime() < now) continue;
    if (day.getTime() > horizonMs) return horizonMs;
    if (!booked.some((b) => sameLocalDay(b, day.getTime()))) return day.getTime();
  }
}

/**
 * Assigns each suggestion a target date, highest priority first, feeding
 * each newly-assigned slot back into `booked` so two suggestions in the same
 * pass never collide on the same day — a stable, deterministic placement
 * over the client's CURRENT calendar density.
 */
export function inferSuggestionDates(
  suggestions: readonly PlaceableSuggestion[],
  booked: readonly number[],
  now: number,
  horizonDays: number = CONTENT_GAP_HORIZON_DAYS,
): Map<string, number> {
  const horizonMs = now + horizonDays * DAY_MS;
  const working = [...booked];
  const out = new Map<string, number>();
  const ordered = [...suggestions].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

  for (const s of ordered) {
    const rec = recommendPublishTimeWithDensity({
      assetType: nominalAssetType(s.platform),
      platform: s.platform,
      scheduled: working,
      from: now,
    });
    const at = rec && rec.at <= horizonMs ? rec.at : firstOpenDay(working, now, horizonMs);
    out.set(s.id, at);
    working.push(at);
  }
  return out;
}
