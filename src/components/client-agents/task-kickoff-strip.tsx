"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
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
 * PORTAL FEEDBACK ROUND 2, 2026-09. Home's recommended-task press no longer
 * starts a run: it brings the client "to the page where they put in the input needed"
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
      // Judgment scale, not orange (round 6 rule 2): a confirmation is a status,
      // and the page's one rationed accent is the run control.
      <div className="flex items-center gap-2.5 rounded-[var(--radius)] border border-success/30 bg-success/5 px-4 py-3 text-sm text-foreground">
        <Icon name="CircleCheck" className="h-4 w-4 shrink-0 text-success" />
        {/* A period, not an em dash: client-copy-boundary.test.ts forbids one in
            copy a client's browser renders. */}
        <p className="font-medium">Started. It will appear on your calendar.</p>
      </div>
    );
  }

  return (
    // Info tone: this band explains why the reader landed here. Orange stays on
    // the one control that moves them forward, which on this page is the run /
    // setup / launch button below (round 6 rule 2).
    <section className="rounded-[var(--radius)] border border-info/30 bg-info/5 px-4 py-3.5">
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
        {/* PAPER, not orange (round 6, B2). The page's one accent is the run /
            setup / launch control; this is the second-strongest gesture on the
            screen, so it takes the primary ink. The Button primitive also
            brings the shared focus ring and drops the lift-and-bloom hover
            this hand-rolled control had. */}
        <Button size="sm" variant="primary" onClick={start} disabled={isPending}>
          <Icon name="Play" className="h-3 w-3" />
          Start this task
        </Button>
        <button
          type="button"
          onClick={skip}
          disabled={isPending}
          className="focus-ring rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40"
        >
          Not for us
        </button>
        <button
          type="button"
          onClick={() => setState("gone")}
          disabled={isPending}
          className="focus-ring rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-2 transition-colors hover:text-foreground disabled:opacity-40"
        >
          Later
        </button>
      </div>
    </section>
  );
}
