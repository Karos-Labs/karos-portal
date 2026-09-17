/**
 * Resolving `?task=<id>` on an agent surface into the kickoff strip's view
 * (components/client-agents/task-kickoff-strip.tsx).
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09. Home's recommended-task press deep-links to the
 * agent page carrying the task id, and THREE surfaces have to answer that link
 * the same way: the agent detail page, and both branches of the agent roster.
 * The interesting part is not the fetch — it is the two rules that must not be
 * re-stated per call site:
 *
 *  1. WHAT COUNTS. Only a `pending` / `karos_managed` / `copilot` task OF THIS
 *     CLIENT is a recommendation (lib/recommended-tasks.ts). Anything else in
 *     `?task=` — another client's id, a task already started, a client-owned
 *     to-do — resolves to null and the strip simply does not mount. A query
 *     parameter is user input, and this is the one place that judges it.
 *  2. WHERE IT LANDS. The `targetDate` handed to `updateTaskStatusAction` is
 *     the SAME inferred placement the calendar computes for the same task
 *     (lib/calendar-suggestion-placement.ts, exactly as calendar-body.tsx calls
 *     it), so starting a task from an agent page and approving it from the
 *     calendar put the run on the same day.
 *
 * The pure half of this — the predicate and the two label readers — lives in
 * lib/recommended-tasks.ts, because this module imports the `server-only` data
 * layer and nothing importable by a client component or a unit test may.
 */

import { getClientTask } from "@/lib/data";
import { inferSuggestionDates } from "@/lib/calendar-suggestion-placement";
import { isRecommendedTask, taskExecutorLabel, taskPlatform } from "@/lib/recommended-tasks";
import type { TaskKickoffView } from "@/components/client-agents/task-kickoff-strip";

/**
 * `scheduledAt` is the client's already-booked calendar (asset scheduled
 * times), fed to the placement algorithm so the inferred day dodges days that
 * are already full — the caller passes the assets it has already read rather
 * than this module opening a second unbounded asset query.
 */
export async function buildTaskKickoffView(opts: {
  clientId: string;
  taskId?: string | undefined;
  scheduledAt: readonly number[];
  now: number;
}): Promise<TaskKickoffView | null> {
  if (!opts.taskId) return null;
  const task = await getClientTask(opts.taskId);
  if (!task || task.clientId !== opts.clientId || !isRecommendedTask(task)) return null;

  const platform = taskPlatform(task);
  const dates = inferSuggestionDates(
    [{ id: task.id, ...(platform ? { platform } : {}), priority: task.priority }],
    opts.scheduledAt,
    opts.now,
  );
  const targetDate = dates.get(task.id);

  return {
    id: task.id,
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    executorLabel: taskExecutorLabel(task),
    ...(platform ? { platform } : {}),
    ...(targetDate !== undefined ? { targetDate } : {}),
  };
}
