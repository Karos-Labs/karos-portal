import type { JobStatus } from "@/lib/types";

/**
 * Which already-fired runs reach a calendar viewer, and which of each run's
 * deliverables that viewer may be told about.
 *
 * ONE home, because this was one question answered in three places: the
 * calendar page held a module-level status set, a second inline
 * `!(isClient && status === "failed")` leg beside it, and the locked-asset
 * filter a hundred lines further down inside the row builder — while the card
 * component decided independently whether it had anything to offer the person
 * it had just told to review something. That split is exactly how the card
 * came to badge "Delivered" over "No client-facing assets from this run."
 *
 * Pure and client-safe (type-only import): the calendar page builds its run
 * rows from `projectPastRuns` on the server, and the card asks
 * `showsPastRunReviewControl` at render, so neither side can grow its own
 * answer.
 *
 * The state half reaches past this page. The Workspace timeline narrates the
 * same jobs to the same viewer, and it held its own copy of the failed-run leg,
 * so it reads `pastRunStatuses` too. The module keeps the calendar's name
 * because the calendar is where all three rules apply; the timeline uses only
 * the first.
 */

/**
 * Per run state: does it reach a staff calendar, and may it reach a client's?
 *
 * Exhaustive over JobStatus by construction — a new run state will not compile
 * until someone has answered both halves for it, rather than defaulting into
 * (or silently out of) a client's calendar.
 *
 * Staff see every state that exists. "cancelled" is a terminal outcome of its
 * own since F30 — without it a stopped run would vanish from the calendar
 * instead of showing what happened that day. "queued"/"running" keep an
 * IN-FLIGHT run visible the whole time it executes: the page's schedule
 * projection only projects FUTURE fires (a fired occurrence falls out of
 * `projectRunOccurrences(from: now)` the instant it is claimed), so without
 * them a run is absent from the moment it is claimed until it reaches a
 * terminal status — the "no visibility into why it failed" gap that set exists
 * to close.
 *
 * A client is not shown two of those states at all, whatever the run produced:
 *   - "failed" — an internal breakage. The people who own it tell the client.
 *   - "cancelled" — a staff member stopped the run on purpose. It reached the
 *     client as an unexplained "Cancelled" row with no reason and no action.
 * Both are refunded outcomes (see JobStatus), so neither is a run the client was
 * charged for or handed anything by — which is why the Workspace timeline
 * withholds them as well, rather than folding a stopped run into its "<agent>
 * worked on your content" row.
 *
 * The remaining states can each be a real client event, but on the calendar only
 * once the run has actually given the client something — see `projectPastRuns`.
 */
const PAST_RUN_VISIBILITY: Record<JobStatus, { staff: boolean; client: boolean }> = {
  queued: { staff: true, client: true },
  running: { staff: true, client: true },
  review: { staff: true, client: true },
  approved: { staff: true, client: true },
  delivered: { staff: true, client: true },
  failed: { staff: true, client: false },
  cancelled: { staff: true, client: false },
};

/**
 * Every run state the table above judges. Exported so anything that enumerates
 * run states — including this module's tests — reads the keys rather than
 * writing its own list that a later addition to JobStatus would leave stale.
 */
export const ALL_RUN_STATES: readonly JobStatus[] = Object.keys(PAST_RUN_VISIBILITY) as JobStatus[];

const STAFF_PAST_STATUSES: ReadonlySet<JobStatus> = new Set(
  (Object.keys(PAST_RUN_VISIBILITY) as JobStatus[]).filter((s) => PAST_RUN_VISIBILITY[s].staff),
);
const CLIENT_PAST_STATUSES: ReadonlySet<JobStatus> = new Set(
  (Object.keys(PAST_RUN_VISIBILITY) as JobStatus[]).filter((s) => PAST_RUN_VISIBILITY[s].client),
);

/** The run states this viewer's calendar can carry as a past-run card. */
export function pastRunStatuses(opts: { isClient: boolean }): ReadonlySet<JobStatus> {
  return opts.isClient ? CLIENT_PAST_STATUSES : STAFF_PAST_STATUSES;
}

/** Only what this module needs from a Job — callers keep their own richer type. */
export interface PastRunJobLike {
  id: string;
  status: JobStatus;
  /**
   * Who pressed the button. Optional because most callers' judgements do not
   * turn on it; rule 3's in-flight exception does, and a caller that omits it
   * simply never qualifies for the exception (the quiet direction).
   */
  createdBy?: string;
}

/** Queued or working — a run with a verdict still to come. */
const IN_FLIGHT_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(["queued", "running"]);

/**
 * Only what this module needs from an Asset. `locked` marks a future-dated post
 * a client may not be shown yet (see redactLockedAsset in lib/asset-visibility).
 */
export interface PastRunAssetLike {
  locked?: boolean;
}

export interface PastRunEntry<J, V> {
  job: J;
  /**
   * The run's deliverables this viewer may be told about, in the order given,
   * already in the shape the card renders — `projectPastRuns` maps them itself
   * (see its `project`).
   *
   * For a client this is empty in exactly ONE case: a queued or running job they
   * started themselves (see `viewerIsWatchingOwnRun`). Everywhere else the drop
   * in `projectPastRuns` guarantees it non-empty, which is what makes "In review"
   * and "nothing to review" mutually exclusive on a client's card — so it has to
   * be THIS array, the one the card receives, rather than a raw list a caller
   * then maps into a second array whose length nothing checks.
   *
   * The exception cannot reopen that: "In review" is `status === "review"`, and
   * the exception admits only queued and running, so no card can badge a review
   * it has nothing to review. The card renders its in-flight line ahead of its
   * "produced no assets" line, so the empty case reads as the run it is.
   */
  deliveredAssets: V[];
}

/**
 * The past runs that belong on this viewer's calendar, each with the subset of
 * its deliverables that viewer may be told about.
 *
 * Three rules, all here:
 *
 * 1. **State.** `pastRunStatuses` above.
 * 2. **Locked deliverables (A3/A4).** A client's future-dated posts are carried
 *    as redacted placeholders, and counting them into a run's summary printed
 *    "7 posts · Ran 3:14 PM" — a whole week attributed to one fire at one
 *    minute. The SCOPE of this rule, exactly: a run's summary is kept to what
 *    the client has been given AT THIS MOMENT. On the day of the fire that
 *    suppresses the count, because the rest of the batch is still locked. It
 *    does NOT survive the week — each post unlocks on its own day, and an
 *    unlocked asset keeps its `jobId` and rejoins its run, so the same card's
 *    summary grows back towards "7 posts" against the original fire time.
 *    Narrowing what the card counts cannot close that; only changing WHAT it
 *    counts (per unlock day) or dropping the count for a multi-asset client run
 *    can, and that is its own finding. Belt-and-braces on top of the redaction
 *    boundary, which nulls a locked placeholder's `jobId` so it does not join
 *    its run while locked. Staff keep the full run (invariant A10.6).
 * 3. **Nothing given, nothing to show.** A client's calendar speaks in posts and
 *    slots, so a run that has given them nothing yet is not an event in their
 *    world — with rule 2 applied there is no honest card left to draw, only a
 *    row that contradicts its own badge. It costs the client no CONTENT: the
 *    work is still on the calendar as slots, and each delivered asset is its own
 *    card.
 *
 *    ONE EXCEPTION, added with AF-9: a queued or running job the READER
 *    THEMSELVES started keeps its card, because the cost this rule named — "a
 *    client no longer watches one execute" — was being paid by the client's own
 *    run gesture, which then had no visible trace anywhere outside the agent
 *    page. `viewerIsWatchingOwnRun` holds the scope and the reasoning; the short
 *    version is that a scheduled fire still does not qualify, so nothing here
 *    tells a client that next week is being generated today. For a run
 *    fired by an ACTIVE schedule, that the agent ran is still on the schedule's
 *    own card under "Last fire" (`lastRunAt`) — and the SUBSTITUTE'S OWN SHAPE
 *    matters, because A3 came for that panel next: staff read "Ran 4 hours ago",
 *    a client reads a date-free "This schedule has run before" (the batch instant
 *    beside a grid of upcoming days is the disclosure A3 forbids). So a client is
 *    told THAT the agent ran, never when. The scope of the substitute is the
 *    schedule row it lives on, so a manually dispatched run, or one whose
 *    schedule is not active, has no card carrying it. Staff keep every run,
 *    including the ones that produced nothing — that is the operational history
 *    the calendar exists to show them.
 *
 *    Both halves are pinned in lib/__tests__/status-render-sweep.test.ts against
 *    run-calendar.tsx's source, so this paragraph cannot go on pointing at
 *    something that is no longer there. It did, for exactly as long as that panel
 *    was gated to staff outright.
 *
 * @param jobs the runs already narrowed to the calendar's run source; this
 *   function judges the VIEWER, not which agent system a job came from.
 * @param assetsByJob jobId → that run's assets, as this viewer receives them.
 * @param opts.project one deliverable in the shape the card renders. Applied
 *   HERE, not by the caller, so the array rule 3 guarantees non-empty for a
 *   client is the same array the card gets. When the caller mapped afterwards
 *   the two could drift: a caller-side `filter` in that map — "only assets with
 *   a preview" — would hand a client card `assets: []` under a "Delivered"
 *   badge again, and nothing here could see it. One list, one length.
 */
export function projectPastRuns<J extends PastRunJobLike, A extends PastRunAssetLike, V>(
  jobs: readonly J[],
  assetsByJob: ReadonlyMap<string, readonly A[]>,
  opts: { isClient: boolean; viewerUid?: string; project: (asset: A) => V },
): PastRunEntry<J, V>[] {
  const statuses = pastRunStatuses(opts);
  const entries: PastRunEntry<J, V>[] = [];
  for (const job of jobs) {
    if (!statuses.has(job.status)) continue;
    const runAssets = assetsByJob.get(job.id) ?? [];
    const shown = opts.isClient ? runAssets.filter((a) => !a.locked) : runAssets;
    // One view per shown deliverable, and the emptiness question asked of the
    // mapped array itself — see `project` above.
    const deliveredAssets = shown.map((a) => opts.project(a));
    if (opts.isClient && deliveredAssets.length === 0 && !viewerIsWatchingOwnRun(job, opts)) {
      continue;
    }
    entries.push({ job, deliveredAssets });
  }
  return entries;
}

/**
 * Rule 3's one exception: a run THIS client started, still executing (AF-9).
 *
 * Rule 3 drops an empty client card because a run that has given them nothing is
 * not an event in their world, and it named the cost out loud — "a client no
 * longer watches one execute". That cost turned out to be the whole feedback of
 * the client's own run gesture: they press "Create a new post", the agent page
 * says a run is in flight, and every other surface they own goes silent for the
 * twenty minutes it takes. Pressing a button and finding no trace of it anywhere
 * is indistinguishable from the press having done nothing (F31, one screen over).
 *
 * SCOPED THE SAME WAY THE AGENT PAGE'S BANNER IS, and for the same two reasons.
 * `createdBy === viewerUid` is not politeness about authorship: a SCHEDULED fire
 * shown as "In progress" on a client's calendar states outright that a batch is
 * being generated now, which is the one fact the slot model exists to keep
 * indistinguishable (A3/A4) — and a staff-fired run is work the client did not
 * ask for and is not being charged for. Their own press is neither.
 *
 * The exception cannot widen what a card SAYS: the run has no deliverables to
 * show, so what a client gets is the status line the card already renders first
 * for this state ("In progress…"), and it disappears into an ordinary delivered
 * card, or out of rule 3 again, the moment the run reaches a verdict.
 */
function viewerIsWatchingOwnRun(
  job: PastRunJobLike,
  opts: { viewerUid?: string },
): boolean {
  if (!IN_FLIGHT_STATUSES.has(job.status)) return false;
  return opts.viewerUid !== undefined && job.createdBy === opts.viewerUid;
}

/**
 * Does the card tell this viewer something is waiting on their review? "review"
 * is the state JOB_STATUS_META badges "In review", so this is that claim.
 */
export function pastRunBadgesReview(run: { jobStatus?: JobStatus }): boolean {
  return run.jobStatus === "review";
}

/**
 * Is there somewhere to send whoever the card asks to review? Staff open the
 * run's own page, which always exists; a client opens the deliverable itself,
 * so a client's card can only offer the control when the run carries one.
 */
export function pastRunHasReviewTarget(
  run: { assets?: readonly unknown[] },
  opts: { canOpenJob: boolean },
): boolean {
  return opts.canOpenJob || (run.assets?.length ?? 0) > 0;
}

/**
 * Did this run produce nothing at all? THE question behind the card's "This run
 * produced no assets." line.
 *
 * Asked of the run's deliverables, never of what the card happens to be able to
 * paint: a clip with no caption is one delivered asset that neither the image
 * gallery nor the text list can render, and answering from those two is what
 * announced "no assets" directly under the card's own "1 post" summary.
 */
export function pastRunHasNoDeliverables(run: { assets?: readonly unknown[] }): boolean {
  return (run.assets?.length ?? 0) === 0;
}

/**
 * Show the "Review deliverable" control? Both halves asked together, so the
 * badge and the control cannot part company — naming a review and offering no
 * way to do it is the defect, and `projectPastRuns` is what keeps the other
 * resolution of it (a client card with no deliverables) from existing.
 */
export function showsPastRunReviewControl(
  run: { jobStatus?: JobStatus; assets?: readonly unknown[] },
  opts: { canOpenJob: boolean },
): boolean {
  return pastRunBadgesReview(run) && pastRunHasReviewTarget(run, opts);
}
