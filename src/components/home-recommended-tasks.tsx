"use client";

import { Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { HomeTaskRow } from "@/components/home-task-row";
import { useSuggestionActions } from "@/components/pending-task-suggestions";
import { platformLabel } from "@/lib/integrations/platforms";

/**
 * One recommended task, already resolved server-side. A PLAIN, SERIALIZABLE
 * shape on purpose: this crosses the Flight boundary from the client Home page,
 * which cannot pass a function or a `ClientTask` method — `href` in particular
 * is computed on the server (the agent link needs `resolveTaskCustomAgentId`)
 * rather than rebuilt here.
 */
export interface RecommendedTaskRow {
  id: string;
  title: string;
  description?: string;
  /** The agent or managed product that would run it — `metadata.agentName` first. */
  executorLabel: string;
  platform?: string;
  /** Where "Let's do this" goes: the agent's page, carrying `?task=<id>`. */
  href: string;
}

/**
 * Home's "Recommended tasks" — the fixed set the onboarding swarm proposed
 * (ClientTask, owner `karos_managed`, source `copilot`, status `pending`).
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09, product owner's ruling verbatim: "I want
 * the tasks to show here on Home, and users to be able to X them if they don't
 * want them, or click a button that brings them to where they have to fill in
 * the inputs needed to kick off the task. It shouldn't be linked to the
 * calendar."
 *
 * So, deliberately, this widget has:
 *  - NO "Generate more". The set is decided once at onboarding; a button that
 *    manufactures more of them is the opposite of a set number of tasks. (The
 *    Task Map generator still exists and still has its control on the Calendar
 *    page — it is gone from HOME, not from the product.)
 *  - NO Approve. Approving used to DISPATCH the run straight from a list, with
 *    nowhere to say what the run should be about. "Let's do this" navigates to
 *    the agent's own page instead, where the inputs are, and the run starts
 *    from there (client-agents/task-kickoff-strip.tsx).
 *  - NO calendar language anywhere, and no dependence on a calendar date. The
 *    old banner said "Review on your calendar" and the calendar itself only
 *    rendered a suggestion on the day it inferred for it, so a client whose
 *    calendar was busy saw one task where nine were waiting.
 *
 * `skip` is the SAME `useSuggestionActions` the calendar's own review cards
 * use — one X removes the proposal for good, through the one server action
 * that already authorizes it. No new action, no second authorization surface.
 */
export function RecommendedTasksWidget({
  clientId,
  tasks,
}: {
  clientId: string;
  tasks: RecommendedTaskRow[];
}) {
  const { isPending, removedIds, errors, skip } = useSuggestionActions(clientId);
  const visible = tasks.filter((t) => !removedIds.has(t.id));

  // Nothing pending is the steady state for a client who has worked through
  // them — an empty card would be a permanent reminder of a finished job.
  if (visible.length === 0) return null;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle className="min-w-0 truncate">Recommended tasks</CardTitle>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
          {visible.length}
        </span>
      </div>
      <ul className="space-y-2">
        {visible.map((task) => (
          <li key={task.id}>
            <HomeTaskRow
              title={task.title}
              {...(task.description ? { description: task.description } : {})}
              {...(errors[task.id] ? { error: errors[task.id] } : {})}
              busy={isPending}
              meta={
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-muted">
                  <Icon name="Bot" className="h-2.5 w-2.5" />
                  {task.executorLabel}
                  {task.platform ? ` · ${platformLabel(task.platform)}` : ""}
                </span>
              }
              dismiss={{ label: "Not for us", onClick: () => skip(task.id) }}
              start={{ href: task.href }}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
