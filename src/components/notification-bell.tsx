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
  taskAlertRows,
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
  // NO row for a client, one per job for staff (A3/A4 and round 6 — see
  // notification-rows.ts for the whole argument).
  const reviewRows = reviewFeedRows(reviewJobs, { viewerIsClient });

  // Task alerts: review_pending tasks are surfaced first (need immediate
  // attention), then pending tasks. No local dismissal - they disappear when
  // status changes.
  //
  // ONE ROW PER TASK FOR STAFF, AND NONE AT ALL FOR A CLIENT — the grain is
  // decided in notification-rows.ts (round 6), beside the review queue's,
  // because the count in the badge has to be built from the same answer the
  // panel renders.
  const taskRows = taskAlertRows(taskAlerts, { viewerIsClient });
  const reviewPendingRows = taskRows.filter((r) => r.task.status === "review_pending");
  const pendingRows = taskRows.filter((r) => r.task.status === "pending");

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
  // an aggregate view of TASKS, so task alerts earn no footer link — and since
  // round 6 a client has no task rows here at all. A staff review queue still
  // has a real aggregate destination: /jobs, the staff-only dashboard these
  // AgentReviewNotification rows are drawn from. A client has no review rows
  // and no /jobs to be offered (viewerIsClient excludes it here, same as
  // jobDeepLinks above).
  const showJobsLink = reviewRows.length > 0 && !viewerIsClient;
  // ONE ROUTE TO MEETINGS FOR A CLIENT, NOT THREE (flow audit 2026-09, R11 ·
  // F14). `/transcripts` had three inconsistent reachability states for a
  // client: no rail row by ruling, individual meeting rows in Account Center's
  // Settings tab, and THIS footer — which appeared only when the client
  // happened to have an assigned action item, so the same client saw the route
  // exist and then not exist from one week to the next. The rows above it still
  // open the meeting they name (`/transcripts/{id}`), which is the destination
  // those rows are actually about; the aggregate list belongs to Account
  // Center's Meetings section, which is where the "see all" control is going.
  // Staff keep it — their shell's own nav lists Meetings, so the footer agrees
  // with the nav around it.
  const showMeetingsLink = visibleActions.length > 0 && !viewerIsClient;

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
            // round 6 (rule 3): the rail register had no focus treatment at all,
            // so the one keyboard route to the notification panel was invisible.
            "focus-ring",
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
            "text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-foreground",
            // round 6 (rule 3): was `focus-visible:outline-none` plus an orange
            // ring, which is the bug the rule names by construction — the
            // portal has ONE focus treatment, and orange is not a status or a
            // focus colour. `transition-all` went with it: the hover is a fill.
            "focus-ring",
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
            {/* Header. ONE NUMBER, AND IT IS THE BADGE'S (round 6): the "N
                unread" chip that used to sit here was a second number beside
                the badge that had just been pressed to open this panel, and it
                was static — a count wearing the shell of a control. Think-home
                §3.2 replaces it with a quiet "Mark all as read", but that
                control needs a persisted seen-marker (`notificationsSeenAt`)
                and no such field exists; adding one is the deferred phase-2
                feed, not this round. So the chip is gone rather than replaced
                by a control that could not honour itself, and nothing but the
                heading sits here. */}
            <div className="flex shrink-0 items-center border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
            </div>

            {/* Feed */}
            <div className="min-h-0 flex-1 max-h-[480px] overflow-y-auto">
              {total === 0 ? (
                /* NOT A DEAD END (round 6, B6f). "All caught up!" with a second
                   line about tasks and reviews described feeds a client no
                   longer has, and offered nothing to do next. The sentence says
                   what is true of the reader, and the one control goes where
                   the reader's own work actually is. Client only: /calendar is
                   the client route, and a staff member's calendar is per client
                   — their footer links below are their aggregate destinations. */
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                    <Icon name="CircleCheck" className="h-6 w-6 text-success" />
                  </div>
                  <p className="text-sm font-medium text-foreground">Nothing needs you right now.</p>
                  {viewerIsClient && (
                    <Link
                      href="/calendar"
                      onClick={closeAfterNavigate}
                      className="focus-ring rounded-[4px] text-xs text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    >
                      Open your calendar
                    </Link>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-border">

                  {/* ── Review-pending tasks (highest priority) ──
                      STAFF ONLY, feed and caption both: `taskAlertRows` returns
                      nothing for a client (round 6), so these two blocks and
                      their group headings render for the reader whose own queue
                      they are. */}
                  {reviewPendingRows.length > 0 && (
                    <>
                      <div className="bg-warning/5 px-4 py-1.5">
                        <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-warning">
                          Ready for review ({reviewPendingRows.length})
                        </p>
                      </div>
                      {reviewPendingRows.map((row) => (
                        <TaskAlertRow key={row.task.id} task={row.task} now={now} />
                      ))}
                    </>
                  )}

                  {/* ── Pending tasks ── */}
                  {pendingRows.length > 0 && (
                    <>
                      <div className="bg-surface-2 px-4 py-1.5">
                        <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted">
                          Pending tasks ({pendingRows.length})
                        </p>
                      </div>
                      {pendingRows.map((row) => (
                        <TaskAlertRow key={row.task.id} task={row.task} now={now} />
                      ))}
                    </>
                  )}

                  {/* ── Agent review jobs ──
                      One row per job for staff and none for a client — the
                      grain is decided in notification-rows.ts, not here. */}
                  {reviewRows.map((row) => (
                    <ReviewJobRow
                      key={row.job.jobId}
                      job={row.job}
                      now={now}
                      viewerIsClient={viewerIsClient}
                      deepLink={jobDeepLinks}
                      onNavigate={closeAfterNavigate}
                    />
                  ))}

                  {/* ── Transcript action items ──
                      THE WHOLE ROW IS THE LINK (round 6, rule 1). It used to
                      hover as one surface while only the 11px meeting title
                      inside it was clickable, and the row's one control was an
                      X whose tooltip said "Mark complete" — a destructive glyph
                      for a completion. Now: the row opens the meeting it is
                      about and ends in one static `ChevronRight`, and finishing
                      the item is a named control in the right slot, outside the
                      link (an interactive element inside an <a> is invalid
                      markup, so the two sit side by side rather than nested). */}
                  {visibleActions.map((n) => (
                    <div
                      key={`${n.transcriptId}-${n.itemIndex}`}
                      className={cn(
                        "flex items-start gap-1",
                        n.meetingDate != null && now - n.meetingDate > STALE_MS && "opacity-60",
                      )}
                    >
                      <Link
                        href={`/transcripts/${n.transcriptId}`}
                        onClick={closeAfterNavigate}
                        className="focus-ring flex min-w-0 flex-1 gap-3 px-4 py-3 transition-colors hover:bg-surface-2"
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
                          <p className="mt-0.5 text-[11px] text-muted-2">
                            {n.transcriptTitle}
                            {n.meetingDate ? ` · ${relativeTime(n.meetingDate)}` : ""}
                          </p>
                        </div>
                        <Icon
                          name="ChevronRight"
                          className="mt-0.5 h-4 w-4 shrink-0 text-muted-2"
                          aria-hidden="true"
                        />
                      </Link>
                      <button
                        onClick={() => dismissals.dismiss(n.transcriptId, n.itemIndex)}
                        className="focus-ring mr-2 mt-3 shrink-0 rounded-[6px] px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-3 hover:text-foreground"
                      >
                        Done
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
 * A REAL CLIENT NO LONGER REACHES THIS ROW AT ALL: `reviewFeedRows` returns
 * nothing for them (#118 collapsed the queue to one stampless line because a
 * per-job list of any length publishes the generation batch; round 6 removed
 * the line too, because it led nowhere). The `viewerIsClient` branch below
 * stays anyway, and stays fail-closed rather than dead: the prop is still
 * threaded from every mount, and a caller that ever hands this row a client
 * again must get the client's words, not a request for a sign-off the server
 * refuses.
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
 * ReviewJobRow's client branch above (F97 × F149): it used to open the
 * Workspace board on the tab holding the task (QA F64's fix), and the board is
 * gone entirely (2026-08). No screen replaced it — this row's data still
 * surfaces on Home as an AttentionRow count, which carries the same "no
 * destination" ruling for the identical reason (see client-home-overview.tsx).
 * No arrow, no hover affordance: it must not promise a click it cannot honour.
 *
 * STAFF ONLY since round 6: `taskAlertRows` returns nothing for a client, whose
 * bell may hold no inert row at all. It survives because for the reader whose
 * own queue this is, a status line beside their per-job review rows is the
 * forensic detail they work from.
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
