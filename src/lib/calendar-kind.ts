/**
 * Which calendar chip an asset renders as. Pulled out of calendar-body.tsx so
 * the logic is a pure, server-independent function — testable directly, and
 * reusable anywhere else the calendar's notion of "kind" is needed (the
 * status filter, dashboard failure banners).
 */

export type CalendarAssetKind = "published" | "scheduled" | "placeholder" | "failed" | "draft";

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
 */
export function postKind(a: CalendarKindInput): CalendarAssetKind | null {
  if (a.publishError && a.status !== "published") return "failed";
  if (a.status === "published" && (a.scheduledAt != null || a.publishedAt != null)) return "published";
  if ((a.status === "scheduled" || a.status === "approved") && a.scheduledAt != null) {
    return a.publishMode === "placeholder" ? "placeholder" : "scheduled";
  }
  if (a.status === "draft" && a.scheduledAt != null) return "draft";
  return null;
}
