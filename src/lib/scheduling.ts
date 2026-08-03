/**
 * Optimal publish-time recommendation engine.
 *
 * Agents stamp every schedulable output with a recommended publication slot at
 * generation time (Asset.recommendedAt / recommendedReason). The recommendation
 * is deterministic and heuristic — industry-standard engagement windows per
 * platform — rather than an extra model call: it's free, instant, testable, and
 * good enough as a default the user can always override in the schedule form.
 *
 * All times are computed in the runtime's local timezone (matches how the
 * datetime-local schedule form interprets times for staff). This file also
 * holds the one definition of "which calendar day is this instant on" — see the
 * section immediately below.
 */

import type { AssetType } from "@/lib/types";

/* ══════════════════ the local calendar day (one definition) ══════════════════ */

/**
 * WHICH CALENDAR DAY AN INSTANT FALLS ON, written once.
 *
 * `startOfDayMs` is the bucket and `sameLocalDay` is the comparison, and the
 * second is DEFINED from the first so the two cannot answer differently. They
 * were two exported functions with two bodies — one here, one in post-chain.ts,
 * the pair of them the "one definition of 'same day'" this comment used to
 * claim on its own — and post-chain.ts now re-exports these rather than
 * restating them, so every caller of either import path gets this code.
 *
 * WHOSE CLOCK, stated because it is a real cost and not a detail. "Local" here
 * is THE RUNTIME'S OWN ZONE: server-local inside a server action, cron or
 * script; the BROWSER's zone inside a client component. A day boundary is
 * therefore the boundary of whichever machine asked, never the client's own.
 *
 * What that costs today, stated no wider than it is:
 *  · The chain still places exactly ONE post per day per family, in every zone:
 *    its slots are a fixed server-local hour a day apart, so they stay a day
 *    apart wherever they are read. What can shift is WHICH day — a slot lands
 *    on the client's next date when their offset carries CHAIN_SLOT_HOUR past
 *    midnight (from a UTC container at 11:00, that is UTC+13 and beyond).
 *  · `isAssetUnlockedForClient` (post-chain.ts) unlocks at SERVER midnight. For
 *    a client west of the server that instant is still the previous afternoon
 *    where they are — a post dated Tuesday becomes readable during their
 *    Monday. East of it, some hours into their own Tuesday.
 *  · A guard evaluated on BOTH sides — `markPostedBlock` is the one that is —
 *    can disagree between browser and server inside that offset window. The
 *    server's answer is the one that counts; the UI is never the guard.
 *
 * Fixing it properly means giving `Client` an IANA zone (it has none; only
 * `RunCadence.timezone` and `PlannedScheduledRun.timeZone` carry one) and
 * threading it through every caller of these two functions — a data change plus
 * a decision about what a "day" means for a client with staff in three
 * countries. Until that decision is made this is the behaviour, and it is
 * pinned by test rather than left implicit — see local-day-one-definition.test.ts.
 */
export function startOfDayMs(t: number): number {
  return new Date(t).setHours(0, 0, 0, 0);
}

/** True when both instants fall on the same runtime-local calendar day. */
export function sameLocalDay(a: number, b: number): boolean {
  return startOfDayMs(a) === startOfDayMs(b);
}

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
  tiktok: {
    windows: [
      { days: [2, 3, 4], hour: 18, minute: 0 },
      { days: WEEKDAYS, hour: 20, minute: 0 },
    ],
    reason: "TikTok watch time peaks on weekday evenings when short-form scrolling spikes",
  },
};

/**
 * Fallback platform used to pick a window when no platform is known yet. Also
 * reused by the analytics sync (src/app/api/analytics/sync/route.ts) to infer a
 * distribution channel for assets that were marked "published" without ever
 * having `scheduledPlatform` set (e.g. bulk-imported content) — otherwise those
 * assets can never surface in AI Insights.
 */
export const DEFAULT_PLATFORM_FOR_TYPE: Partial<Record<AssetType, string>> = {
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
 * Per-platform "smart weekend" policy for content-chain day placement. Weekdays
 * (Mon–Fri) are always postable; a weekend day (Sun=0 / Sat=6) is allowed ONLY
 * when the asset's platform actually has an engagement window on it — today only
 * YouTube (Sat). Email and weekday-only platforms (Instagram, LinkedIn, X, …)
 * are therefore never placed on a weekend.
 *
 * Derived from the same PLATFORM_SCHEDULES / EMAIL_SCHEDULE windows the
 * recommendation engine uses, so the chain planner (post-chain.ts) and the
 * runway calculator (runway.ts) can't disagree about which days count. When the
 * type/platform maps to no known schedule the policy fails OPEN (every day
 * allowed) — an unclassified asset keeps the pre-weekend behaviour.
 *
 * @param weekday 0=Sun … 6=Sat (server-local, matching Date#getDay()).
 */
export function chainAllowsDay(assetType: AssetType, platform: string | undefined, weekday: number): boolean {
  if (weekday >= 1 && weekday <= 5) return true; // weekdays: always postable
  const schedule = scheduleFor(assetType, platform);
  if (!schedule) return true; // unknown mapping ⇒ don't restrict
  return schedule.windows.some((w) => w.days.includes(weekday));
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
 * No more than this many pieces should land on a single day before we spread
 * to the next. Matches the content chain's one-post-per-day rule
 * (lib/post-chain.ts) so staff density suggestions agree with chain dates.
 */
const MAX_PER_DAY = 1;
/** Keep publications at least this far apart so a day never feels spammy. */
const MIN_GAP_MS = 90 * 60 * 1000;

/**
 * Calendar-density-aware optimal slot.
 *
 * Starts from the platform's engagement windows (recommendPublishTime) but walks
 * forward past any window that would crowd the client's existing calendar — a day
 * already holding MAX_PER_DAY items, or a slot within MIN_GAP_MS of something booked.
 * This looks at the client's *current* scheduled/approved/published times so the
 * recommendation adapts to how full the calendar already is and to past scheduling
 * cadence, rather than blindly returning the same window every time.
 *
 * @param scheduled  Epoch-millis of the client's already-booked publications.
 * @returns          A slot the user can accept or override; null only when the type
 *                   has no scheduling dimension at all.
 */
export function recommendPublishTimeWithDensity(opts: {
  assetType: AssetType;
  platform?: string;
  scheduled: number[];
  from?: number;
}): { at: number; reason: string } | null {
  const from = opts.from ?? Date.now();
  const booked = opts.scheduled.filter((t) => Number.isFinite(t));

  const base = recommendPublishTime({ assetType: opts.assetType, platform: opts.platform, from });
  if (!base) return null;

  const dayFull = (t: number) => booked.filter((s) => sameLocalDay(s, t)).length >= MAX_PER_DAY;
  const tooClose = (t: number) => booked.some((s) => Math.abs(s - t) < MIN_GAP_MS);

  // Walk successive optimal windows until one lands on an uncrowded day.
  for (let index = 0; index < 90; index++) {
    const rec = recommendPublishTime({ assetType: opts.assetType, platform: opts.platform, index, from });
    if (!rec) break;
    if (!dayFull(rec.at) && !tooClose(rec.at)) {
      const reason =
        booked.length > 0
          ? `${rec.reason}. Spaced out to keep your calendar evenly paced.`
          : rec.reason;
      return { at: rec.at, reason };
    }
  }
  // Everything in the horizon is crowded — fall back to the base optimal slot.
  return base;
}

/* ══════════ schedule-form field validation (pure, client-safe) ══════════ */

/**
 * The closed question this section answers: **can a number that is not a finite
 * number reach a stored schedule field?**
 *
 * A PlannedScheduledRun stores its intent as plain numbers (hour, minute,
 * weekday, dayOfMonth, …) and every path that turns them into a fire time is
 * arithmetic. So a bad number is not "input that gets rejected downstream" — it
 * IS a schedule, and it is a schedule that bills:
 *
 *  · An EMPTY `<input type="time">` is the string `""`. Split on ":" and mapped
 *    through `Number`, that is `[0]` — hour 0, minute undefined — which is
 *    indistinguishable from a client deliberately choosing 00:00, so a
 *    fat-fingered field silently moved every future post to the middle of the
 *    night.
 *  · A NON-NUMERIC value is NaN, and NaN survives Math.round / Math.min /
 *    Math.max unchanged. It reaches storage, renders as "NaN:NaN", and makes
 *    the next-fire search return no candidate — so the schedule fires roughly
 *    whenever the cron happens to catch it, drifting.
 *
 * Both are answered here, in one place, before the payload leaves the browser.
 *
 * MIDNIGHT STAYS REACHABLE. An hour of 0 is a real time of day and "00:00"
 * parses to hour 0. What is refused is the ABSENCE of a choice, never a
 * legitimate zero — which is also why the sweep below tests `Number.isFinite`
 * rather than falsiness.
 */

/** Result of reading a schedule field off a form: the value, or what to show. */
export type ScheduleFieldResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** `HH:MM`, optionally with the seconds a stepped time input can append. */
const WALL_CLOCK_RE = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

const TIME_MISSING = "Choose a time of day before saving.";
const TIME_UNREADABLE = "Enter a valid time of day, for example 09:30.";

/**
 * Strictly reads an `<input type="time">` value into the hour/minute a schedule
 * stores. Anything that is not a real 24-hour wall clock — empty, blank,
 * partial, out of range — comes back as a message the person can read instead
 * of a number the scheduler would fire on.
 */
export function parseWallClockTime(
  raw: string | null | undefined,
): ScheduleFieldResult<{ hour: number; minute: number }> {
  const value = (raw ?? "").trim();
  if (value === "") return { ok: false, error: TIME_MISSING };
  const match = WALL_CLOCK_RE.exec(value);
  if (!match) return { ok: false, error: TIME_UNREADABLE };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: TIME_UNREADABLE };
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { ok: false, error: TIME_UNREADABLE };
  }
  return { ok: true, hour, minute };
}

/**
 * Name of the first entry that is a number but not a finite one, else null.
 *
 * Mechanical on purpose: it walks the object it is HANDED rather than a
 * hand-written list of field names, so a schedule payload that grows a new
 * numeric field is swept the day it is added and nobody has to remember. A
 * missing (`undefined`) field is not this function's business — the server
 * decides what a field's absence means — and `0` is a legitimate value for
 * every numeric schedule field that can hold it.
 */
export function firstNonFiniteScheduleField(payload: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "number" && !Number.isFinite(value)) return key;
  }
  return null;
}

/**
 * The one pre-flight both schedule dialogs run before calling their server
 * action: the typed time of day, plus a finiteness sweep of every other number
 * the form is about to send.
 *
 * The sweep's message never names the offending field — a field name is an
 * internal identifier, and the only way a client sees this branch at all is a
 * page whose state is already wrong.
 */
export function validateScheduleTiming(input: {
  time: string | null | undefined;
  /** Every other number the form is about to send, by payload key. */
  counts?: Record<string, unknown>;
}): ScheduleFieldResult<{ hour: number; minute: number }> {
  const parsed = parseWallClockTime(input.time);
  if (!parsed.ok) return parsed;
  if (input.counts && firstNonFiniteScheduleField(input.counts) !== null) {
    return { ok: false, error: "Those settings could not be read. Reload the page and try again." };
  }
  return parsed;
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
