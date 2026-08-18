"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { updateTaskStatusAction, deleteTaskAction } from "@/lib/actions";
import { taskPriorityLabel } from "@/lib/task-status-copy";
import { platformLabel } from "@/lib/integrations/platforms";
import type { TaskPriority } from "@/lib/types";

const PRIORITY_TONE: Record<TaskPriority, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

/**
 * How many proposals render before the list has to be asked for.
 *
 * The Task Map can propose a dozen at once, and the collapsed card sat above
 * the calendar itself — so a full sweep pushed the thing the page is FOR below
 * the fold. Three is the same ceiling Home's Next Actions widget uses
 * (home-action-list.tsx), deliberately: two surfaces that both mean "the top of
 * a queue you can open" should cut it at the same number.
 */
const COLLAPSED_COUNT = 3;

/** Highest priority first, so the three that survive the cut are the three that matter. */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

export interface SuggestedTaskView {
  id: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  /** Which agent/product would run this — already resolved server-side from metadata. */
  executorLabel: string;
  platform?: string;
}

/**
 * The Task Map's `pending` proposals (karos_managed, source "copilot") shown
 * right on the calendar instead of only on the Workspace board — a compact
 * approve/skip list, not the full ticket view (`TaskTicketModal`): these are
 * still `pending`, so none of that modal's review/comments/AI-plan machinery
 * applies yet. Approve and Skip are the SAME `updateTaskStatusAction` /
 * `deleteTaskAction` the board's own cards use — no new action, no new
 * authorization surface.
 *
 * Approving dispatches the run immediately (execution-engine.ts), which
 * creates a `Job`; that job then shows up on the calendar on its own as an
 * in-flight run card (queued/running are already client-visible past-run
 * states, lib/calendar-past-runs.ts) — nothing here has to "slot" it there.
 */
export function PendingTaskSuggestions({
  clientId,
  tasks,
}: {
  clientId: string;
  tasks: SuggestedTaskView[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);

  const visible = tasks
    .filter((t) => !removedIds.has(t.id))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  // Collapsing back below the cut with a row still open would strand it
  // off-screen mid-decision, so the toggle only ever changes the SLICE.
  const shown = expanded ? visible : visible.slice(0, COLLAPSED_COUNT);
  const hiddenCount = visible.length - shown.length;
  if (visible.length === 0) return null;

  function approve(taskId: string) {
    setErrors((prev) => ({ ...prev, [taskId]: "" }));
    startTransition(async () => {
      const res = await updateTaskStatusAction(taskId, "in_progress", clientId);
      if (res.ok) {
        setRemovedIds((prev) => new Set(prev).add(taskId));
        router.refresh();
      } else {
        setErrors((prev) => ({ ...prev, [taskId]: res.error ?? "Could not start this task." }));
      }
    });
  }

  function skip(taskId: string) {
    setErrors((prev) => ({ ...prev, [taskId]: "" }));
    startTransition(async () => {
      const res = await deleteTaskAction(taskId, clientId);
      if (res.ok) {
        setRemovedIds((prev) => new Set(prev).add(taskId));
      } else {
        setErrors((prev) => ({ ...prev, [taskId]: res.error ?? "Could not skip this task." }));
      }
    });
  }

  return (
    <Card className="mb-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>Recommended tasks</CardTitle>
          <span className="rounded-full border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-2">
            {visible.length}
          </span>
        </div>
        {visible.length > COLLAPSED_COUNT && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2 transition-colors hover:text-foreground"
          >
            {expanded ? "Show less" : `Show all ${visible.length}`}
            <Icon
              name="ChevronDown"
              className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>
      <p className="mb-3 text-sm text-muted-2">
        Proposed by your Task Map from your current calendar gaps. Approve one to run it now, or
        skip it if it&apos;s not a fit.
      </p>
      <ul className="space-y-2">
        {shown.map((t) => (
          <li key={t.id} className="rounded-md border border-border bg-surface-2 px-3.5 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={PRIORITY_TONE[t.priority]}>{taskPriorityLabel(t.priority)}</Badge>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-muted">
                    <Icon name="Bot" className="h-2.5 w-2.5" />
                    {t.executorLabel}
                    {t.platform ? ` · ${platformLabel(t.platform)}` : ""}
                  </span>
                </div>
                <p className="text-sm font-medium text-foreground">{t.title}</p>
                {t.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-2">{t.description}</p>
                )}
                {errors[t.id] && <p className="mt-1 text-xs text-danger">{errors[t.id]}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => skip(t.id)}
                  disabled={isPending}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={() => approve(t.id)}
                  disabled={isPending}
                  className="flex items-center gap-1.5 rounded-md bg-neon px-3 py-1.5 text-xs font-semibold text-accent-ink transition-opacity disabled:opacity-50"
                >
                  <Icon name="Play" className="h-3 w-3" />
                  Approve
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 w-full rounded-md border border-dashed border-border py-2 text-xs font-medium text-muted-2 transition-colors hover:border-border-strong hover:text-foreground"
        >
          Show {hiddenCount} more suggestion{hiddenCount === 1 ? "" : "s"}
        </button>
      )}
    </Card>
  );
}
