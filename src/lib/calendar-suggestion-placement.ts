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

/** Hard safety bound on how far out placement will ever search — not a target, just a loop guard. */
const MAX_SEARCH_DAYS = 120;

/**
 * First day with nothing booked at all, 10:00 local — the fallback for a
 * platform with no known engagement window, and for a density search that
 * exhausted its own candidates.
 *
 * Prefers a day inside the horizon, but a fully-booked horizon (a client
 * whose chain already schedules every weekday for weeks out — entirely
 * realistic for an active client) must NOT collapse every overflowing
 * suggestion onto the identical `horizonMs` instant: that just moves the
 * "all on one day" bug from `base`'s fixed slot to the horizon boundary
 * instead of fixing it. So once the horizon is exhausted this keeps walking
 * for the first genuinely open day beyond it — still distinct per
 * suggestion, since `booked` (the caller's `working` array) grows with each
 * prior assignment — bounded only by MAX_SEARCH_DAYS so a calendar booked
 * solid for the full search window can't loop forever.
 */
function firstOpenDay(booked: readonly number[], now: number, horizonMs: number): number {
  let pastHorizonFallback: number | null = null;
  for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset++) {
    const day = new Date(now + dayOffset * DAY_MS);
    day.setHours(10, 0, 0, 0);
    if (day.getTime() < now) continue;
    if (booked.some((b) => sameLocalDay(b, day.getTime()))) continue;
    if (day.getTime() <= horizonMs) return day.getTime();
    if (pastHorizonFallback === null) pastHorizonFallback = day.getTime();
  }
  return pastHorizonFallback ?? horizonMs;
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
    // recommendPublishTimeWithDensity falls back to its OWN plain, non-density
    // slot (always the same fixed instant) once its internal 90-candidate walk
    // is exhausted — which a busy client's calendar hits easily. Trusting that
    // fallback here would pile every remaining suggestion onto that one identical
    // day, worse with each one added (it only ever grows `working`). Treat a
    // day `working` already holds as untrustworthy and re-derive an actually
    // open day ourselves instead of believing the density search's word for it.
    const day = (t: number) => working.some((b) => sameLocalDay(b, t));
    const at = rec && rec.at <= horizonMs && !day(rec.at) ? rec.at : firstOpenDay(working, now, horizonMs);
    out.set(s.id, at);
    working.push(at);
  }
  return out;
}
