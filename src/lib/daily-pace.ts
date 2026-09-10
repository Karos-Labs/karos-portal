/**
 * Per-client daily PACE: how many items one calendar day holds, and of what.
 *
 * ── WHY A LANE AND NOT A NUMBER ──────────────────────────────────────────────
 * Two day planners place a client's content and both were structurally one per
 * day: `planClientChain` (post-chain.ts) walks a cursor with a `Set` of booked
 * day-starts per content family, and `planBulkSchedule` (bulk-schedule.ts) does
 * the same for staff-uploaded clips. They share the day space on purpose (the
 * bulk planner seeds its occupancy from every dated social asset), so a clip and
 * a post can never land on the same date today.
 *
 * The ask (AF-19) is "two clips a day PLUS one post a day". A single
 * `itemsPerDay: 3` cannot express it: nothing then stops three clips and no
 * post. What distinguishes the two is the MEDIUM, and this codebase already has
 * exactly one runtime discriminator for that — `assetVideos(asset).length > 0`
 * (see the note in agent-detail-archetypes.ts: `Asset` has no kind field and
 * `AssetType` is video-agnostic, a clip is a `social_post` with a `videoUrl`).
 * So the day has two LANES, each with its own ceiling.
 *
 * ── THE ONE RULE, AND ITS ONE EXCEPTION ──────────────────────────────────────
 * A day holds up to `clipsPerDay` clips AND up to `postsPerDay` posts, EXCEPT
 * when the client has no stored pace at all, in which case the two lanes share a
 * single slot a day.
 *
 * The exception exists to keep every existing calendar exactly as it is. Without
 * it, "default 1 and 1" would mean one clip AND one post a day, which is a
 * second item on every day of every client who has both, on the day this
 * shipped. Absence is therefore the legacy behaviour and configuring a pace is
 * the opt-in, which is also why `resolveDailyPace` reports `configured` rather
 * than hiding the distinction behind two numbers that happen to be 1.
 *
 * ── NOT A DISCLOSURE ─────────────────────────────────────────────────────────
 * Pace is a SETTING on the client record, read by the planners. It is never
 * rendered to a client as "you get N a day", and nothing here counts a batch
 * (A3/A4): the numbers say how densely the calendar may be filled, not how much
 * exists.
 *
 * CLIENT-SAFE: no firebase-admin, no data.ts. Imported by both planners, the
 * staff editor and the digest alike. Timestamps are epoch millis.
 */

import type { Asset, ClientDailyPace } from "@/lib/types";
import { assetVideos } from "@/lib/asset-images";

/** The two kinds of thing a calendar day can hold. */
export type PaceLane = "clip" | "post";

/** What one lane holds a day when nothing is configured. */
export const DEFAULT_PER_DAY = 1;

/**
 * Ceiling on a configured lane.
 *
 * A ceiling at all, because the planners walk a day cursor and the number is
 * typed by a person: it bounds how much of one day a mis-typed "20" can claim.
 * Six is above any pace anyone has asked for and well under the point where a
 * day stops reading as a day.
 */
export const MAX_PER_DAY = 6;

/**
 * A stored per-day number, or null when there isn't a usable one.
 *
 * ZERO IS NOT A PACE, and refusing it is load-bearing rather than fussy: the
 * planners advance their cursor while a lane is full, so a ceiling of 0 is a
 * loop that never terminates. Non-integers, negatives, NaN and non-numbers all
 * come back null (⇒ the field reads as unset), and anything above the ceiling is
 * clamped down to it.
 */
export function clampPerDay(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const whole = Math.floor(value);
  if (whole < 1) return null;
  return Math.min(whole, MAX_PER_DAY);
}

/** A client's pace with every default applied, plus whether one was stored. */
export interface ResolvedPace {
  /**
   * True when the client record carries at least one usable number. False ⇒ the
   * two lanes share one slot a day, which is the pre-pace behaviour.
   */
  configured: boolean;
  clipsPerDay: number;
  postsPerDay: number;
}

/** Today's behaviour, named — one item a day, lanes shared. */
export const LEGACY_PACE: ResolvedPace = {
  configured: false,
  clipsPerDay: DEFAULT_PER_DAY,
  postsPerDay: DEFAULT_PER_DAY,
};

/**
 * Read a client's stored pace. Anything unusable falls back to the default,
 * and a record with no usable number at all resolves to `LEGACY_PACE`.
 *
 * Setting ONE number is enough: a client configured with `clipsPerDay: 2` gets
 * two clips and one post a day, because the other lane takes its default. That
 * is the shape AF-19 asks for with a single edit.
 */
export function resolveDailyPace(pace: ClientDailyPace | null | undefined): ResolvedPace {
  const clips = clampPerDay(pace?.clipsPerDay);
  const posts = clampPerDay(pace?.postsPerDay);
  if (clips === null && posts === null) return LEGACY_PACE;
  return {
    configured: true,
    clipsPerDay: clips ?? DEFAULT_PER_DAY,
    postsPerDay: posts ?? DEFAULT_PER_DAY,
  };
}

/**
 * The pace object to STORE for a pair of typed numbers, or undefined when the
 * pair says "no pace" — so a staff member who clears both boxes puts the client
 * back on the shared day rather than leaving a `{}` behind that reads as
 * configured to nothing.
 */
export function toStoredPace(input: {
  clipsPerDay?: unknown;
  postsPerDay?: unknown;
}): ClientDailyPace | undefined {
  const clips = clampPerDay(input.clipsPerDay);
  const posts = clampPerDay(input.postsPerDay);
  if (clips === null && posts === null) return undefined;
  return {
    ...(clips !== null ? { clipsPerDay: clips } : {}),
    ...(posts !== null ? { postsPerDay: posts } : {}),
  };
}

/**
 * Which lane an asset books its day in.
 *
 * `assetVideos` rather than a type test or a `meta.bulkUpload` test, because it
 * is the codebase's one video discriminator and it already covers all four
 * places a clip's URL can sit (`videoUrl`, `meta.videos`, `meta.files`,
 * `meta.artifacts`) — a lab-imported podcast cut and a staff-uploaded one are
 * both clips here, and neither carries a distinguishing `AssetType`.
 *
 * MUST BE ASKED OF THE RAW ASSET. `redactLockedAsset` builds by whitelist and
 * carries no `videoUrl` and no `meta`, so a redacted copy always answers "post".
 * Both planners run server-side on unredacted documents, which is the only place
 * this is called.
 */
export function paceLaneFor(asset: Asset): PaceLane {
  return assetVideos(asset).length > 0 ? "clip" : "post";
}

/**
 * The running tally of what each day already holds, per lane.
 *
 * Shared by both planners so "is this day full" has one answer. When the pace is
 * unconfigured the lane is dropped from the key, which is precisely how the
 * legacy single-slot day is expressed — one counter per day, ceiling 1, whatever
 * kind of item claims it.
 */
export interface DayLedger {
  /** Has this day reached this lane's ceiling? */
  isFull(lane: PaceLane, dayStartMs: number): boolean;
  /** Record one item on this day in this lane. */
  book(lane: PaceLane, dayStartMs: number): void;
  /** How many items this day already holds in this lane. */
  count(lane: PaceLane, dayStartMs: number): number;
}

export function createDayLedger(pace: ResolvedPace): DayLedger {
  const counts = new Map<string, number>();
  const key = (lane: PaceLane, day: number) => (pace.configured ? `${lane}:${day}` : String(day));
  const ceiling = (lane: PaceLane) => {
    if (!pace.configured) return DEFAULT_PER_DAY;
    return lane === "clip" ? pace.clipsPerDay : pace.postsPerDay;
  };
  return {
    count: (lane, day) => counts.get(key(lane, day)) ?? 0,
    isFull: (lane, day) => (counts.get(key(lane, day)) ?? 0) >= ceiling(lane),
    book: (lane, day) => {
      const k = key(lane, day);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    },
  };
}
