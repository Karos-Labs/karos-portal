"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { updateTaskStatusAction, deleteTaskAction } from "@/lib/actions";
import { platformLabel } from "@/lib/integrations/platforms";

/**
 * One recommended task, resolved server-side by lib/task-kickoff.ts. Plain and
 * serializable — it crosses the Flight boundary from a server page.
 */
export interface TaskKickoffView {
  id: string;
  title: string;
  description?: string;
  executorLabel: string;
  platform?: string;
  /**
   * The suggestion's inferred calendar placement
   * (lib/calendar-suggestion-placement.ts), computed fresh on the server the
   * same way calendar-body.tsx computes it. Threaded through to
   * `updateTaskStatusAction` so a task started HERE lands on exactly the day it
   * would have landed on had it been approved from the calendar — one dispatch
   * path, one placement rule.
   */
  targetDate?: number;
}

/**
 * The kickoff surface for a recommended task — mounted at the top of the main
 * column of an agent's page (and of the agent roster, when the task names no
 * particular agent) whenever `?task=<id>` names a pending karos_managed/copilot
 * task of this client.
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09. Home's "Let's do this" no longer starts a
 * run: it brings the client "to the page where they put in the input needed"
 * (product owner, verbatim). That landing needs to say WHY the client is here
 * and carry the start gesture, or the deep link drops them on a generic agent
 * page with no memory of what they clicked. Hence a strip rather than a modal:
 * the inputs it points at are the rest of the page, right underneath.
 *
 * Starting is the SAME `updateTaskStatusAction(id, "in_progress", clientId,
 * targetDate)` the calendar's Approve fires — the dispatch path is unchanged,
 * only the place a person presses it. "Not for us" is the same `deleteTaskAction`
 * as the X on Home. "Later" is pure client state: it hides the strip for this
 * visit and decides nothing, so a client who wants to look around first is not
 * forced to answer.
 *
 * Renders identically for staff and clients (parity pass, 2026-09) — a task is
 * the client's work either way, and both actions already authorize both roles.
 */
export function TaskKickoffStrip({
  clientId,
  task,
}: {
  clientId: string;
  task: TaskKickoffView;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "started" | "gone">("idle");
  const [error, setError] = useState("");

  if (state === "gone") return null;

  function start() {
    setError("");
    startTransition(async () => {
      const res = await updateTaskStatusAction(task.id, "in_progress", clientId, task.targetDate);
      if (res.ok) {
        setState("started");
        router.refresh();
      } else {
        setError(res.error ?? "Could not start this task.");
      }
    });
  }

  function skip() {
    setError("");
    startTransition(async () => {
      const res = await deleteTaskAction(task.id, clientId);
      if (res.ok) setState("gone");
      else setError(res.error ?? "Could not remove this task.");
    });
  }

  if (state === "started") {
    return (
      <div className="flex items-center gap-2.5 rounded-[var(--radius)] border border-neon/25 bg-neon-soft px-4 py-3 text-sm text-foreground">
        <Icon name="CircleCheck" className="h-4 w-4 shrink-0 text-neon" />
        {/* A period, not an em dash: client-copy-boundary.test.ts forbids one in
            copy a client's browser renders. */}
        <p className="font-medium">Started. It will appear on your calendar.</p>
      </div>
    );
  }

  return (
    <section className="rounded-[var(--radius)] border border-neon/25 bg-neon-soft px-4 py-3.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
        Recommended task
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-muted">
          <Icon name="Bot" className="h-2.5 w-2.5" />
          {task.executorLabel}
          {task.platform ? ` · ${platformLabel(task.platform)}` : ""}
        </span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-foreground">{task.title}</p>
      {task.description && <p className="mt-0.5 text-xs text-muted-2">{task.description}</p>}
      <p className="mt-1.5 text-xs text-muted">Add any context below first, then start it.</p>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={start}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-neon px-3 py-1.5 text-xs font-semibold text-accent-ink transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-10px_color-mix(in_srgb,var(--neon)_55%,transparent)] disabled:pointer-events-none disabled:opacity-50"
        >
          <Icon name="Play" className="h-3 w-3" />
          Start this task
        </button>
        <button
          type="button"
          onClick={skip}
          disabled={isPending}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
        >
          Not for us
        </button>
        <button
          type="button"
          onClick={() => setState("gone")}
          disabled={isPending}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-2 transition-colors hover:text-foreground disabled:opacity-40"
        >
          Later
        </button>
      </div>
    </section>
  );
}
