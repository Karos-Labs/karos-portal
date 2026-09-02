import { agentKeyMatchesClientSlug, isUnlistedAgent } from "@/lib/custom-agent-launch";
import type { RailAgent } from "@/components/client-rail-agents-nav";
import type { Client, CustomAgent } from "@/lib/types";

export type { RailAgent };

/**
 * The roster the "AI agents" rail list renders for one client — asked ONCE,
 * by both shells (parity pass 2026-09).
 *
 * This filter used to live inline in the `(app)` layout, which is the client
 * portal's shell. The staff shell's client-context arm now renders the client's
 * real roster too (ruling D3: "same nav rows … as a real CLIENT_USER sees"),
 * and a second hand-written copy of a five-clause filter is a guarantee the two
 * views of one client eventually disagree about which agents that client has.
 *
 * The clauses, unchanged from the layout they came from:
 *  · GRANTED agents (`client.customAgentIds`), PLUS any agent already starred
 *    even without a grant. The list used to be granted-only, on the
 *    reasoning that an agent that only shows up via delivered work "will appear
 *    here once an admin grants it" — but the agent's own detail page can be
 *    opened, and starred, by EITHER a grant OR delivered work, and a star that
 *    writes successfully but can never render a pinned row is a broken control,
 *    not a scoped one. Karos Labs' own Instagram Agent is the flagship case: it
 *    predates the umbrella/grant model entirely, so it is never in
 *    `customAgentIds` yet is the most-used agent in the portal.
 *  · `enabled` / `isUnlistedAgent` / slug-match stay mandatory regardless of
 *    grant OR star: those are data-integrity fences, not the grant boundary the
 *    star loosens.
 *
 * The projection at the end is the boundary: `RailAgent` is what crosses into a
 * "use client" component, so the agent's internal `description` (lab product
 * codes, pipeline shorthand) never rides along in an RSC payload.
 *
 * NOT included here: the one-time onboarding default-star WRITE the `(app)`
 * layout performs beside this filter. That is a write, this is a read, and the
 * staff shell must not perform it — see the layout's own note and ruling D3's
 * data plan.
 */
export function railAgentsForClient(
  customAgents: CustomAgent[],
  client: Pick<Client, "customAgentIds" | "starredAgentIds" | "agentsRepoSlug">,
): RailAgent[] {
  const allowedAgentIds = new Set(client.customAgentIds ?? []);
  const starredAgentIdSet = new Set(client.starredAgentIds ?? []);
  return customAgents
    .filter(
      (a) =>
        a.enabled &&
        !isUnlistedAgent(a) &&
        agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug) &&
        (allowedAgentIds.has(a.id) || starredAgentIdSet.has(a.id)),
    )
    .map((a) => ({ id: a.id, key: a.key, name: a.name, icon: a.icon ?? null }));
}
