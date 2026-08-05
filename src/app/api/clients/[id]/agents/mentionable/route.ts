import { getCurrentUser } from "@/lib/auth";
import { isInternalAgentIdentity } from "@/lib/custom-agent-launch";
import { listClientAgents } from "@/lib/data-client-agents";
import { getClient, listCustomAgents } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";
import { getClientCustomAgents } from "@/lib/agent-roster";
import { platformForAgentRow } from "@/lib/content-platform";

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

  // STAFF SCOPE. The only role test above was the CLIENT_USER branch, so an
  // employee 404'd on /clients/[id] read any client's agent roster from here —
  // the page fence without the API fence. Same predicate the pages ask, asked
  // UNCONDITIONALLY rather than under `role === "KAROS_EMPLOYEE"`: admins and a
  // client on their own account already pass it, and an unknown role must not.
  //
  // This route had no "client not found" shape of its own — a missing client
  // returned an empty roster — so the refusal takes the shape its six siblings
  // use, and a client that does not exist gets the SAME answer as one this actor
  // may not see. Otherwise the difference between 404 and an empty 200 tells an
  // unassigned employee which client ids are real.
  const client = await getClient(clientId);
  if (!client || !canViewClient(user, client)) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const [umbrellas, customAgents, catalogAgents] = await Promise.all([
    listClientAgents({ clientId }),
    listCustomAgents(),
    getClientCustomAgents(clientId),
  ]);
  // The whole catalog doc, not just its icon: the agent KEY is the precise
  // source for a platform mark ("karos-x-agent-v2" answers exactly, a display
  // name only guesses), and it never leaves this route — see `platform` below.
  const customAgentById = new Map(customAgents.map((a) => [a.id, a]));
  const liveUmbrellaByCustomAgentId = new Map(
    umbrellas.filter((u) => u.launchState === "live").map((u) => [u.customAgentId, u]),
  );

  const agents = catalogAgents
    // A tag the copilot could act on has to name something a person would ask
    // for. The LinkedIn setup and manager are the LinkedIn agent's own steps, so
    // "@LinkedIn Manager, draft me a post" would dispatch a run that never
    // drafts — the same reason a disabled agent is kept off this list.
    .filter((agent) => !isInternalAgentIdentity(customAgentById.get(agent.id)?.key ?? agent.id))
    .map((agent) => {
    const umbrella = liveUmbrellaByCustomAgentId.get(agent.id);
    const custom = customAgentById.get(agent.id);
    const displayName = umbrella?.displayName ?? agent.name;
    return {
      id: umbrella?.id ?? agent.id,
      displayName,
      icon: custom?.icon ?? "Bot",
      // AF-20: the copilot's @-agent tags wear the logo of the platform the
      // agent posts to, so tagging one says what you are about to get.
      //
      // This field already existed and already crossed; what changed is that it
      // was the umbrella's raw stored string, so it was null for every catalog
      // agent nobody has bound an umbrella for yet — which is most of the list
      // this route deliberately widened to include. Resolved through the one
      // resolver now, and still one TOKEN on the wire: the agent key it was
      // read from stays here.
      platform: platformForAgentRow(umbrella?.platform, custom?.key, displayName),
    };
  });

  return Response.json({ agents });
}
