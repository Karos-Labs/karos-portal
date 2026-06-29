"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { cn, relativeTime } from "@/lib/utils";
import { dismissAssignedActionItemAction } from "@/lib/actions";
import type { ActionItemNotification, AgentReviewNotification, ClientTask } from "@/lib/types";

/* ── Priority colours for task alerts ───────────────────────────── */

const PRIORITY_COLOR: Record<string, string> = {
  high:   "#ff5d6c",
  medium: "#ffcf5d",
  low:    "#8aa2a8",
};

interface Props {
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
  /** Pending + review_pending client tasks — server-fetched, refreshed via router.refresh(). */
  taskAlerts: ClientTask[];
}

export function NotificationBell({ actionItems, reviewJobs, taskAlerts }: Props) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visibleActions = actionItems.filter(
    (n) => !dismissed.has(`action-${n.transcriptId}-${n.itemIndex}`),
  );
  const visibleJobs = reviewJobs.filter((j) => !dismissed.has(`job-${j.jobId}`));

  // Task alerts: review_pending tasks are surfaced first (need immediate attention),
  // then pending tasks. No local dismissal — they disappear when status changes.
  const reviewPendingTasks = taskAlerts.filter((t) => t.status === "review_pending");
  const pendingTasks = taskAlerts.filter((t) => t.status === "pending");

  const total = visibleActions.length + visibleJobs.length + taskAlerts.length;

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

  function dismissJob(jobId: string) {
    setDismissed((prev) => new Set([...prev, `job-${jobId}`]));
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
          "text-muted transition-all duration-150 hover:bg-surface-2 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40",
          open && "bg-surface-2 text-foreground",
        )}
        aria-label={`Notifications${total > 0 ? ` (${total} unread)` : ""}`}
      >
        <Icon name="Bell" className="h-5 w-5" />
        {total > 0 && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center",
              "rounded-full bg-neon px-1 text-[10px] font-bold neon-glow",
            )}
          >
            {total > 9 ? "9+" : total}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Panel */}
          <div
            className={cn(
              "absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden",
              "rounded-[14px] border border-border glass-surface shadow-2xl",
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
              {total > 0 ? (
                <span className="rounded-full bg-neon/15 px-2 py-0.5 text-[11px] font-semibold text-neon">
                  {total} active
                </span>
              ) : (
                <span className="text-[11px] text-muted-2">All clear</span>
              )}
            </div>

            {/* Feed */}
            <div className="max-h-[480px] overflow-y-auto">
              {total === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neon/10">
                    <Icon name="CheckCircle2" className="h-6 w-6 text-neon" />
                  </div>
                  <p className="text-sm font-medium text-foreground">All caught up!</p>
                  <p className="text-xs text-muted-2">No pending tasks or reviews.</p>
                </div>
              ) : (
                <div className="divide-y divide-border">

                  {/* ── Review-pending tasks (highest priority) ── */}
                  {reviewPendingTasks.length > 0 && (
                    <>
                      <div className="bg-neon/5 px-4 py-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-neon">
                          Ready for review ({reviewPendingTasks.length})
                        </p>
                      </div>
                      {reviewPendingTasks.map((t) => (
                        <TaskAlertRow key={t.id} task={t} onClose={() => setOpen(false)} />
                      ))}
                    </>
                  )}

                  {/* ── Pending tasks ── */}
                  {pendingTasks.length > 0 && (
                    <>
                      <div className="bg-surface-2/60 px-4 py-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                          Pending tasks ({pendingTasks.length})
                        </p>
                      </div>
                      {pendingTasks.map((t) => (
                        <TaskAlertRow key={t.id} task={t} onClose={() => setOpen(false)} />
                      ))}
                    </>
                  )}

                  {/* ── Agent review jobs ── */}
                  {visibleJobs.map((j) => (
                    <div
                      key={j.jobId}
                      className="flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50"
                    >
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-info/10">
                        <Icon name="Sparkles" className="h-3.5 w-3.5 text-info" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-xs font-medium text-foreground">
                          New content ready:{" "}
                          <span className="text-neon">{j.title}</span>
                        </p>
                        <Link
                          href={`/jobs/${j.jobId}`}
                          onClick={() => setOpen(false)}
                          className="mt-0.5 inline-block text-[10px] text-muted-2 hover:text-neon"
                        >
                          {j.agentName} · Pending review · {relativeTime(j.updatedAt)}
                        </Link>
                      </div>
                      <button
                        onClick={() => dismissJob(j.jobId)}
                        className={cn(
                          "mt-0.5 shrink-0 rounded-[6px] p-1 text-muted-2",
                          "transition-colors hover:bg-surface-3 hover:text-foreground",
                        )}
                        aria-label="Dismiss"
                        title="Dismiss"
                      >
                        <Icon name="X" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}

                  {/* ── Transcript action items ── */}
                  {visibleActions.map((n) => (
                    <div
                      key={`${n.transcriptId}-${n.itemIndex}`}
                      className="flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50"
                    >
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neon/10">
                        <Icon name="CheckSquare" className="h-3.5 w-3.5 text-neon" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-xs font-medium text-foreground">{n.text}</p>
                        <Link
                          href={`/transcripts/${n.transcriptId}`}
                          onClick={() => setOpen(false)}
                          className="mt-0.5 inline-block text-[10px] text-muted-2 hover:text-neon"
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

            {/* Footer */}
            {total > 0 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
                {taskAlerts.length > 0 ? (
                  <Link
                    href="/tasks"
                    onClick={() => setOpen(false)}
                    className="text-[11px] text-muted-2 transition-colors hover:text-neon"
                  >
                    View task board →
                  </Link>
                ) : (
                  <Link
                    href="/transcripts"
                    onClick={() => setOpen(false)}
                    className="text-[11px] text-muted-2 transition-colors hover:text-neon"
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

/* ── Task alert row ──────────────────────────────────────────────── */

function TaskAlertRow({ task, onClose }: { task: ClientTask; onClose: () => void }) {
  const isReview = task.status === "review_pending";
  const prioColor = PRIORITY_COLOR[task.priority] ?? PRIORITY_COLOR.low;

  return (
    <Link
      href="/tasks"
      onClick={onClose}
      className="flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50"
    >
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: (isReview ? "#2dff9e" : prioColor) + "1a" }}
      >
        <Icon
          name={isReview ? "Eye" : "Circle"}
          className="h-3.5 w-3.5"
          style={{ color: isReview ? "#2dff9e" : prioColor }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-xs font-medium text-foreground leading-snug">
          {task.title}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-2">
          {isReview ? "Review pending" : "Pending"} · {task.priority} priority · {relativeTime(task.createdAt)}
        </p>
      </div>
      <Icon name="ArrowRight" className="mt-1 h-3 w-3 shrink-0 text-muted-2" />
    </Link>
  );
}
