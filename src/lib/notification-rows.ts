/**
 * THE GRAIN THE NOTIFICATION BELL IS TOLD AT, AND THE ONE COUNT DERIVED FROM IT.
 *
 * Pure and client-safe (types only), so the rule can be driven by a node test
 * that never touches Firestore or React — same reason client-run-rows.ts next
 * door is pure.
 *
 * ── Why the review feed collapses for a client (A3/A4) ──────────────────────
 * A runway sweep tops one client up with up to RUNWAY_MAX_JOBS_PER_CLIENT jobs
 * (default 14, = RUNWAY_HORIZON_DAYS) inside a single minute, and every one of
 * them lands in `review`. A per-job feed therefore renders fourteen rows
 * carrying the same stamp — on the shell of EVERY page, because the bell is
 * chrome — which states outright that a fortnight of content came out of one
 * fire. Capping the list cannot fix that: a cap of 15 never bites on a batch of
 * 14, and a cap that did bite would still print several same-stamped rows.
 *
 * So the client is told the review queue at the grain the dashboard already
 * tells it at: ONE row, no per-item stamps (client-home-overview.tsx, "N
 * deliverables in review"). The summary row deliberately carries NO count —
 * that card counts deliverables in `draft` and this feed counts jobs in
 * `review`, which are different sets, and two numbers answering one question is
 * the defect this closes rather than a second thing to fix. The count lives on
 * the dashboard, which counts the deliverables the client is actually waiting
 * for; the bell says who is holding them.
 *
 * Staff are unaffected: they get one row per job, with its stamp and its
 * /jobs/[id] link, because the batch shape is their own machinery and the
 * forensic detail is the point.
 *
 * `unreadNotificationCount` is the ONLY derivation of "how many unread" in the
 * product. Three surfaces used to compute it independently — the bell's own
 * badge, the client rail's mobile tab dot and the staff sidebar's avatar +
 * hamburger dots — and only the bell applied the viewer's local dismissals, so
 * dismissing a meeting action item decremented the panel and left the dot that
 * summoned it standing. Same reason the review collapse lives here: a badge
 * that counted jobs while the panel rendered one row would be the same lie in
 * the other direction.
 *
 * Guarded by src/lib/__tests__/client-review-feed-grain.test.ts.
 */

import type { ActionItemNotification, AgentReviewNotification, ClientTask } from "@/lib/types";

/**
 * The shape the bell's rows actually need (notification-bell.tsx's
 * `TaskAlertRow`): title, status, priority, createdAt, and — for staff, whose
 * feed is cross-client — `_clientName`. Nothing else.
 *
 * `NotificationFeeds.taskAlerts` is typed to THIS, not to `ClientTask`,
 * because the bell is mounted from `app/(app)/layout.tsx`'s CLIENT_USER branch
 * into `ClientRail`, a "use client" component — so whatever shape crosses
 * there is serialized into every client-portal page's RSC payload and
 * readable from view-source, whether or not `TaskAlertRow` paints it. A full
 * `ClientTask` carries fields this codebase already classifies staff-only
 * even for the task's own client (`client-copy-boundary.test.ts`'s
 * NOT_ON_A_CLIENT_SCREEN entries for `metadata.executionError` and
 * `sourceLabel`), plus `metadata.aiPlan`, `adjustmentFeedback`,
 * `externalJobId`, `agentName`, and `createdBy` (a uid) — none of which a real
 * CLIENT_USER's browser should receive. Staff still pass a full `ClientTask`
 * per row (it structurally satisfies this narrower Pick); only the
 * client-facing feed is narrowed at the source via `clientSafeTaskAlerts`,
 * built by construction rather than by spreading the whole document and
 * trusting the renderer to withhold the rest.
 */
export type TaskAlert = Pick<ClientTask, "id" | "title" | "status" | "priority" | "createdAt"> & {
  _clientName?: string;
};

/** Narrows a client viewer's own task alerts to the fields the bell renders. */
export function clientSafeTaskAlerts(tasks: readonly ClientTask[]): TaskAlert[] {
  return tasks.map(({ id, title, status, priority, createdAt }) => ({
    id,
    title,
    status,
    priority,
    createdAt,
  }));
}

/** The three server-fetched feeds every bell mount — and every badge beside one — reads. */
export interface NotificationFeeds {
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  taskAlerts: TaskAlert[];
}

/**
 * Stable identity of one assigned action item — the key a viewer's local
 * dismissal set holds. Written once so the set the bell writes and the set the
 * shells count against cannot key on two different strings.
 */
export function actionItemKey(item: { transcriptId: string; itemIndex: number }): string {
  return `action-${item.transcriptId}-${item.itemIndex}`;
}

/**
 * Action items minus the ones this viewer has dismissed in this session.
 *
 * The dismissal is also persisted (`dismissAssignedActionItemAction` writes the
 * index into the transcript's `completedItems`, which `listAssignedActionItems`
 * filters on), so this set only has to cover the gap before the shell refreshes.
 */
export function visibleActionItems(
  actionItems: readonly ActionItemNotification[],
  /**
   * REQUIRED, and that is the guard. It was optional, so
   * `visibleActionItems(actionItems)` compiled, ran, and left every test green
   * — which is #105 in mirror image: the badge and both shell dots subtract the
   * dismissal (they go through `unreadNotificationCount`, which passes the set)
   * while the dismissed row stays on screen in the panel. A count and a list
   * disagreeing about one dismissal is the finding, whichever side drops it.
   *
   * Pass an empty set to mean "nothing dismissed". Making the caller say so is
   * the whole point: an omission is now a compile error rather than a silent
   * half-fix, which is a mechanical exemption instead of a written one.
   */
  dismissed: ReadonlySet<string>,
): ActionItemNotification[] {
  if (dismissed.size === 0) return [...actionItems];
  return actionItems.filter((n) => !dismissed.has(actionItemKey(n)));
}

/**
 * One review row for a client, one row per job for staff.
 *
 * A summary row holds no job — which is what makes "no per-item timestamps"
 * structural rather than a rendering promise: there is no item to stamp.
 */
export type ReviewFeedRow =
  | { kind: "job"; job: AgentReviewNotification }
  | { kind: "summary" };

export function reviewFeedRows(
  reviewJobs: readonly AgentReviewNotification[],
  opts: { viewerIsClient: boolean },
): ReviewFeedRow[] {
  if (!opts.viewerIsClient) return reviewJobs.map((job) => ({ kind: "job", job }));
  return reviewJobs.length > 0 ? [{ kind: "summary" }] : [];
}

/**
 * How many notification ROWS this viewer has — the number every badge, dot and
 * panel header in the product prints.
 *
 * Rows, not source records: for a client the whole review queue is one row, so
 * a sweep that mints fourteen jobs moves the badge by one. A badge reading "14"
 * the minute a sweep lands is the batch tell on the shell of every page just as
 * much as fourteen rows inside the panel are.
 */
export function unreadNotificationCount(
  feeds: NotificationFeeds,
  /**
   * `dismissed` is REQUIRED for the same reason it is on `visibleActionItems`:
   * a shell that omits it gets a count that ignores dismissals, which is #105
   * exactly — the badge stays at N while the panel shows N-1. Pass an empty set
   * to mean "nothing dismissed", and let the compiler ask.
   */
  opts: { viewerIsClient: boolean; dismissed: ReadonlySet<string> },
): number {
  return (
    visibleActionItems(feeds.actionItems, opts.dismissed).length +
    reviewFeedRows(feeds.reviewJobs, opts).length +
    feeds.taskAlerts.length
  );
}
