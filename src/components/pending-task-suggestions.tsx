"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui";
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

export interface SuggestedTaskView {
  id: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  /** Which agent/product would run this — already resolved server-side from metadata. */
  executorLabel: string;
  platform?: string;
  /**
   * Inferred target date (lib/calendar-suggestion-placement.ts) — computed
   * fresh on every render, never stored on the task. Consumed by
   * run-calendar.tsx's date-anchored "Suggested" placement (grid chip, week
   * day-by-day list, day-detail panel).
   */
  at: number;
}

/**
 * Approve/Skip for a Task-Map suggestion, shared by every surface in
 * run-calendar.tsx that renders one — the grid's week/day views and the
 * day-detail panel. Approve/Skip are the SAME `updateTaskStatusAction` /
 * `deleteTaskAction` the board's own cards used — no new action, no new
 * authorization surface.
 *
 * A STANDALONE "Recommended tasks" card used to mount alongside the calendar
 * grid too, rendering the exact same suggestions a second (and, combined with
 * the grid's own chip-plus-list rendering, a THIRD) time on one page — reported
 * live on a real client's calendar (2026-08) as "shown up 3 times." Removed:
 * the grid is now the one place a suggestion lives, exactly like every other
 * calendar item (a run or post has no separate flat-list twin either).
 *
 * ONE INTERACTIVE ROW EACH, which the sentence above claimed and the grid did
 * not deliver (review wave, 2026-09): in Week, a suggestion drew a chip in the
 * cell, a full row in the day-by-day list AND a third row in the day-detail
 * panel. The panel now defers to that list in Week and keeps its rows only for
 * Month and Day, where nothing else offers them.
 *
 * PENDING IS PER TASK. `useTransition`'s flag is one boolean for the hook, so
 * approving one proposal greyed out Approve and Skip on every other row on the
 * page — including rows for other days — until the action returned. The ids in
 * flight are tracked instead, and a row asks about itself.
 */
export function useSuggestionActions(clientId: string) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const markPending = (taskId: string, pending: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(taskId);
      else next.delete(taskId);
      return next;
    });

  /**
   * `targetDate` is the suggestion's own inferred placement (`task.at`) — the
   * caller always has it in hand (it's on the `SuggestedTaskView` being
   * approved), so it's threaded through here rather than re-inferred, keeping
   * the approved run's calendar date IDENTICAL to whatever date the client
   * actually saw and clicked Approve on.
   */
  function approve(taskId: string, targetDate?: number) {
    setErrors((prev) => ({ ...prev, [taskId]: "" }));
    markPending(taskId, true);
    startTransition(async () => {
      const res = await updateTaskStatusAction(taskId, "in_progress", clientId, targetDate);
      markPending(taskId, false);
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
    markPending(taskId, true);
    startTransition(async () => {
      const res = await deleteTaskAction(taskId, clientId);
      markPending(taskId, false);
      if (res.ok) {
        setRemovedIds((prev) => new Set(prev).add(taskId));
        router.refresh();
      } else {
        setErrors((prev) => ({ ...prev, [taskId]: res.error ?? "Could not skip this task." }));
      }
    });
  }

  return { pendingIds, removedIds, errors, approve, skip };
}

/**
 * One suggestion's interactive card body — extracted so run-calendar.tsx's
 * week/day views and its day-detail panel render an IDENTICAL row rather than
 * copies that can drift apart.
 */
export function SuggestionRow({
  task,
  isPending,
  error,
  onApprove,
  onSkip,
}: {
  task: SuggestedTaskView;
  isPending: boolean;
  error?: string;
  onApprove: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge tone={PRIORITY_TONE[task.priority]}>{taskPriorityLabel(task.priority)}</Badge>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-muted">
            <Icon name="Bot" className="h-2.5 w-2.5" />
            {task.executorLabel}
            {task.platform ? ` · ${platformLabel(task.platform)}` : ""}
          </span>
        </div>
        <p className="text-sm font-medium text-foreground">{task.title}</p>
        {task.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-2">{task.description}</p>
        )}
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onSkip}
          disabled={isPending}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-md bg-neon px-3 py-1.5 text-xs font-semibold text-accent-ink transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-10px_color-mix(in_srgb,var(--neon)_55%,transparent)] disabled:pointer-events-none disabled:opacity-50"
        >
          <Icon name="Play" className="h-3 w-3" />
          Approve
        </button>
      </div>
    </div>
  );
}
