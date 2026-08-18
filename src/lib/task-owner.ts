/**
 * The one rule for who owns a task: an explicit `owner` wins; absent that, a
 * manually-created task is the client's own and everything else is ours.
 *
 * Pure and client-safe (no server-only) on purpose — `execution-engine.ts`
 * (server-only) and `task-dedup.ts` (explicitly client-safe, no Firestore) each
 * used to carry their own copy of this exact expression. `task-dedup.ts` can't
 * import from `execution-engine.ts` without pulling `server-only` into every
 * client bundle that imports it, so the shared rule lives here instead — the
 * one place low enough in the dependency graph for both to import without
 * either compromising its own contract.
 */
import type { ClientTask, TaskOwner } from "@/lib/types";

export function inferTaskOwner(task: Pick<ClientTask, "owner" | "source">): TaskOwner {
  return task.owner ?? (task.source === "manual" ? "client_managed" : "karos_managed");
}
