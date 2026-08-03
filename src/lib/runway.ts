/**
 * Content-runway calculator — pure, client-safe (no Firestore, no server-only).
 *
 * The "runway" is how far into the future a client's calendar is actually
 * filled. Historically it was *emergent*: planClientChain (post-chain.ts) lays
 * one post per postable day and stops when the draft backlog runs out, so a
 * client with a thin backlog silently ran dry (the Karos Labs "nothing after
 * Friday" gap). This module makes the runway *measurable* against a fixed
 * horizon so it can be guaranteed and topped up.
 *
 * It answers two questions for a client:
 *   1. `coveredThroughMs` — the last day that already has an upcoming post
 *      (drives the visible "Runway: filled through <date>" badge).
 *   2. `deficitByFamily` / `shortFamilies` — how many more posts each active
 *      content family needs to reach the horizon (drives the weekly top-up cron,
 *      src/app/api/runway/route.ts).
 *
 * Weekend handling matches the planner exactly by reusing `chainAllowsDay`, so
 * the social target counts only days the platform actually posts on.
 */

import type { Asset, ClientDailyPace } from "@/lib/types";
import {
  chainFamilyFor,
  isReferenceDocAsset,
  startOfDayMs,
  type ChainFamily,
} from "@/lib/post-chain";
import { resolveDailyPace } from "@/lib/daily-pace";
import { chainAllowsDay } from "@/lib/scheduling";

/** Guaranteed rolling horizon: every active client stays filled this many days out. */
export const RUNWAY_HORIZON_DAYS = 14;

/**
 * Jobs one client may be dispatched in a single sweep.
 *
 * Sized to the FILL policy, not to a per-family count. One managed run yields
 * one asset, so a family that is 14 days short needs 14 dispatches to be full —
 * a cap of 2 turned "keep every client's calendar filled" into "add two posts a
 * week", which never catches up on a client who starts empty. The first sweep
 * therefore fills the whole 14-day buffer; weekly sweeps after it top back up
 * to the same horizon, which is ~7 once a week has passed, so a client always
 * has at least a week of runway in hand.
 *
 * The ceiling is per client per sweep and bounds the agency's own agent-service
 * spend, which is the only thing it was ever for — client credits are not
 * touched by a system actor.
 */
const RUNWAY_MAX_JOBS_DEFAULT = RUNWAY_HORIZON_DAYS;

/** Pure so the cap's edge cases are testable without a request. */
export function resolveMaxJobs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return RUNWAY_MAX_JOBS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return RUNWAY_MAX_JOBS_DEFAULT;
  return parsed;
}

/**
 * How many jobs to fire for one short family: one per missing day, since one
 * managed run produces one asset.
 *
 * Deliberately NOT a single job carrying "make 14 posts" in its brief. The
 * managed products take no count field (both schemas are
 * additionalProperties:false, which is what 422'd the first attempt at this),
 * so asking for a batch means asking in prose and hoping — and a prose request
 * for fourteen posts is exactly the batch-shaped instruction that produces
 * fourteen variations of one idea.
 */
export function dispatchesFor(deficit: number, remaining: number): number {
  return Math.max(0, Math.min(deficit, remaining));
}


/** Platforms whose presence makes the social family "active" for a client. */
const SOCIAL_PLATFORMS = new Set([
  "instagram",
  "twitter",
  "facebook",
  "tiktok",
  "youtube",
  "linkedin",
]);

const ALL_FAMILIES: ChainFamily[] = ["social", "email", "article"];

/** Managed product that refills each family (used by the top-up cron). */
export const FAMILY_PRODUCT: Record<ChainFamily, "social_post" | "newsletter_issue" | "blog_article"> = {
  social: "social_post",
  email: "newsletter_issue",
  article: "blog_article",
};

export type RunwayProduct = (typeof FAMILY_PRODUCT)[ChainFamily];

export interface RunwayReport {
  /** Server-local day-start of the furthest upcoming post, or null if none ahead. */
  coveredThroughMs: number | null;
  /** Day-start of the horizon edge (today + RUNWAY_HORIZON_DAYS). */
  horizonThroughMs: number;
  /** Families the client actually produces (connected platform or existing assets). */
  activeFamilies: ChainFamily[];
  /** Target upcoming posts per family within the horizon window. */
  targetByFamily: Record<ChainFamily, number>;
  /** Upcoming/undated candidate posts already available per family. */
  availableByFamily: Record<ChainFamily, number>;
  /** max(0, target − available) per family. */
  deficitByFamily: Record<ChainFamily, number>;
  /** Active families whose deficit > 0 — these need generation. */
  shortFamilies: ChainFamily[];
}

/** Count days d in [today, today+horizon) that this family/platform may post on. */
function countPostableDays(
  assetType: Asset["type"],
  platform: string | undefined,
  now: number,
  horizonDays: number,
): number {
  const today = startOfDayMs(now);
  let count = 0;
  for (let i = 0; i < horizonDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    if (chainAllowsDay(assetType, platform, d.getDay())) count++;
  }
  return count;
}

/**
 * A post that still counts toward future runway: a real (non-placeholder,
 * non-reference) chain asset that isn't published yet and is either undated
 * (a backlog draft the planner will place forward) or dated today-or-later.
 */
function isFutureCandidate(a: Asset, today: number): boolean {
  if (chainFamilyFor(a.type) === null) return false;
  if (a.publishMode === "placeholder") return false;
  if (isReferenceDocAsset(a)) return false;
  if (a.status === "published" || a.publishedAt != null) return false;
  if (a.scheduledAt == null) return true; // undated backlog → will be dated forward
  return startOfDayMs(a.scheduledAt) >= today;
}

/**
 * Measure a client's runway. Pure: same inputs → same output.
 *
 * @param assets             Every asset for the client (unfiltered).
 * @param connectedPlatforms Platform ids with a usable integration (e.g. ["instagram"]).
 * @param now                Reference "now" (epoch millis).
 * @param horizonDays        Defaults to RUNWAY_HORIZON_DAYS.
 * @param pace               The client's stored daily pace. Absent ⇒ one a day.
 */
export function computeRunway(
  assets: Asset[],
  connectedPlatforms: string[],
  now: number,
  horizonDays: number = RUNWAY_HORIZON_DAYS,
  pace?: ClientDailyPace | null,
): RunwayReport {
  const today = startOfDayMs(now);
  const horizonThroughMs = (() => {
    const d = new Date(today);
    d.setDate(d.getDate() + horizonDays);
    return d.getTime();
  })();

  const hasSocialPlatform = connectedPlatforms.some((p) => SOCIAL_PLATFORMS.has(p));
  const familyHasAsset = (family: ChainFamily) =>
    assets.some((a) => chainFamilyFor(a.type) === family && !isReferenceDocAsset(a));

  const activeFamilies = ALL_FAMILIES.filter((family) =>
    family === "social" ? hasSocialPlatform || familyHasAsset(family) : familyHasAsset(family),
  );

  // Target upcoming posts per family within the window. Social fills every
  // postable day (the visible calendar); email/article run at a realistic
  // low cadence so they're never force-generated daily.
  //
  // SCALED BY THE POST LANE, and only by it. A client paced at two posts a day
  // drains this family twice as fast, so a target of one-per-day would report
  // full runway on a calendar that empties in half the horizon. `clipsPerDay`
  // deliberately does NOT scale it: the top-up cron dispatches `social_post`
  // managed runs, which produce written posts, and clips arrive from the podcast
  // pipeline instead — firing more social runs would not fill a clip day.
  //
  // The mirror of that: `availableByFamily` still counts every future social
  // asset, clips included, so a client with a clip backlog is measured as more
  // covered than their post lane alone is. That under-fires rather than
  // over-fires, which is the safe direction for a generator that spends money,
  // and at the default pace of one a day none of this changes anything.
  const postsPerDay = resolveDailyPace(pace).postsPerDay;
  const targetByFamily: Record<ChainFamily, number> = {
    social: countPostableDays("social_post", undefined, now, horizonDays) * postsPerDay,
    email: 2,
    article: 1,
  };

  const availableByFamily: Record<ChainFamily, number> = { social: 0, email: 0, article: 0 };
  let coveredThroughMs: number | null = null;
  for (const a of assets) {
    const family = chainFamilyFor(a.type);
    if (family === null) continue;
    if (isFutureCandidate(a, today)) availableByFamily[family]++;
    // "Filled through" tracks real dated posts (incl. published) that are today-or-later.
    if (a.publishMode !== "placeholder" && !isReferenceDocAsset(a) && a.scheduledAt != null) {
      const day = startOfDayMs(a.scheduledAt);
      if (day >= today && (coveredThroughMs === null || day > coveredThroughMs)) coveredThroughMs = day;
    }
  }

  const deficitByFamily: Record<ChainFamily, number> = { social: 0, email: 0, article: 0 };
  for (const family of ALL_FAMILIES) {
    deficitByFamily[family] = Math.max(0, targetByFamily[family] - availableByFamily[family]);
  }

  const shortFamilies = activeFamilies.filter((family) => deficitByFamily[family] > 0);

  return {
    coveredThroughMs,
    horizonThroughMs,
    activeFamilies,
    targetByFamily,
    availableByFamily,
    deficitByFamily,
    shortFamilies,
  };
}
