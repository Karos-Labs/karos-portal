"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { cn, relativeTime } from "@/lib/utils";
import { dismissAssignedActionItemAction } from "@/lib/actions";
import type { ActionItemNotification, AgentReviewNotification } from "@/lib/types";

interface Props {
  actionItems: ActionItemNotification[];
  reviewJobs: AgentReviewNotification[];
}

export function NotificationBell({ actionItems, reviewJobs }: Props) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visibleActions = actionItems.filter(
    (n) => !dismissed.has(`task-${n.transcriptId}-${n.itemIndex}`),
  );
  const visibleJobs = reviewJobs.filter((j) => !dismissed.has(`job-${j.jobId}`));
  const total = visibleActions.length + visibleJobs.length;

  function dismissTask(transcriptId: string, itemIndex: number) {
    const key = `task-${transcriptId}-${itemIndex}`;
    setDismissed((prev) => new Set([...prev, key]));
    startTransition(async () => {
      try {
        await dismissAssignedActionItemAction(transcriptId, itemIndex);
      } catch {
        // Non-fatal — item disappears from the bell regardless; meeting page will re-sync on next load
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
            <div className="max-h-[420px] overflow-y-auto">
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
                  {/* Action item notifications */}
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
                        onClick={() => dismissTask(n.transcriptId, n.itemIndex)}
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

                  {/* Agent review notifications */}
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
                </div>
              )}
            </div>

            {/* Footer */}
            {total > 0 && (
              <div className="border-t border-border px-4 py-2.5">
                <Link
                  href="/transcripts"
                  onClick={() => setOpen(false)}
                  className="text-[11px] text-muted-2 transition-colors hover:text-neon"
                >
                  View all meetings →
                </Link>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
