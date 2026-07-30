import { getCurrentUser } from "@/lib/auth";
import { listClientAgents } from "@/lib/data-client-agents";
import { listCustomAgents } from "@/lib/data";
import { getClientCustomAgents } from "@/lib/agent-roster";

export const maxDuration = 10;

/**
 * The Copilot `@mention` list — every agent this client actually has, not
 * only the ones that finished a full launch.
 *
 * Originally scoped to LIVE umbrellas only, on the theory that a
 * launching/curating/not-yet-launched umbrella has no settled persona to
 * focus on yet. In practice that left the dropdown empty for most clients:
 * "live" is the END of the launch pipeline, and a client's assigned custom
 * agents (`getClientCustomAgents` — the same roster `run_agent_now` already
 * matches against, unfiltered by launch state) are what a client actually
 * means by "one of the agents we have" long before any of them are live.
 *
 * So this is the UNION of both, deduplicated by the underlying custom agent
 * — a live umbrella's richer identity (its own display name, matched to a
 * live persona with templates/feedback) wins over the bare catalog entry for
 * the same agent; an agent with no umbrella yet still gets a synthetic id
 * chat/route.ts's focus resolver recognizes as a bare custom-agent id (see
 * the comment there — the two id spaces never collide, so no prefix needed).
 *
 * A separate route rather than folding this into the chat route's own
 * response: the mention list is needed BEFORE the first message is sent (as
 * the client types `@`), so it has to be fetched independently of a chat turn.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const [umbrellas, customAgents, catalogAgents] = await Promise.all([
    listClientAgents({ clientId }),
    listCustomAgents(),
    getClientCustomAgents(clientId),
  ]);
  const iconByAgentId = new Map(customAgents.map((a) => [a.id, a.icon]));
  const liveUmbrellaByCustomAgentId = new Map(
    umbrellas.filter((u) => u.launchState === "live").map((u) => [u.customAgentId, u]),
  );

  const agents = catalogAgents.map((agent) => {
    const umbrella = liveUmbrellaByCustomAgentId.get(agent.id);
    return {
      id: umbrella?.id ?? agent.id,
      displayName: umbrella?.displayName ?? agent.name,
      icon: iconByAgentId.get(agent.id) ?? "Bot",
      platform: umbrella?.platform || null,
    };
  });

  return Response.json({ agents });
}
