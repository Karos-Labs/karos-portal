/**
 * THE GRAIN THE NOTIFICATION BELL IS TOLD AT, AND THE ONE COUNT DERIVED FROM IT.
 *
 * Pure and client-safe (types only), so the rule can be driven by a node test
 * that never touches Firestore or React — same reason client-run-rows.ts next
 * door is pure.
 *
 * ── Why a client's bell carries neither Karos-owned feed (A3/A4, round 6) ────
 * A runway sweep tops one client up with up to RUNWAY_MAX_JOBS_PER_CLIENT jobs
 * (default 14, = RUNWAY_HORIZON_DAYS) inside a single minute, and every one of
 * them lands in `review`. A per-job feed therefore renders fourteen rows
 * carrying the same stamp — on the shell of EVERY page, because the bell is
 * chrome — which states outright that a fortnight of content came out of one
 * fire. Capping the list cannot fix that: a cap of 15 never bites on a batch of
 * 14, and a cap that did bite would still print several same-stamped rows.
 *
 * The first answer (#118, R10) was to collapse each feed to a stampless summary
 * line. That solved the batch tell and left an inert row: it named work, refused
 * a count because the dashboard already prints one, and led nowhere, because
 * nothing a client can open lists a draft. Round 6's ruling is that every
 * notification row must lead somewhere, so the line is gone rather than
 * softened — a persisting condition that asks nothing of the reader is an
 * indicator, and its home is Home's attention card ("N deliverables in review",
 * "N tasks ready for review"), where the count and the rows can sit together.
 *
 * Staff are unaffected: they get one row per job and one per task, with its
 * stamp and its /jobs/[id] link, because the batch shape is their own machinery
 * and the forensic detail is the point.
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
 * One row per job for staff. NO ROW AT ALL FOR A CLIENT (round 6, 2026-09).
 *
 * It used to collapse to one stampless summary line, which fixed the batch tell
 * (#118, A3/A4) and left the row inert: it named work, carried no count and led
 * nowhere, because nothing a client can open lists a draft. R10's own comment
 * defended that as consistent with Home, where the same counts are also
 * destination-less.
 *
 * Albert's round-6 ruling supersedes it: every notification row must be
 * clickable and lead somewhere. A persisting condition that asks nothing of the
 * reader is an indicator, not a notification (NN/g), so the fact stays where it
 * already lives — Home's attention card, "N deliverables in review" — and the
 * badge stops counting a row nobody can act on. Staff are untouched: the batch
 * shape is their own machinery and /jobs/[id] is where they work.
 */
export type ReviewFeedRow = { kind: "job"; job: AgentReviewNotification };

export function reviewFeedRows(
  reviewJobs: readonly AgentReviewNotification[],
  opts: { viewerIsClient: boolean },
): ReviewFeedRow[] {
  if (opts.viewerIsClient) return [];
  return reviewJobs.map((job) => ({ kind: "job", job }));
}

/**
 * One row per task for staff. NO ROW AT ALL FOR A CLIENT (round 6, 2026-09).
 *
 * The same revision as `reviewFeedRows` above, for the same reason and with the
 * same history. R10 collapsed a client's per-task rows into one stampless
 * summary line per status group, because the rows named work with nowhere to go
 * (the Workspace board they used to open was removed in 2026-08 and nothing
 * replaced it) and because a swarm proposes a whole set of tasks in one pass, so
 * a per-task list on the chrome of every page publishes the batch. The audit's
 * other option — give them Home's destination — did not survive, because on Home
 * these very counts are ALSO destination-less by explicit ruling.
 *
 * Round 6 closes it from the other end: an inert row is not a row. Sign-off is
 * staff-only (`approveAssetAction` calls `requireStaff`), content ideas already
 * render on the calendar, and the counts still live on Home's attention card. So
 * a client's bell no longer carries this feed and the badge no longer counts it.
 *
 * Staff are unaffected — cross-client rows with their own stamps and client
 * names are the forensic detail they work from.
 */
export type TaskAlertFeedRow = { kind: "task"; task: TaskAlert };

export function taskAlertRows(
  taskAlerts: readonly TaskAlert[],
  opts: { viewerIsClient: boolean },
): TaskAlertFeedRow[] {
  if (opts.viewerIsClient) return [];
  return taskAlerts.map((task) => ({ kind: "task", task }));
}

/**
 * How many notification ROWS this viewer has — the number every badge, dot and
 * panel header in the product prints.
 *
 * Rows, not source records, and that is the whole contract: whatever the two
 * feed builders above return for THIS viewer is what the panel paints and what
 * every badge counts. For staff that is one row per job and per task; for a
 * client, since round 6, it is the meeting action items and nothing else, so a
 * sweep that mints fourteen review jobs moves a client's badge by zero. A badge
 * reading "14" the minute a sweep lands is the batch tell on the shell of every
 * page just as much as fourteen rows inside the panel are.
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
    // ROWS, not records. Both builders answer for this viewer, so the sum is the
    // panel's own row count by construction rather than by two lists agreeing.
    taskAlertRows(feeds.taskAlerts, opts).length
  );
}
