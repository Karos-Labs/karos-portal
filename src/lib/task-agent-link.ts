/**
 * Which custom agent a task dispatches to — the one fact both the execution
 * engine and the §2 guard rail have to agree on.
 *
 * This lives in its own module for one reason: the guard (client-agent-gate.ts)
 * must resolve the SAME agent the engine will actually dispatch to, and the
 * engine module pulls in the model SDK, the agent-service client and the data
 * layer. Importing all of that into the guard would put a heavy, mock-hostile
 * edge on the import graph of every server action that merely wants to ask
 * "may this actor run this?" — and copying the two lines into the guard instead
 * would let the guard and the dispatcher drift apart, which is the failure mode
 * that produced D1 in the first place (a guard that no longer guards).
 */

import type { ClientTask } from "@/lib/types";

/**
 * The custom agent (git-imported, allowlisted per client) bound to this task,
 * or null. Only an explicit link counts — custom agents are never inferred
 * from title keywords the way managed products are.
 */
export function resolveTaskCustomAgentId(task: Pick<ClientTask, "metadata">): string | null {
  const id = task.metadata?.customAgentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
