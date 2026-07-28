import "server-only";

import { getCustomAgent } from "@/lib/data";
import { getClientAgentByKey } from "@/lib/data-client-agents";
import { umbrellaRunBlock } from "@/lib/client-agent-runs";
import type { AppUser, ClientAgent } from "@/lib/types";

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
