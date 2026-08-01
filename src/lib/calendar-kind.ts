/**
 * Which calendar chip an asset renders as. Pulled out of calendar-body.tsx so
 * the logic is a pure, server-independent function — testable directly, and
 * reusable anywhere else the calendar's notion of "kind" is needed (the
 * status filter, dashboard failure banners).
 */

import { assetStatusLabel, isPublishHold, PUBLISH_HOLD_HEADING } from "@/lib/asset-status-copy";
import { jobStatusLabel } from "@/lib/job-status-copy";

/**
 * The chip vocabulary. Every consumer keys a `Record` over this union rather
 * than a hand-written literal list, so adding a member here is a COMPILE error
 * at each of them — that is the only reason `"held"` could be added without
 * hunting for the surfaces that name the chips. `CalendarPost["kind"]` is this
 * type, not a copy of it (run-calendar); re-inlining the list there is what
 * would make the next addition silent.
 */
export type CalendarAssetKind =
  | "published"
  | "scheduled"
  | "placeholder"
  | "failed"
  | "held"
  | "draft";

/** Minimal shape this needs from an Asset — kept narrow so callers don't need a full domain import. */
export interface CalendarKindInput {
  status: "draft" | "approved" | "delivered" | "published" | "scheduled";
  scheduledAt?: number;
  publishedAt?: number;
  publishMode?: string;
  publishError?: string;
}

/**
 * Classifies an asset for calendar rendering, or `null` if it doesn't belong
 * on the calendar at all (e.g. a draft with no scheduledAt yet, or a
 * "delivered"/"approved" asset that was never dated).
 *
 * Order matters: a failed publish attempt is checked before the
 * scheduled/approved branch, because the publish cron intentionally leaves
 * `status` at "scheduled" on failure (src/app/api/publish/route.ts) rather
 * than introducing a distinct Firestore status — `publishError` is the only
 * signal that attempt didn't succeed.
 *
 * And `publishError` carries TWO different facts, which is why "held" exists.
 * The same cron writes its benign ORDERING HOLD into the same field (an earlier
 * post in the format hasn't gone out yet; publishHoldMessage composes the
 * sentence), so before this branch every held post was classified "failed" —
 * giving a client a red "Failed to publish" chip and a "Publish failed" heading
 * over a body that plainly said the post was waiting its turn. The two are told
 * apart by `isPublishHold`, the one test for it (lib/asset-status-copy), never
 * by a prefix check spelled again here.
 *
 * TWO OF THE FIELDS BELOW ARE READ ACROSS THE REDACTION BOUNDARY. A client's
 * future-dated posts reach this function as whitelist-redacted copies
 * (redactLockedAsset in lib/asset-visibility), so a field that copy does not
 * carry is one this classifier is blind to for exactly the posts a client
 * cannot see yet:
 *
 *  • `publishMode` — CARRIED, as the placeholder marker. It was not, and the
 *    cost was a roadmap entry the tier's own promise says Karos never posts
 *    being painted "Scheduled post" and flipping to "Placeholder" on its day.
 *  • `publishError` — NOT carried, and it cannot be: it holds the platform's
 *    own exception. So a locked post carrying one classifies "scheduled" here
 *    and reclassifies once it unlocks. That residual is stated rather than
 *    papered over, and pinned in calendar-locked-chip.test.ts.
 */
export function postKind(a: CalendarKindInput): CalendarAssetKind | null {
  if (a.publishError && a.status !== "published") {
    return isPublishHold(a.publishError) ? "held" : "failed";
  }
  if (a.status === "published" && (a.scheduledAt != null || a.publishedAt != null)) return "published";
  if ((a.status === "scheduled" || a.status === "approved") && a.scheduledAt != null) {
    return a.publishMode === "placeholder" ? "placeholder" : "scheduled";
  }
  if (a.status === "draft" && a.scheduledAt != null) return "draft";
  return null;
}

/**
 * VIEWER-AWARE for `published`, literal for everything else.
 *
 * `published` is the one kind that is also an asset STATUS, so it has a register
 * (a client reads "Posted", because on most channels the client is the one who
 * posts). The rest — placeholder, failed, held, and the calendar's own wording
 * for draft/scheduled — are calendar vocabulary with no register to ask.
 *
 * Without this the chip said "Published" and the modal it opens said "Posted":
 * a client clicking a chip read a second name for the state they just clicked,
 * which is the exact thing PUBLISH_HOLD_HEADING is shared to prevent one screen
 * over. Worse, sharing the register with the modal is what CREATED the mismatch —
 * before that the modal printed the lowercase enum, a case variant of the chip.
 */
export function postKindLabel(kind: CalendarAssetKind, viewerIsClient: boolean): string {
  if (kind === "published") return assetStatusLabel("published", viewerIsClient);
  return POST_KIND_LABEL[kind];
}

/**
 * The legend/filter key domain: every chip kind, plus the one RUN bucket the
 * legend also toggles ("review" is a past run whose `jobStatus` is "review", not
 * an asset kind at all).
 *
 * Here rather than in run-calendar because WHO CAN MATCH a key is a fact about
 * `postKind` above and about calendar-past-runs' visibility table — not about
 * the component that paints the dots.
 */
export type CalendarFilterKey = CalendarAssetKind | "review";

/**
 * Every filter key. Exhaustive by construction — a new `CalendarAssetKind` is a
 * compile error here rather than a member the suite quietly stops covering
 * (the same device as `ALL_RUN_STATES` in lib/calendar-past-runs).
 */
const FILTER_KEY_PRESENT: Record<CalendarFilterKey, true> = {
  published: true,
  scheduled: true,
  placeholder: true,
  failed: true,
  held: true,
  draft: true,
  review: true,
};

export const ALL_CALENDAR_FILTER_KEYS = Object.keys(FILTER_KEY_PRESENT) as CalendarFilterKey[];

/**
 * Which assets a CLIENT's calendar is built from at all.
 *
 * ONE home for it, because it is now asked twice: calendar-body filters the
 * fetched assets through it, and the legend rule below derives what a client can
 * therefore match. Written as the positive question so the two readers cannot
 * disagree about the polarity.
 *
 * Drafts only. A client's calendar has never shown internal drafts (it matches
 * /assets, which redirects a client away entirely), and the archive excludes them
 * too — but the SCOPE of this predicate is the calendar's own asset set, which is
 * the one thing the legend rule may reason from.
 */
export function isClientCalendarStatus(status: CalendarKindInput["status"]): boolean {
  return status !== "draft";
}

/**
 * Filter keys a CLIENT's calendar can never hold — so the legend must not offer
 * them a dot that can never dim anything.
 *
 * ENUMERATED, not guessed at, and the enumeration is what the set is for. The
 * finding named the Draft chip; the sharper question is which of the other six
 * are in the same position, and the answer is none of them:
 *
 *  • published, scheduled — most of a client's calendar. Obviously matchable.
 *  • placeholder — `publishMode: "placeholder"` reaches a client on both sides
 *    of the unlock: redactLockedAsset carries that one value through, and an
 *    unlocked post keeps the field whole. While it was stripped the chip was
 *    still matchable, but a locked roadmap entry matched the WRONG key
 *    ("scheduled") until its own day.
 *  • failed — `clientSafePublishError` replaces the WORDS of a stored
 *    publishError, never the field, so a client's failed post still classifies
 *    as failed.
 *  • held — verified live for clients, and the reason the kind exists: the
 *    publish cron writes its ordering hold onto an approved, dated, past-due
 *    post and nothing in the client projection removes it.
 *  • review — calendar-past-runs' table marks the "review" run state
 *    client-visible, and a client's card needs one unlocked deliverable, which
 *    is the ordinary case for a run in review.
 *  • draft — the one that cannot. `isClientCalendarStatus` drops draft-status
 *    assets before `postKind` ever sees them, and postKind's only "draft" branch
 *    requires exactly that status.
 *
 * The derivation is pinned in calendar-kind.test.ts, which probes `postKind`
 * over every shape it reads rather than trusting this list. It is an UPPER bound
 * on what a client can match — it ignores the RSC redaction, which can only
 * remove shapes — so a key is withheld only when no shape at all could match it.
 * That is the safe direction: the failure mode of a wrong entry here is a filter
 * a client needed, not a chip they cannot use.
 */
const CLIENT_UNMATCHABLE_FILTER_KEYS: ReadonlySet<CalendarFilterKey> = new Set<CalendarFilterKey>([
  "draft",
]);

/** Can this viewer's calendar hold anything this filter key would hide? */
export function calendarFilterKeyMatchable(
  key: CalendarFilterKey,
  viewerIsClient: boolean,
): boolean {
  return !viewerIsClient || !CLIENT_UNMATCHABLE_FILTER_KEYS.has(key);
}

const POST_KIND_LABEL: Record<CalendarAssetKind, string> = {
  published: "Published",
  scheduled: "Scheduled post",
  placeholder: "Placeholder",
  failed: "Failed to publish",
  // The same string the detail modal heads the explanation with — a client who
  // clicks this chip must not land on a second name for the state.
  held: PUBLISH_HOLD_HEADING,
  draft: "Draft",
};

/**
 * The legend/filter register: the SHORT name of each filter key.
 *
 * A second register over the same key domain, not a drifted copy of
 * POST_KIND_LABEL, and the difference is the reason it exists: a filter's own
 * tooltip reads "Show <label> items", so a legend word is shorter than the chip
 * word it filters to. Over the six kinds the two registers share, THREE diverge
 * and each divergence is deliberate:
 *
 *   scheduled    "Scheduled"  vs  "Scheduled post"
 *   failed       "Failed"     vs  "Failed to publish"
 *   held         "Waiting"    vs  PUBLISH_HOLD_HEADING ("Waiting its turn")
 *
 * Named rather than counted. The count here previously read "four of the six
 * agree and three deliberately do not" — which is both wrong (three agree) and
 * impossible over six, and it listed only two of the three divergences, omitting
 * `scheduled`, the one a reader would not predict. A number in a comment is a
 * claim the file cannot verify, so the set is pinned by name in
 * calendar-register-divergence.test.ts instead: adding a fourth divergence, or
 * silently closing one of these three, is a failure there.
 *
 * WHY IT MOVED HERE from run-calendar.tsx's `STATUS_FILTER_CHIPS`. That map paired
 * each label with a Tailwind class, so the words sat in a component and could not
 * be asked for by anything else — including a test. Two consequences, and the
 * second is the finding:
 *
 *  • `published` had its viewer override written TWICE — once in `postKindLabel`
 *    below and again at the render site as
 *    `key === "published" ? assetStatusLabel("published", viewerIsClient) : chip.label`.
 *    One rule, two spellings, both live.
 *  • `review` read "Pending review" while `JOB_STATUS_META.review` — the
 *    sanctioned name, printed by the run card three lines of scroll below on the
 *    SAME screen — reads "In review". `review` is not a chip kind at all: the
 *    filter matches `r.jobStatus === "review"`, so this entry names a `JobStatus`
 *    and had no business inventing a word for one.
 *
 * The classes stayed with the component. Presentation is its business — the same
 * split asset-status-copy.ts made when it took the words and left the colours.
 */
const CALENDAR_FILTER_LABEL: Record<CalendarFilterKey, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  // Overridden per viewer by the accessor below, which is now the only place that
  // override is written.
  published: POST_KIND_LABEL.published,
  held: "Waiting",
  placeholder: "Placeholder",
  failed: "Failed",
  // Not a word of our own: `review` is a `JobStatus`, so it takes that domain's
  // register. `jobStatusLabel` rather than the map so the ONE fallback applies
  // here too, and so this line cannot outlive a rename of the entry.
  review: jobStatusLabel("review"),
};

/**
 * The legend chip's label for one filter key.
 *
 * VIEWER-AWARE for `published` for the reason `postKindLabel` is — and asked
 * here rather than at the render site, so the two cannot drift into different
 * answers for one client.
 */
export function calendarFilterLabel(key: CalendarFilterKey, viewerIsClient: boolean): string {
  if (key === "published") return assetStatusLabel("published", viewerIsClient);
  return CALENDAR_FILTER_LABEL[key];
}
