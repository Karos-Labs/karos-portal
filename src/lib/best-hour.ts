/**
 * WHEN THIS CLIENT'S OWN POSTS DID BEST, MEASURED.
 *
 * §09 asks for "scheduling by best hour" and notes that no deliverable carries
 * a suggested publish time. Half of that was already here and is worth being
 * precise about: `recommendPublishTimeWithDensity` proposes a slot, but it
 * proposes it from the shape of the CALENDAR — what is already booked, what
 * the platform's conventional hours are. It has never once looked at how the
 * client's own published posts actually performed.
 *
 * This does, and it is deliberately the smaller half: it answers only the hour,
 * only from live measured rows, and only when there are enough of them to mean
 * anything. The density planner still picks the day.
 *
 * ## The rules, and why each one
 *
 * **Live rows only.** `source` is `"mock" | "live"` and mock rows exist in
 * quantity. An hour "learned" from placeholder data is a confident invention —
 * the same trap `performance-signal.ts` documents for its own projection.
 *
 * **A published post, or it has no hour at all.** The metric row carries
 * `capturedAt` — when the numbers were FETCHED — which says nothing about when
 * the post went out. The hour comes from the asset's `publishedAt`, and a row
 * whose asset never published is not evidence about publishing times.
 *
 * **The median, never the mean.** One post that went unusually well is the most
 * common shape in this data; a mean lets that single post elect its own hour.
 *
 * **A floor on the sample, per account AND per hour.** Two posts at 09:00 is
 * not a pattern, and an account with six posts has no hour-of-day signal at
 * all. Below either floor the answer is a refusal, which leaves the density
 * planner exactly as it was.
 */

/** One published, measured post, as this projection needs it. */
export interface MeasuredPublish {
  /** Epoch millis the post actually went out (`Asset.publishedAt`). */
  publishedAt: number;
  /** 0–100 normalised engagement, as the analytics row carries it. */
  engagementScore: number;
  source: "mock" | "live";
  platform: string;
}

/** Posts on the platform before any hour may be proposed. Under this an account has no time-of-day signal. */
export const MIN_PUBLISHES_FOR_HOUR = 10;
/** Posts in one hour bucket before that hour may be proposed. Two is a coincidence. */
export const MIN_PUBLISHES_PER_HOUR = 3;
/** How far above the account's own median an hour must sit to be worth moving a post for. */
export const MIN_HOUR_LIFT = 0.15;

export interface BestHour {
  /** Local hour of day, 0–23, in the timezone the server schedules in. */
  hour: number;
  /** The hour's median engagement against the account's own median. 1.0 is "no different". */
  lift: number;
  /** How many published posts sit in that hour. */
  posts: number;
}

export interface BestHourResult {
  best?: BestHour;
  /** Why there is no answer, when there is none. For a reader asking why the suggestion did not change. */
  refusal?: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function bestPublishHour(posts: readonly MeasuredPublish[], platform: string): BestHourResult {
  const live = posts.filter((p) => p.platform === platform && p.source === "live" && Number.isFinite(p.publishedAt) && p.publishedAt > 0);
  if (live.length < MIN_PUBLISHES_FOR_HOUR) {
    return {
      refusal: `${live.length} published ${platform} post(s) measured; ${MIN_PUBLISHES_FOR_HOUR} are needed before an hour means anything.`,
    };
  }

  const accountMedian = median(live.map((p) => p.engagementScore));
  if (accountMedian <= 0) {
    return { refusal: `no measured engagement on ${platform} yet — every published post scores zero.` };
  }

  const byHour = new Map<number, number[]>();
  for (const post of live) {
    const hour = new Date(post.publishedAt).getHours();
    byHour.set(hour, [...(byHour.get(hour) ?? []), post.engagementScore]);
  }

  let best: BestHour | undefined;
  for (const [hour, scores] of byHour) {
    if (scores.length < MIN_PUBLISHES_PER_HOUR) continue;
    const lift = median(scores) / accountMedian;
    if (lift - 1 < MIN_HOUR_LIFT) continue;
    // A strictly-greater comparison means ties go to the hour seen first, and
    // the map is filled in publish order: a stable answer beats an arbitrary
    // one, and two equal hours is not a reason to move a post later in the day.
    if (best === undefined || lift > best.lift) best = { hour, lift: Math.round(lift * 100) / 100, posts: scores.length };
  }

  return best
    ? { best }
    : {
        refusal: `no hour on ${platform} has ${MIN_PUBLISHES_PER_HOUR} published posts and a median clear of the account's by ${MIN_HOUR_LIFT}.`,
      };
}

/** The sentence the reviewer reads beside the suggested slot. Never shown to a client. */
export function describeBestHour(best: BestHour): string {
  const hour = `${String(best.hour).padStart(2, "0")}:00`;
  return `your ${hour} posts score ${best.lift}x your own median across ${best.posts} published posts`;
}

/**
 * The same day, moved to the hour that measured best.
 *
 * The density planner owns WHICH DAY — it knows what is already booked and
 * what the platform posts on. This only moves the clock inside that day, and
 * refuses to move a slot into the past: a recommendation the reviewer cannot
 * accept is worse than the one they already had.
 */
export function atHour(slot: number, hour: number, now: number): number | null {
  const moved = new Date(slot);
  moved.setHours(hour, 0, 0, 0);
  return moved.getTime() > now + 60_000 ? moved.getTime() : null;
}
