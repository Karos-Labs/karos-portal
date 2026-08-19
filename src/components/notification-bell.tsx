"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn, relativeTime } from "@/lib/utils";
import { dismissAssignedActionItemAction } from "@/lib/actions";
import {
  actionItemKey,
  reviewFeedRows,
  unreadNotificationCount,
  visibleActionItems,
  type NotificationFeeds,
  type TaskAlert,
} from "@/lib/notification-rows";
import type { AgentReviewNotification } from "@/lib/types";

/* ── Priority colours for task alerts ───────────────────────────── */

const PRIORITY_COLOR: Record<string, string> = {
  high:   "var(--danger)",
  medium: "var(--warning)",
  low:    "var(--muted)",
};

/**
 * Anything older than this is still shown - dropping work silently is worse
 * than showing it - but visually stepped back, so a 19-day-old row stops
 * reading as something that just happened (QA F143).
 */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The dismissal set a shell owns on behalf of every bell it mounts, plus the
 * write that persists it.
 *
 * OWNED BY THE SHELL, not by the bell, and that is the whole of QA #105. The
 * set used to be `useState` inside this component, so the bell's own badge
 * shrank on dismissal while the two badges one level up — the client rail's
 * mobile tab dot and the staff sidebar's avatar + hamburger dots — kept
 * counting the row the viewer had just cleared. Lifting it puts one set behind
 * one derivation (`unreadNotificationCount`), so the panel and every dot beside
 * it move together.
 */
export interface NotificationDismissals {
  dismissed: ReadonlySet<string>;
  dismiss: (transcriptId: string, itemIndex: number) => void;
}

/**
 * That set, wired to the server write. One hook, called once per shell — the
 * body used to sit in this component and would otherwise have to be copied into
 * both shells.
 *
 * OPTIMISTIC, AND REVERSIBLE. The row disappears on click; if the write throws
 * (the action refuses anyone but the assignee) the key comes back out of the
 * set and the row returns, rather than leaving a viewer looking at a feed that
 * quietly disagrees with the server. On success `router.refresh()` re-fetches
 * the shell, so the item leaves the server feed too and the local set stops
 * being load-bearing — the action's own `revalidatePath` covers the transcript
 * page, not the page the viewer is standing on.
 */
export function useNotificationDismissals(): NotificationDismissals {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [, startTransition] = useTransition();

  return {
    dismissed,
    dismiss(transcriptId: string, itemIndex: number) {
      const key = actionItemKey({ transcriptId, itemIndex });
      setDismissed((prev) => new Set([...prev, key]));
      startTransition(async () => {
        try {
          await dismissAssignedActionItemAction(transcriptId, itemIndex);
          router.refresh();
        } catch {
          setDismissed((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      });
    },
  };
}

/**
 * `actionItems` / `reviewJobs` / `taskAlerts` come in through NotificationFeeds
 * — the same shape the shells hand to `unreadNotificationCount`, so the panel
 * and the badge beside it cannot be built from two different sets. Task alerts
 * are the pending + review_pending tasks; staff feeds are cross-client and
 * carry `_clientName`.
 */
interface Props extends NotificationFeeds {
  /** Where the panel opens relative to the trigger. */
  panelPlacement?: "down" | "up" | "right";
  /**
   * Extra classes for the panel, merged last so a width here beats the default
   * w-80. Needed where the trigger sits inside a narrow scroll container: the
   * mobile drawer is w-64 with overflow-y-auto, which forces overflow-x to
   * auto, so a 320px panel is clipped AND grows a horizontal scrollbar.
   */
  panelClassName?: string;
  /** Render trigger as an icon button (default) or a full-width labeled row (account menu). */
  variant?: "icon" | "row";
  /**
   * True when the viewer is a client, whichever shell mounted this bell.
   *
   * TWO things hang off it, and both are about the same viewer:
   *
   *  · GRAIN. The whole review queue collapses to one stampless summary row
   *    instead of one row per job (#118, A3/A4 — reviewFeedRows). It is also
   *    what makes the badge count that queue as one, which matters more than
   *    the panel does: the badge is on screen before anything is opened.
   *  · DESTINATION and WORDS. /jobs/[id] is staff-only and bounces a client
   *    back to their dashboard (QA F51), and the archive — the destination that
   *    replaced it — provably excludes the drafts these rows count. Where a
   *    per-job row IS still rendered it also takes the client's copy, which is
   *    why the link behaviour has its own prop below.
   */
  viewerIsClient?: boolean;
  /**
   * Whether a review row may deep-link to /jobs/[id]. False in a shell whose
   * own nav has removed that route — staff in Client View get clientViewNav,
   * which has no Jobs tab, so a row that deep-linked there dropped them on a
   * page the surrounding nav had just taken away.
   *
   * Deliberately NOT `viewerIsClient`: that flag also swaps "Waiting for your
   * review" for "Your Karos team is reviewing it", and a staff member IS the
   * Karos team — the review really is theirs, and telling them otherwise would
   * hide work they own. This prop turns off the link and nothing else.
   */
  allowJobDeepLinks?: boolean;
  /**
   * Called whenever a row or footer link navigates, alongside closing the
   * panel. Mounts inside the mobile Company sheet pass the sheet's own close:
   * a link to the route already open navigates nowhere, so the sheet's
   * on-navigation effect never fires and it sits over the page it reached
   * (the same-route trap the sheet's other rows already close by hand).
   */
  onNavigate?: () => void;
  /** The shell's dismissal set — see NotificationDismissals above (#105). */
  dismissals: NotificationDismissals;
}

export function NotificationBell({
  actionItems,
  reviewJobs,
  taskAlerts,
  panelPlacement = "down",
  panelClassName,
  variant = "icon",
  viewerIsClient = false,
  allowJobDeepLinks = true,
  onNavigate,
  dismissals,
}: Props) {
  const [open, setOpen] = useState(false);

  const visibleActions = visibleActionItems(actionItems, dismissals.dismissed);
  // Review rows have no dismiss control: the X used to write nothing but local
  // state, so the row (and the count) came back on the next page load - a badge
  // that lies (QA F121). listReviewJobs queries status == "review", so the row
  // clears by itself the moment the job is approved, exactly like the task rows.
  //
  // ONE row for a client, one per job for staff (A3/A4 — see notification-rows.ts).
  const reviewRows = reviewFeedRows(reviewJobs, { viewerIsClient });

  // Task alerts: review_pending tasks are surfaced first (need immediate attention),
  // then pending tasks. No local dismissal - they disappear when status changes.
  const reviewPendingTasks = taskAlerts.filter((t) => t.status === "review_pending");
  const pendingTasks = taskAlerts.filter((t) => t.status === "pending");

  // The product's only "how many unread" — the shells' dots read the very same
  // function off the very same feeds and dismissal set (#105).
  const total = unreadNotificationCount(
    { actionItems, reviewJobs, taskAlerts },
    { viewerIsClient, dismissed: dismissals.dismissed },
  );

  // A client never gets the job link back, whatever a caller passes: /jobs is
  // staff-only, so the flag that describes the viewer wins over the flag that
  // describes the shell.
  const jobDeepLinks = allowJobDeepLinks && !viewerIsClient;

  // The Workspace board is gone entirely (2026-08) and nothing replaced it as
  // an aggregate view of TASKS, so task alerts no longer earn a footer link —
  // TaskAlertRow above is a status line for the same reason (F97 × F149). A
  // staff review queue still has a real aggregate destination: /jobs, the
  // staff-only dashboard these AgentReviewNotification rows are drawn from. A
  // client's queue collapses to one ReviewSummaryRow with no /jobs to offer
  // them (viewerIsClient excludes it here, same as jobDeepLinks above).
  const showJobsLink = reviewRows.length > 0 && !viewerIsClient;
  const showMeetingsLink = visibleActions.length > 0;

  // CD-H7b: one number, one noun. The badge clamped at "9+" while the panel
  // header read "32 active" - the same set, described two ways, so opening the
  // panel looked like it had found 23 more. The clamp now only bites in the
  // hundreds (where a badge genuinely cannot hold the digits), and the header
  // calls the set what the bell's own aria-label and the Company tab's
  // screen-reader text already call it: unread.
  const badgeLabel = total > 99 ? "99+" : String(total);

  // Date.now() intentional: rows are stepped back once they age past
  // STALE_MS; recomputed on every open.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  /** Every row/footer link runs this: close the panel, then let the shell that
   *  mounted us close itself too (the sheet mounts pass their own close). */
  function closeAfterNavigate() {
    setOpen(false);
    onNavigate?.();
  }

  return (
    <div className="relative">
      {variant === "row" ? (
        <button
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
            "text-muted hover:bg-surface-2 hover:text-foreground",
            open && "bg-surface-2 text-foreground",
          )}
        >
          <Icon name="Bell" className="h-4 w-4 text-muted-2" />
          <span className="flex-1 text-left">Notifications</span>
          {total > 0 && (
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-neon px-1 text-[10px] font-bold">
              {badgeLabel}
            </span>
          )}
        </button>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            "text-muted transition-all duration-150 hover:bg-surface-2 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40",
            open && "bg-surface-2 text-foreground",
          )}
          aria-label={`Notifications${total > 0 ? ` (${total} unread)` : ""}`}
        >
          <Icon name="Bell" className="h-4 w-4" />
          {total > 0 && (
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center",
                "rounded-full bg-neon px-1 text-[10px] font-bold",
              )}
            >
              {badgeLabel}
            </span>
          )}
        </button>
      )}

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Panel */}
          <div
            className={cn(
              "absolute z-50 w-80 overflow-hidden",
              panelPlacement === "up"
                ? "bottom-full left-0 mb-2"
                : panelPlacement === "right"
                  ? "bottom-0 left-full ml-2"
                  : "right-0 top-full mt-2",
              "rounded-md border border-border glass-surface shadow-2xl",
              // Column so a caller-supplied max-height squeezes the FEED rather
              // than truncating the panel - the header and footer stay put and
              // the rows scroll. No effect on mounts that set no height: with
              // nothing to shrink against, the feed keeps its own max-h.
              "flex flex-col",
              panelClassName,
            )}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
              {total > 0 ? (
                <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-muted">
                  {badgeLabel} unread
                </span>
              ) : (
                <span className="text-[11px] text-muted-2">All clear</span>
              )}
            </div>

            {/* Feed */}
            <div className="min-h-0 flex-1 max-h-[480px] overflow-y-auto">
              {total === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                    <Icon name="CircleCheck" className="h-6 w-6 text-success" />
                  </div>
                  <p className="text-sm font-medium text-foreground">All caught up!</p>
                  <p className="text-xs text-muted-2">No pending tasks or reviews.</p>
                </div>
              ) : (
                <div className="divide-y divide-border">

                  {/* ── Review-pending tasks (highest priority) ── */}
                  {reviewPendingTasks.length > 0 && (
                    <>
                      <div className="bg-warning/5 px-4 py-1.5">
                        <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-warning">
                          Ready for review ({reviewPendingTasks.length})
                        </p>
                      </div>
                      {reviewPendingTasks.map((t) => (
                        <TaskAlertRow key={t.id} task={t} now={now} />
                      ))}
                    </>
                  )}

                  {/* ── Pending tasks ── */}
                  {pendingTasks.length > 0 && (
                    <>
                      <div className="bg-surface-2 px-4 py-1.5">
                        <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted">
                          Pending tasks ({pendingTasks.length})
                        </p>
                      </div>
                      {pendingTasks.map((t) => (
                        <TaskAlertRow key={t.id} task={t} now={now} />
                      ))}
                    </>
                  )}

                  {/* ── Agent review jobs ──
                      One summary row for a client, one row per job for staff —
                      the grain is decided in notification-rows.ts, not here. */}
                  {reviewRows.map((row) =>
                    row.kind === "summary" ? (
                      <ReviewSummaryRow key="review-summary" />
                    ) : (
                      <ReviewJobRow
                        key={row.job.jobId}
                        job={row.job}
                        now={now}
                        viewerIsClient={viewerIsClient}
                        deepLink={jobDeepLinks}
                        onNavigate={closeAfterNavigate}
                      />
                    ),
                  )}

                  {/* ── Transcript action items ── */}
                  {visibleActions.map((n) => (
                    <div
                      key={`${n.transcriptId}-${n.itemIndex}`}
                      className={cn(
                        "flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2",
                        n.meetingDate != null && now - n.meetingDate > STALE_MS && "opacity-60",
                      )}
                    >
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success/10">
                        <Icon name="SquareCheck" className="h-3.5 w-3.5 text-success" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground">
                          A meeting assigned you an action item
                        </p>
                        <p className="mt-0.5 line-clamp-3 break-words text-[11px] text-muted">
                          {n.text}
                        </p>
                        <Link
                          href={`/transcripts/${n.transcriptId}`}
                          onClick={closeAfterNavigate}
                          className="mt-0.5 inline-block text-[11px] text-muted-2 hover:text-foreground"
                        >
                          {n.transcriptTitle}
                          {n.meetingDate ? ` · ${relativeTime(n.meetingDate)}` : ""}
                        </Link>
                      </div>
                      <button
                        onClick={() => dismissals.dismiss(n.transcriptId, n.itemIndex)}
                        className={cn(
                          "mt-0.5 shrink-0 rounded-[6px] p-1 text-muted-2",
                          "transition-colors hover:bg-surface-3 hover:text-foreground",
                        )}
                        aria-label="Mark complete and dismiss"
                        title="Mark complete"
                      >
                        <Icon name="X" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer - one link per KIND of row actually in the feed. A panel
                of meeting action items used to be footed "View workspace →"
                and vice versa (QA F143). */}
            {(showJobsLink || showMeetingsLink) && (
              <div className="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2.5">
                {showJobsLink && (
                  <Link
                    href="/jobs"
                    onClick={closeAfterNavigate}
                    className="text-[11px] text-muted-2 transition-colors hover:text-foreground"
                  >
                    View all jobs →
                  </Link>
                )}
                {showMeetingsLink && (
                  <Link
                    href="/transcripts"
                    onClick={closeAfterNavigate}
                    className="text-[11px] text-muted-2 transition-colors hover:text-foreground"
                  >
                    View all meetings →
                  </Link>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Agent review summary row (clients) ──────────────────────────── */

/**
 * The whole review queue, told to a client as one status line (#118, A3/A4).
 *
 * Deliberately holds NO job, NO count and NO timestamp, and takes no props that
 * could supply one:
 *
 *  · No per-item rows, because a runway sweep mints up to fourteen jobs in one
 *    minute and fourteen identically-stamped rows on the chrome of every page
 *    announce that a fortnight of content came out of a single fire.
 *  · No count, because the dashboard one screen over already prints one ("N
 *    deliverables in review") and it counts a DIFFERENT set — deliverables in
 *    `draft`, against this feed's jobs in `review`. Two numbers answering one
 *    question is the defect; the honest fix is one number, on the card that
 *    counts the thing the client is waiting for.
 *  · No destination, for the reason the dashboard row has none either: nothing
 *    a client can open lists a draft.
 *
 * Copy is the dashboard's, near enough to read as the same fact twice rather
 * than two facts (client-home-overview.tsx, "Your Karos team is reviewing
 * these — they'll appear in your archive when ready").
 *
 * Exported for test: the panel only mounts after a click on the trigger, which
 * a node test run cannot perform.
 */
export function ReviewSummaryRow() {
  return (
    <div className="flex gap-3 px-4 py-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-info/10">
        <Icon name="Sparkles" className="h-3.5 w-3.5 text-info" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">
          Your Karos team is reviewing new work
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          It&apos;ll appear in your archive when it&apos;s ready.
        </p>
      </div>
    </div>
  );
}

/* ── Agent review row ────────────────────────────────────────────── */

/**
 * A review job's output is a DRAFT, and no surface a client can reach lists a
 * draft — the archive excludes drafts by design (asset-visibility.ts
 * isInClientArchive), the calendar filters them out, /jobs is staff-only. So
 * for a client this row is a status line, not a destination: the same ruling
 * client-home-overview.tsx already applies to the identical fact ("N
 * deliverables in review"). The copy follows: approval is staff-only
 * (approveAssetAction calls requireStaff), so "Waiting for your review" was
 * asking the client for a sign-off the server would refuse.
 *
 * A REAL CLIENT NO LONGER REACHES THIS ROW AT ALL: `reviewFeedRows` collapses
 * their whole queue to one ReviewSummaryRow above (#118), because a per-job
 * list of any length publishes the generation batch. The `viewerIsClient`
 * branch below stays anyway, and stays fail-closed rather than dead: the prop
 * is still threaded from every mount, and a caller that ever hands this row a
 * client again must get the client's words, not a request for a sign-off the
 * server refuses.
 *
 * `deepLink` is a separate question from `viewerIsClient`, because a shell can
 * withdraw the destination without changing who is looking: staff in Client
 * View are served clientViewNav, which has no Jobs tab, so the row must not
 * lead there — but the review is still theirs and the copy must keep saying so.
 *
 * Exported for test: these rows only mount after a click on the trigger, which
 * a node test run cannot perform.
 */
export function ReviewJobRow({
  job,
  now,
  viewerIsClient,
  deepLink,
  onNavigate,
}: {
  job: AgentReviewNotification;
  now: number;
  viewerIsClient: boolean;
  deepLink: boolean;
  onNavigate: () => void;
}) {
  const body = (
    <>
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-info/10">
        <Icon name="Sparkles" className="h-3.5 w-3.5 text-info" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{job.agentName} finished a draft</p>
        <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-muted">{job.title}</p>
        <p className="mt-0.5 text-[11px] text-muted-2">
          {job.clientName ? `${job.clientName} · ` : ""}
          {viewerIsClient ? "Your Karos team is reviewing it" : "Waiting for your review"} ·{" "}
          {relativeTime(job.updatedAt)}
        </p>
      </div>
    </>
  );

  return (
    <div
      className={cn(
        "flex items-start gap-1",
        // Hover follows the link, not the viewer: an unclickable row that
        // lights up on hover is a promise the row cannot keep.
        deepLink && "transition-colors hover:bg-surface-2",
        now - job.updatedAt > STALE_MS && "opacity-60",
      )}
    >
      {deepLink ? (
        <Link
          href={`/jobs/${job.jobId}`}
          onClick={onNavigate}
          className="flex min-w-0 flex-1 gap-3 px-4 py-3"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 gap-3 px-4 py-3">{body}</div>
      )}
    </div>
  );
}

/* ── Task alert row ──────────────────────────────────────────────── */

/**
 * A task alert is a STATUS LINE, not a destination, same ruling as
 * ReviewJobRow/ReviewSummaryRow above (F97 × F149): it used to open the
 * Workspace board on the tab holding the task (QA F64's fix), and the board is
 * gone entirely (2026-08). No screen replaced it — this row's data still
 * surfaces on Home as an AttentionRow count, which carries the same "no
 * destination" ruling for the identical reason (see client-home-overview.tsx).
 * No arrow, no hover affordance: it must not promise a click it cannot honour.
 */
function TaskAlertRow({ task, now }: { task: TaskAlert; now: number }) {
  const isReview = task.status === "review_pending";
  const prioColor = PRIORITY_COLOR[task.priority] ?? PRIORITY_COLOR.low;

  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-3",
        now - task.createdAt > STALE_MS && "opacity-60",
      )}
    >
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in srgb, ${isReview ? "var(--neon)" : prioColor} 10%, transparent)` }}
      >
        <Icon
          name={isReview ? "Eye" : "Circle"}
          className="h-3.5 w-3.5"
          style={{ color: isReview ? "var(--neon)" : prioColor }}
        />
      </div>
      <div className="min-w-0 flex-1">
        {/* Subject + verb first, the task's own wording second - a raw task
            description is not an event and read as a clipped sentence. */}
        <p className="text-xs font-medium leading-snug text-foreground">
          {isReview ? "A task is ready for your review" : "A task is waiting on you"}
        </p>
        <p className="mt-0.5 line-clamp-3 break-words text-[11px] leading-snug text-muted">
          {task.title}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-2">
          {task._clientName ? `${task._clientName} · ` : ""}
          {task.priority} priority · {relativeTime(task.createdAt)}
        </p>
      </div>
    </div>
  );
}
