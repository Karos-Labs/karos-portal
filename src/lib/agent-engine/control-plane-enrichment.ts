import "server-only";

import {
  MiddlewareRequestError,
  getActivePrompt,
  listAgents,
  type MiddlewareAgent,
} from "./middleware-admin";
import { isMiddlewareDispatchEnabled } from "./middleware-client";
import { resolveAgentEngineProductIdForCustomAgent } from "./product-mapping";

/**
 * Merges control-plane facts onto the catalog karosCMO already has.
 *
 * The catalog's spine stays `customAgents`. That is not a transitional
 * compromise — the control plane knows five agents and clients run ten plus
 * the managed products, so sourcing the catalog from `GET /agents` would make
 * agents people use today disappear from their own portal.
 *
 * What the middleware genuinely adds is versioning: which prompt version an
 * agent is on, and whether it is active in the control plane at all. That is
 * layered on top, per agent, and every agent it knows nothing about renders
 * exactly as before.
 *
 * ## Degrading
 *
 * Every failure returns an empty enrichment rather than throwing. The catalog
 * is how a client reaches their agents; a control plane that is down, slow or
 * unconfigured must cost them the version badge, never the page.
 */

export interface ControlPlaneFacts {
  /** The middleware's slug for this agent — also its engine `productId`. */
  agentId: string;
  status: MiddlewareAgent["status"];
  /** Null when the agent exists in the control plane but has no prompt yet. */
  activePromptVersion: number | null;
  model: string | null;
}

/** Keyed by `customAgents.key`, so a caller looks up with what it already holds. */
export type ControlPlaneIndex = ReadonlyMap<string, ControlPlaneFacts>;

export const EMPTY_CONTROL_PLANE: ControlPlaneIndex = new Map();

/**
 * Facts for the subset of `agentKeys` the control plane knows.
 *
 * An agent qualifies when its key maps to an engine product id AND the
 * middleware actually holds that slug — the same mapping dispatch routes on,
 * so the badge cannot claim a lineage the runtime does not use.
 *
 * Prompt versions are fetched only for agents that qualify, one call each.
 * That is a handful of requests on an admin page, not per catalog row.
 */
export async function loadControlPlaneFacts(agentKeys: readonly string[]): Promise<ControlPlaneIndex> {
  if (!isMiddlewareDispatchEnabled()) return EMPTY_CONTROL_PLANE;

  const wanted = new Map<string, string>(); // engine product id -> customAgents.key
  for (const key of agentKeys) {
    const productId = resolveAgentEngineProductIdForCustomAgent(key);
    if (productId) wanted.set(productId, key);
  }
  if (wanted.size === 0) return EMPTY_CONTROL_PLANE;

  let agents: MiddlewareAgent[];
  try {
    agents = (await listAgents({ limit: 100 })).items;
  } catch (error) {
    warn("could not list control-plane agents", error);
    return EMPTY_CONTROL_PLANE;
  }

  const index = new Map<string, ControlPlaneFacts>();
  await Promise.all(
    agents
      .filter((agent) => wanted.has(agent.slug))
      .map(async (agent) => {
        // Per agent, so one agent with a broken prompt does not blank the
        // badge for every other one.
        let activePromptVersion: number | null = null;
        try {
          activePromptVersion = (await getActivePrompt(agent.slug))?.version ?? null;
        } catch (error) {
          warn(`could not read the active prompt for ${agent.slug}`, error);
        }
        index.set(wanted.get(agent.slug)!, {
          agentId: agent.slug,
          status: agent.status,
          activePromptVersion,
          model: agent.model,
        });
      }),
  );
  return index;
}

/**
 * Structured, and a warning rather than an error: nothing here is broken from
 * the client's point of view — they get the catalog, minus a badge — but a
 * control plane that has stopped answering should be countable.
 */
function warn(message: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      severity: "WARNING",
      message: `control-plane enrichment: ${message}`,
      reason: error instanceof Error ? error.message : String(error),
      status: error instanceof MiddlewareRequestError ? (error.status ?? null) : null,
    }),
  );
}
