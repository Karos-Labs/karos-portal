/**
 * Optimal publish-time recommendation engine.
 *
 * Agents stamp every schedulable output with a recommended publication slot at
 * generation time (Asset.recommendedAt / recommendedReason). The recommendation
 * is deterministic and heuristic — industry-standard engagement windows per
 * platform — rather than an extra model call: it's free, instant, testable, and
 * good enough as a default the user can always override in the schedule form.
 *
 * All times are computed in the server's local timezone (matches how the
 * datetime-local schedule form interprets times for staff).
 */

import type { AssetType } from "@/lib/types";

/** A recurring weekly engagement window: days 0=Sun..6=Sat at hour:minute. */
interface OptimalWindow {
  days: number[];
  hour: number;
  minute: number;
}

interface PlatformSchedule {
  windows: OptimalWindow[];
  reason: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

/** Engagement peaks per platform (aggregate of Sprout Social / Hootsuite / Buffer studies). */
const PLATFORM_SCHEDULES: Record<string, PlatformSchedule> = {
  instagram: {
    windows: [
      { days: WEEKDAYS, hour: 11, minute: 0 },
      { days: WEEKDAYS, hour: 14, minute: 0 },
    ],
    reason: "Instagram engagement peaks on weekdays around late morning and early afternoon",
  },
  linkedin: {
    windows: [
      { days: [2, 3, 4], hour: 9, minute: 0 },
      { days: [2, 3, 4], hour: 12, minute: 0 },
    ],
    reason: "LinkedIn reach is highest Tue–Thu at the start of the workday and lunchtime",
  },
  twitter: {
    windows: [
      { days: WEEKDAYS, hour: 9, minute: 0 },
      { days: WEEKDAYS, hour: 13, minute: 0 },
    ],
    reason: "X (Twitter) activity spikes weekday mornings and around lunch",
  },
  facebook: {
    windows: [
      { days: [3, 4, 5], hour: 13, minute: 0 },
      { days: [3, 4, 5], hour: 15, minute: 0 },
    ],
    reason: "Facebook engagement is strongest Wed–Fri in the early afternoon",
  },
  youtube: {
    windows: [
      { days: [4, 5, 6], hour: 17, minute: 0 },
    ],
    reason: "YouTube views ramp up Thu–Sat in the late afternoon ahead of evening watch time",
  },
};

/** Fallback platform used to pick a window when no platform is known yet. */
const DEFAULT_PLATFORM_FOR_TYPE: Partial<Record<AssetType, string>> = {
  instagram_post: "instagram",
  social_post: "linkedin",
  article: "linkedin",
};

/** Email has its own send-time heuristic (not a social platform). */
const EMAIL_SCHEDULE: PlatformSchedule = {
  windows: [{ days: [2, 3], hour: 10, minute: 0 }],
  reason: "Email open rates peak Tue–Wed mid-morning",
};

/** Don't recommend a slot sooner than this — leaves room for review/approval. */
const MIN_LEAD_MS = 3 * 60 * 60 * 1000;

function scheduleFor(assetType: AssetType, platform?: string): PlatformSchedule | null {
  if (assetType === "email") return EMAIL_SCHEDULE;
  const platformId = platform ?? DEFAULT_PLATFORM_FOR_TYPE[assetType];
  return platformId ? (PLATFORM_SCHEDULES[platformId] ?? null) : null;
}

/**
 * Next optimal publish slot for an asset.
 *
 * @param index  0-based position within a batch (e.g. 5 Instagram posts from one
 *               run) — each subsequent asset takes the next optimal window so a
 *               batch spreads across days instead of stacking on one timestamp.
 * @param from   Reference "now" (epoch millis). Injectable for tests.
 * @returns      null when the type has no scheduling dimension (e.g. "note").
 */
export function recommendPublishTime(opts: {
  assetType: AssetType;
  platform?: string;
  index?: number;
  from?: number;
}): { at: number; reason: string } | null {
  const schedule = scheduleFor(opts.assetType, opts.platform);
  if (!schedule || schedule.windows.length === 0) return null;

  const from = opts.from ?? Date.now();
  const earliest = from + MIN_LEAD_MS;
  const target = opts.index ?? 0;

  // Walk forward day by day collecting window hits until we reach the target index.
  let seen = 0;
  for (let dayOffset = 0; dayOffset < 60; dayOffset++) {
    const day = new Date(from);
    day.setDate(day.getDate() + dayOffset);

    const slots = schedule.windows
      .filter((w) => w.days.includes(day.getDay()))
      .map((w) => {
        const d = new Date(day);
        d.setHours(w.hour, w.minute, 0, 0);
        return d.getTime();
      })
      .filter((t) => t >= earliest)
      .sort((a, b) => a - b);

    for (const at of slots) {
      if (seen === target) return { at, reason: schedule.reason };
      seen++;
    }
  }
  return null; // unreachable in practice (60-day horizon)
}

/**
 * Convenience spread for asset-creation sites:
 * `{ ...recommendedScheduleFields(type, i) }` adds recommendedAt/recommendedReason
 * when the type is schedulable and nothing otherwise.
 */
export function recommendedScheduleFields(
  assetType: AssetType,
  index = 0,
  platform?: string,
): { recommendedAt: number; recommendedReason: string } | Record<string, never> {
  const rec = recommendPublishTime({ assetType, platform, index });
  return rec ? { recommendedAt: rec.at, recommendedReason: rec.reason } : {};
}
