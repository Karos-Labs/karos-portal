"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { cn, relativeTime } from "@/lib/utils";
import { dismissAssignedActionItemAction } from "@/lib/actions";
import type { ActionItemNotification, AgentReviewNotification, ClientTask, TaskOwner } from "@/lib/types";

/* ── Priority colours for task alerts ───────────────────────────── */

const PRIORITY_COLOR: Record<string, string> = {
  high:   "#e5484d",
  medium: "#d9a13d",
  low:    "#9c9ca3",
};

/**
 * Anything older than this is still shown — dropping work silently is worse
 * than showing it — but visually stepped back, so a 19-day-old row stops
 * reading as something that just happened (QA F143).
 */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface Props {
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  /**
   * Pending + review_pending tasks — server-fetched, refreshed via
   * router.refresh(). Staff feeds are cross-client and carry `_clientName`.
   */
  taskAlerts: (ClientTask & { _clientName?: string })[];
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
   * True when the bell is rendered in the client shell. Review rows then become
   * non-navigable status lines: /jobs/[id] is staff-only and bounces a client
   * back to their dashboard (QA F51), and the archive — the destination that
   * replaced it — provably excludes the drafts these rows count. It ALSO
   * rewrites the row's status line to client-facing copy, which is why the
   * link behaviour has its own prop below.
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
}: Props) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visibleActions = actionItems.filter(
    (n) => !dismissed.has(`action-${n.transcriptId}-${n.itemIndex}`),
  );
  // Review rows have no dismiss control: the X used to write nothing but local
  // state, so the row (and the count) came back on the next page load — a badge
  // that lies (QA F121). listReviewJobs queries status == "review", so the row
  // clears by itself the moment the job is approved, exactly like the task rows.
  const visibleJobs = reviewJobs;

  // Task alerts: review_pending tasks are surfaced first (need immediate attention),
  // then pending tasks. No local dismissal — they disappear when status changes.
  const reviewPendingTasks = taskAlerts.filter((t) => t.status === "review_pending");
  const pendingTasks = taskAlerts.filter((t) => t.status === "pending");

  const total = visibleActions.length + visibleJobs.length + taskAlerts.length;

  // A client never gets the job link back, whatever a caller passes: /jobs is
  // staff-only, so the flag that describes the viewer wins over the flag that
  // describes the shell.
  const jobDeepLinks = allowJobDeepLinks && !viewerIsClient;

  // CD-H7b: one number, one noun. The badge clamped at "9+" while the panel
  // header read "32 active" — the same set, described two ways, so opening the
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

  function dismissTranscriptItem(transcriptId: string, itemIndex: number) {
    const key = `action-${transcriptId}-${itemIndex}`;
    setDismissed((prev) => new Set([...prev, key]));
    startTransition(async () => {
      try {
        await dismissAssignedActionItemAction(transcriptId, itemIndex);
      } catch {
        // Non-fatal
      }
    });
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
              // than truncating the panel — the header and footer stay put and
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
                        <TaskAlertRow key={t.id} task={t} now={now} onClose={closeAfterNavigate} />
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
                        <TaskAlertRow key={t.id} task={t} now={now} onClose={closeAfterNavigate} />
                      ))}
                    </>
                  )}

                  {/* ── Agent review jobs ── */}
                  {visibleJobs.map((j) => (
                    <ReviewJobRow
                      key={j.jobId}
                      job={j}
                      now={now}
                      viewerIsClient={viewerIsClient}
                      deepLink={jobDeepLinks}
                      onNavigate={closeAfterNavigate}
                    />
                  ))}

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
                        onClick={() => dismissTranscriptItem(n.transcriptId, n.itemIndex)}
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

            {/* Footer — one link per KIND of row actually in the feed. A panel
                of meeting action items used to be footed "View workspace →"
                and vice versa (QA F143). */}
            {total > 0 && (
              <div className="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2.5">
                {(taskAlerts.length > 0 || visibleJobs.length > 0) && (
                  <Link
                    href="/tasks"
                    onClick={closeAfterNavigate}
                    className="text-[11px] text-muted-2 transition-colors hover:text-foreground"
                  >
                    View workspace →
                  </Link>
                )}
                {visibleActions.length > 0 && (
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
 * deliverables in review"), and the same treatment. The copy follows: approval
 * is staff-only (approveAssetAction calls requireStaff), so "Waiting for your
 * review" was asking the client for a sign-off the server would refuse.
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

function TaskAlertRow({
  task,
  now,
  onClose,
}: {
  task: ClientTask & { _clientName?: string };
  now: number;
  onClose: () => void;
}) {
  const isReview = task.status === "review_pending";
  const prioColor = PRIORITY_COLOR[task.priority] ?? PRIORITY_COLOR.low;
  // Land on the tab that actually holds this card, and open it. The board used
  // to always open on "Automated", so a click on one of the client's own items
  // showed a tab that did not contain it (QA F64). `owner` is a distinct key —
  // `tab` belongs to the Workspace's board/activity/archive toggle.
  const owner: TaskOwner = task.owner ?? (task.source === "manual" ? "client_managed" : "karos_managed");
  const href = `/tasks?owner=${owner === "client_managed" ? "client" : "karos"}&task=${task.id}`;

  return (
    <Link
      href={href}
      onClick={onClose}
      className={cn(
        "flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2",
        now - task.createdAt > STALE_MS && "opacity-60",
      )}
    >
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: (isReview ? "#FF6B2C" : prioColor) + "1a" }}
      >
        <Icon
          name={isReview ? "Eye" : "Circle"}
          className="h-3.5 w-3.5"
          style={{ color: isReview ? "#FF6B2C" : prioColor }}
        />
      </div>
      <div className="min-w-0 flex-1">
        {/* Subject + verb first, the task's own wording second — a raw task
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
      <Icon name="ArrowRight" className="mt-1 h-3 w-3 shrink-0 text-muted-2" />
    </Link>
  );
}
