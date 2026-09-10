import "server-only";

import { getCustomAgent } from "@/lib/data";
import { getClientAgentByKey } from "@/lib/data-client-agents";
import { umbrellaRunBlock } from "@/lib/client-agent-runs";
import { resolveTaskCustomAgentId } from "@/lib/task-agent-link";
import type { AppUser, ClientAgent, ClientTask } from "@/lib/types";

/**
 * The server half of the §2 guard rail: a CLIENT may not fire, or re-schedule,
 * an agent whose umbrella is not live yet.
 *
 * Why this exists as its own module rather than inside the actions it guards:
 * two different actions (`runCustomAgentAction`, the schedule configuration)
 * and one new one (the per-template run) all have to refuse on exactly the same
 * condition with exactly the same words, and the pure predicate they share
 * (client-agent-runs.ts) cannot reach Firestore. This is the one place that
 * resolves "which umbrella owns this agent for this client".
 *
 * The lookup goes through the agent's KEY, not its doc id: `agentKey` is stable
 * across lab re-imports while `customAgentId` is not, so an umbrella bound
 * before a re-import must still be found afterwards — otherwise the guard would
 * silently stop guarding on exactly the day the agent library was refreshed.
 */

/** Umbrella for (client, custom agent), resolved by the stable agent key. */
export async function resolveUmbrellaForAgent(
  clientId: string,
  customAgentId: string,
): Promise<ClientAgent | null> {
  const agent = await getCustomAgent(customAgentId);
  if (!agent) return null;
  return getClientAgentByKey(clientId, agent.key);
}

/**
 * The refusal a client-initiated run or schedule change gets while the bound
 * umbrella is not live, or null when the request may proceed.
 *
 * Staff pass through unconditionally: they fire the setup run, curate its
 * output and press "Go live", and they keep the generic Run and Schedule
 * controls for the whole of that. Blocking them would remove the only path an
 * umbrella has to becoming live.
 */
export async function clientAgentRunRefusal(input: {
  user: Pick<AppUser, "role">;
  clientId: string;
  customAgentId: string;
}): Promise<string | null> {
  if (input.user.role !== "CLIENT_USER") return null;
  const umbrella = await resolveUmbrellaForAgent(input.clientId, input.customAgentId);
  if (!umbrella) return null;
  return umbrellaRunBlock(umbrella.launchState)?.reason ?? null;
}

/**
 * The same refusal for a run that reaches the agent through the TASK BOARD or
 * the copilot instead of the agent card (D1).
 *
 * Why this needs to exist separately. The task engine dispatches every run it
 * makes as TASK_ENGINE_ACTOR — a synthetic KAROS_ADMIN with no client behind it
 * — because the job it stamps has no user in scope by the time it fires. Read
 * naively, that actor walks straight through `clientAgentRunRefusal`: it is
 * staff, and staff pass. But the actor doing the DISPATCHING is not the actor
 * being BILLED. The client whose card the task sits on is charged for that run
 * (chargeClientCredits fires against the session user, before the engine is
 * ever called), so a client could run a not-yet-live agent — and pay for it —
 * simply by dragging its task on the board instead of pressing the button the
 * guard was written to cover.
 *
 * Hence the rule this module now enforces everywhere: the guard keys on the
 * BILLED actor. Every call site passes the real session user, never the
 * dispatcher, and every call site evaluates it BEFORE the charge — a refusal
 * after the debit would be a charge with no run behind it.
 *
 * Tasks with no custom agent linked (managed products, in-process work) have no
 * umbrella and are never blocked.
 */
export async function clientTaskRunRefusal(input: {
  user: Pick<AppUser, "role">;
  clientId: string;
  task: Pick<ClientTask, "metadata">;
}): Promise<string | null> {
  const customAgentId = resolveTaskCustomAgentId(input.task);
  if (!customAgentId) return null;
  return clientAgentRunRefusal({
    user: input.user,
    clientId: input.clientId,
    customAgentId,
  });
}
