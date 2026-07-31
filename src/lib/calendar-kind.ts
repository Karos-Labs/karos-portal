/**
 * Which calendar chip an asset renders as. Pulled out of calendar-body.tsx so
 * the logic is a pure, server-independent function — testable directly, and
 * reusable anywhere else the calendar's notion of "kind" is needed (the
 * status filter, dashboard failure banners).
 */

import { assetStatusLabel, isPublishHold, PUBLISH_HOLD_HEADING } from "@/lib/asset-status-copy";

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
