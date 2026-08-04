import type { ClientTask } from "@/lib/types";

/**
 * An admin took this task out of rotation — most often because the custom
 * agent it dispatches to was turned off, and left running the task would only
 * spend a claim and a charge on a run execution-engine.ts's own `!agent.enabled`
 * branch refunds a moment later. Set and cleared by exactly one action
 * (`setTaskDisabledAction`), so unlike `ranWithoutDeliverable` (task-outcome-copy.ts)
 * this is not a run outcome eight other writers can move underneath it — it is a
 * standing decision that holds until an admin flips it back.
 *
 * Client-safe and pure, the same split `task-outcome-copy.ts` makes: the writer
 * is server-only, but the board card and the ticket modal are both "use client"
 * and need to ask this question too.
 */
export function taskIsDisabled(task: Pick<ClientTask, "metadata">): boolean {
  return task.metadata?.disabled === true;
}

/**
 * Shown on the card and in the ticket to every role once a task is paused —
 * and returned, verbatim, as the refusal every run-trigger door gives if
 * something still tries to run it anyway (drag, re-run, campaign step, bulk
 * "Run Pending Tasks"). One sentence, so the reason on the card can never
 * disagree with the reason a refused action gives.
 */
export const TASK_PAUSED_MESSAGE =
  "This task was paused by your Karos team. It won't run again until they turn it back on.";

/**
 * Shown, unconditionally, when a task's linked agent is currently unavailable
 * but nobody has paused the task yet — the proactive warning an admin acts on
 * before a client's next drag wastes a claim and a charge. Deliberately names
 * no internal mechanism ("disabled", "enabled" flag): a client reads this
 * banner too, on their own board, the same as they already read
 * `executionError` strings there.
 */
export const TASK_AGENT_UNAVAILABLE_MESSAGE =
  "This task's agent is currently unavailable and can't run yet.";
