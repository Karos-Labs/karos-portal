/**
 * Copy for a deliverable's publish state — the asset-status REGISTERS, and the
 * one publish-hold sentence a client reads (pure, client-safe: this module
 * imports nothing but the type, so any surface may import it).
 *
 * TWO registers live here, because "what do we call this status" is one rule
 * asked by two readers:
 *
 *  • CLIENT_ASSET_STATUS_LABEL — what a paying client is told. "published"
 *    reads as "Posted", because on most channels the client is the one who
 *    posts, by hand. Read off the map by archive-view.tsx's status filter, and
 *    through the accessors below by its tile badges, client-analytics.tsx's
 *    "Content by status" chart when the viewer is a client, and
 *    publishHoldMessage.
 *  • STAFF_ASSET_STATUS_LABEL — what an operator is told. "draft" reads as
 *    "Awaiting review", because for staff the status names the work they owe.
 *    Read off the map by assets-view.tsx (the library filter and the group
 *    headings), and through the accessors by the same analytics chart when the
 *    viewer is staff.
 *
 * Neither of those is a reader INVENTORY, and this note is not the place to keep
 * one: a surface that asks `assetStatusLabel(status, viewerIsClient)` reads
 * whichever register its viewer picks, and there are more of those than when the
 * lists were written — client-home-overview's activity badge, the detail modal's
 * badge, the calendar's published chip and filter, the copilot's find_output.
 * The closed question is which files import this module.
 *
 * There were THREE maps before this module, and the third was the tell:
 * client-analytics.tsx's STATUS_META was read by clients AND staff (one
 * component, one mount — `viewerIsClient` now decides only the words), and it printed
 * "Published" where the archive one tab away printed "Posted" — one client, two
 * words, one status. Its own comment already called itself "the same class as
 * archive-view's STATUS_LABEL". Only the WORDS moved here; the chart's colours
 * stayed with the chart, because presentation is that component's business.
 *
 * Enforced, not asserted — and enforced BY SHAPE, which is the honest way to say
 * it. asset-status-registers.test.ts sweeps src/ for the two shapes a second
 * vocabulary is written in (an object literal keyed by asset statuses whose
 * values carry words, and a ternary chain over status literals that yields
 * capitalised ones) and fails if a staff label changes. Two shapes, not "any way
 * of naming a status": a `switch`, a lookup built at runtime, or an i18n table
 * would all pass, and the second shape is only swept because the first alone
 * would have let this campaign's own deletion be undone unseen.
 *
 * SCOPE — stated rather than counted, because the two docstrings this replaces
 * both got the count wrong. The first claimed "ONE map, and this is it" while a
 * third map sat in client-analytics.tsx. The second replaced that with a number
 * ("two places still say a status word without asking a register") and was also
 * false, having missed the surfaces below. A number here is a claim the file
 * cannot verify, so this one does not make it.
 *
 * What this module owns: the asset-status label MAPS, and the tripwire enforces
 * that no OTHER file in src/ writes one in either shape above. That is narrower
 * than "it owns all of them" — the claim this line used to make, which the scan
 * could not back — and it is the claim the scan actually checks. It also owns the
 * copy for a stored `publishError` — the hold sentence, the prefix that
 * identifies it, and the heading a reader sees over it.
 *
 * What is out of scope: a surface that renders `Asset["status"]` directly
 * instead of looking a label up. Two client-reachable ones did, and now ask the
 * accessor (components/client-home-overview.tsx's Recent activity badge,
 * components/asset-detail-modal.tsx's status badge). Three still render the raw
 * enum, and they are left alone deliberately: the staff register says "Awaiting
 * review" where CSS `capitalize` renders "Draft", so converting them changes a
 * staff word, which is a copy decision and not a duplicate to delete. What makes
 * each one staff-only differs, so each is named with its own reason rather than
 * lumped under one clause:
 *
 *  • components/asset-card.tsx — renders it unconditionally, and both mounts sit
 *    behind a staff route (app/(app)/jobs/[id] requires KAROS_ADMIN/EMPLOYEE;
 *    assets-view's two pages redirect a CLIENT_USER away).
 *  • components/client-agents/outputs-hub.tsx — also unconditional. Its gate is
 *    the Control Room mount, which asset-status-surfaces.test.ts pins as staff-only
 *    for the sake of its hard-coded `viewerIsClient={false}`.
 *  • components/client-agents/clip-gallery.tsx — the only one of the three with a
 *    `!viewerIsClient` branch of its own.
 *
 * PATHS, because the previous version of this line named the last two by bare
 * filename — the same pointer defect asset-type-copy.ts's note declares fixed, and
 * worse here, since both live under components/client-agents/ rather than
 * components/. It also attached "the `!viewerIsClient` branch" to all three when
 * only one has one.
 *
 * Also out of scope: `calendar-kind.ts`'s POST_KIND_LABEL (read through
 * `postKindLabel`), keyed by `CalendarAssetKind` — a different key domain
 * (`placeholder`, `failed` and `held` are not statuses) and so a different
 * vocabulary rather than a drifted copy of this one. That line used to name
 * run-calendar.tsx, which now only mentions the map in a comment: a pointer this
 * campaign navigates by, pointing at the wrong file.
 *
 * Do not read either list as exhaustive: they are scope, not an inventory.
 */

import type { Asset } from "@/lib/types";

/**
 * The CLIENT register. Was a local `const STATUS_LABEL` in archive-view.tsx
 * while the publish cron interpolated the RAW ENUM into a sentence a client
 * reads ("…is still scheduled") — which is exactly the second answer a shared
 * register exists to prevent.
 */
export const CLIENT_ASSET_STATUS_LABEL: Record<Asset["status"], string> = {
  draft: "Draft",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Posted",
  delivered: "Delivered",
};

/**
 * The STAFF register, lifted VERBATIM from assets-view.tsx's `STATUS_LABEL` —
 * byte for byte, so the staff library's filter options and group headings read
 * exactly as they did before. A test pins every byte: changing a staff word is a
 * copy decision, and this module's job was to remove a duplicate, not to make
 * one.
 *
 * One rendered byte DID move, and it is the whole point of the note: the
 * analytics chart printed the third map's "Draft" to staff and now prints this
 * register's "Awaiting review". No new word was invented — the chart converged
 * on the canonical staff one. Keeping "Draft" for staff would have preserved the
 * drift under a new name.
 */
export const STAFF_ASSET_STATUS_LABEL: Record<Asset["status"], string> = {
  draft: "Awaiting review",
  approved: "Approved",
  scheduled: "Scheduled",
  delivered: "Delivered",
  published: "Published",
};

/**
 * The rendered label for a reader, defensively falling back to the stored value
 * for a status Firestore holds and the type doesn't (which is why the parameter
 * is `string`: the analytics chart derives its rows from stored data, not from
 * the union).
 *
 * A surface that serves BOTH readers asks this with its viewer flag; a
 * client-only surface uses clientAssetStatusLabel.
 *
 * ONE FALLBACK, and unlike the sibling claim in job-status-copy.ts this one was
 * checked before being written: no other file spells a `??` over these maps.
 * assets-view.tsx and archive-view.tsx do index them directly, but over key-typed
 * lists, so a status missing from a register is a compile error at those sites
 * rather than a second answer. So a status the union has never heard of resolves
 * here, once, for every reader.
 */
export function assetStatusLabel(status: string, viewerIsClient: boolean): string {
  const register = viewerIsClient ? CLIENT_ASSET_STATUS_LABEL : STAFF_ASSET_STATUS_LABEL;
  return register[status as Asset["status"]] ?? status;
}

/** The client register's label. Shorthand for a surface that has no staff reader. */
export function clientAssetStatusLabel(status: string): string {
  return assetStatusLabel(status, true);
}

/**
 * The lead-in of the ordering-hold message, as a constant.
 *
 * `clientSafePublishError` allowlists a stored `publishError` by this prefix —
 * the same startsWith dispatch `isClientReadableRefusal` uses for the three
 * setup refusals. It has to be distinctive for that to be safe: a two-word
 * generic opener ("Waiting for") could be the first two words of an upstream
 * SDK exception, and allowlisting one of those would ship the leak the
 * sanitizer exists to stop. Both branches below open with it.
 *
 * NOT exported. It was, and `clientSafePublishError` spelled the startsWith out
 * for itself — which is fine while there is one such caller and a bug the moment
 * there are three. Private, the only way to ask is `isPublishHold`, so a second
 * spelling would have to retype the literal (which asset-status-surfaces.test.ts
 * forbids repo-wide).
 */
const PUBLISH_HOLD_PREFIX = "This post is waiting for";

/**
 * Whether a stored `publishError` is the ordering hold above rather than a real
 * failure — THE test for that, asked by everything that has to tell the two
 * apart:
 *
 *  • clientSafePublishError, which passes the hold to a client verbatim and
 *    collapses everything else to the generic failure line;
 *  • postKind (lib/calendar-kind), which classifies a held post as "held" so
 *    the calendar draws a neutral chip instead of a red "Failed to publish" one;
 *  • asset-detail-modal, which heads the notice panel with PUBLISH_HOLD_HEADING
 *    instead of "Publish failed";
 *  • asset-card, staff's deliverable card, which draws the same two panels.
 *    It is the FOURTH reader and it was missing from this list — found by
 *    sweeping src/ for the failure wording (asset-status-surfaces.test.ts), not
 *    by reading a list, which is why the sweep is the guarantee and this is
 *    orientation.
 *
 * One test, in one place, because the failure mode is a DISAGREEMENT: a second
 * spelling that drifted would leave one surface calling the same stored string
 * benign while another calls it a failure — which is the bug this replaced,
 * where the body said the post was waiting its turn under a heading that said
 * it had failed.
 */
export function isPublishHold(publishError: string): boolean {
  return publishError.startsWith(PUBLISH_HOLD_PREFIX);
}

/**
 * The heading over a held post's explanation, and the calendar's label for its
 * chip — ONE string for both, so a client who clicks a chip does not read a
 * second name for the state they just clicked.
 *
 * Neutral on purpose. The hold is benign, self-clearing and needs nothing from
 * the reader (the cron releases it on the next tick once the predecessor is
 * posted), so it gets neither the danger tone nor the word "failed". "Publish
 * failed" stays inline at asset-detail-modal's other branch: that heading is
 * unchanged by this and has one reader.
 */
export const PUBLISH_HOLD_HEADING = "Waiting its turn";

/** The closing sentence of both branches: what happens next, and what ends the wait. */
const PUBLISH_HOLD_TAIL = "This post goes out once that one is posted (or removed).";

/**
 * Why a due post is being HELD rather than published: an earlier post in the
 * same format hasn't gone out yet (see blockingPredecessor). Written onto the
 * asset by the auto-publish cron, and therefore read by a client on four
 * surfaces — so it is client copy, and it is composed here so that stays true.
 *
 * Two branches, because the blocker is USUALLY INVISIBLE to the client.
 * `blockingPredecessor` accepts any status except "published", so it is most
 * often the draft sitting behind it — and no client surface lists a draft (the
 * archive excludes them, the calendar filters them out, /assets redirects a
 * client to /tasks). Naming a title the client cannot find, and pinning a status
 * onto it, describes something they have never been shown; worse, a draft's
 * title is unapproved copy, which is why redactLockedAsset replaces titles
 * rather than passing them. So the invisible branch says who is holding it
 * instead, and only the branch the client can actually go and look at carries
 * the title and the status word.
 *
 * `clientCanSeeBlocker` is a REQUIRED parameter rather than something derived in
 * here: the predicate that answers it is `isInClientArchive` (asset-visibility),
 * and importing it would both cycle (asset-visibility → custom-agent-launch →
 * this module) and drag the server-side visibility stack into every client
 * bundle that imports a label. The caller asks that predicate — it is not
 * allowed to hand-roll a status test — and the cron's wiring is pinned by a
 * source guard in publish-error-boundary.test.ts.
 *
 * "format" is the client's word for this grouping, the one live-card and
 * launch-card already use ("In your Workspace under this format", "the set of
 * post formats this agent will produce"). "Series" is our internal word for it
 * (post-chain.ts) and appears in no rendered string.
 *
 * The version this replaced broke two rules in one line: a spaced hyphen
 * (ledger F71) and the raw Firestore status enum interpolated as prose.
 */
export function publishHoldMessage(
  blocker: Pick<Asset, "title" | "status">,
  opts: { clientCanSeeBlocker: boolean },
): string {
  if (!opts.clientCanSeeBlocker) {
    // State-neutral on purpose. `isInClientArchive` is false for four different
    // reasons — draft, test-run asset, launch deliverable, and not-yet-unlocked —
    // and the last one is reachable in normal use, because blockingPredecessor
    // orders by sequence rather than by date: post 1 scheduled for next week
    // blocks post 2 due today. That predecessor is approved and scheduled, so
    // nobody is "finishing" it. This wording is true under all four.
    return (
      `${PUBLISH_HOLD_PREFIX} an earlier post in this format that isn't in your Workspace ` +
      `yet — your Karos team is getting it out. ${PUBLISH_HOLD_TAIL}`
    );
  }
  return (
    `${PUBLISH_HOLD_PREFIX} "${blocker.title}" — it comes earlier in this format, and its ` +
    `status is still ${clientAssetStatusLabel(blocker.status)}. ${PUBLISH_HOLD_TAIL}`
  );
}
