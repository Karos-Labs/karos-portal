import type { ClientTask } from "@/lib/types";

/**
 * "This task's run came back with nothing" — the question the board card and the
 * ticket modal ask before writing that sentence.
 *
 * Client-safe and pure: `task-sync.ts` (server-only) writes the state, and two
 * "use client" components read it, so the rule cannot live beside the Firestore
 * writer.
 *
 * ── IT IS NOT "IS THE FLAG SET" ──────────────────────────────────────────────
 * `metadata.noDeliverable` is written by exactly one function and cleared by
 * exactly one function, while the task's execution state is moved by eight
 * others: the claim, the autopilot re-arm, an in-process success, an in-process
 * failure, two dispatch failures, the stuck-execution reconciler and the
 * auto-complete hook. None of them has ever heard of this flag. Asked as "is the
 * flag set", the wording would outlive the run it describes — a client whose
 * nothing-run was retried and then failed for an ordinary reason would still be
 * told nothing came back, which is another lying state on the same card.
 *
 * So the question is whether the task is STILL SITTING in the state that flag
 * described, and every clause is a fact those eight writers already maintain:
 *
 *   - `noDeliverable` — task-sync saw a "done" run with nothing on it;
 *   - status `pending` — it has not been re-run, approved or auto-completed;
 *   - not `executing` — a retry is not in flight right now;
 *   - no `executionError` — nothing has since failed for a different reason.
 *     Read for truthiness only: that field can hold the agent service's own
 *     words, and no client surface may render it (client-copy-boundary.test.ts
 *     pins that classification, and this file must not be what breaks it).
 *
 * Any one of those moving turns the sentence off with no cooperation from
 * whoever moved it.
 */
export function ranWithoutDeliverable(
  task: Pick<ClientTask, "status" | "metadata">,
): boolean {
  const metadata = task.metadata;
  if (metadata?.noDeliverable !== true) return false;
  if (task.status !== "pending") return false;
  if (metadata.executing === true) return false;
  return !metadata.executionError;
}
