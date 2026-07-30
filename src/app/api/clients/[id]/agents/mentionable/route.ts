import { getCurrentUser } from "@/lib/auth";
import { listClientAgents } from "@/lib/data-client-agents";
import { listCustomAgents } from "@/lib/data";

export const maxDuration = 10;

/**
 * The Copilot `@mention` list — this client's LIVE agent umbrellas only.
 *
 * "Live" on purpose: a launching/curating/not-yet-launched umbrella has no
 * settled persona to focus the chat on yet (its template registry may still
 * be a staff-unconfirmed proposal — see `toClientAgentRows`'s own gate on
 * this), and offering it in an autocomplete would let a client `@mention` an
 * agent that cannot yet answer anything about itself.
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

  const [umbrellas, customAgents] = await Promise.all([
    listClientAgents({ clientId }),
    listCustomAgents(),
  ]);
  const iconByAgentId = new Map(customAgents.map((a) => [a.id, a.icon]));

  const agents = umbrellas
    .filter((u) => u.launchState === "live")
    .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      icon: iconByAgentId.get(u.customAgentId) ?? "Bot",
      platform: u.platform || null,
    }));

  return Response.json({ agents });
}
