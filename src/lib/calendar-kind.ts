/**
 * Which calendar chip an asset renders as. Pulled out of calendar-body.tsx so
 * the logic is a pure, server-independent function — testable directly, and
 * reusable anywhere else the calendar's notion of "kind" is needed (the
 * status filter, dashboard failure banners).
 */

import { isPublishHold } from "@/lib/asset-status-copy";

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
