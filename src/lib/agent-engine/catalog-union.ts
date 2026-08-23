import type { MiddlewareAgent } from "./middleware-admin";

/**
 * The union of the two places an agent can exist.
 *
 * `customAgents` is the lab-imported library the portal has always rendered.
 * `agent-middleware` is the control plane, and it holds agents the library
 * never had — `intel-report-agent` today. Rendering only the library hides
 * those; rendering only the middleware hides the majority that still run on
 * agent-service. Neither collection is a superset, so the catalog is a union.
 *
 * ## Why the display mapping is not the routing mapping
 *
 * `resolveAgentEngineProductIdForCustomAgent` answers "does agent-engine run
 * this", and it deliberately covers only the three agents cut over so far.
 * This answers a different question — "are these two rows the same product to
 * a person looking at a list" — and covers every correspondence, including
 * agents nobody has migrated.
 *
 * Keeping them separate is the point. Folding them together would either make
 * the catalog show `instagram-agent` twice (routing does not know that pair)
 * or make dispatch route agents that have not been cut over (display does).
 * They are the same shape and mean different things.
 */
const CUSTOM_AGENT_KEY_BY_MIDDLEWARE_SLUG: Readonly<Record<string, string>> = {
  "x-agent": "karos-x-agent-v2",
  "linkedin-agent": "karos-linkedin-writer-v2",
  "reddit-agent": "karos-reddit-runner",
  "instagram-agent": "karos-instagram-agent",
  "landing-builder-agent": "landing-builder",
};

/** The library row's key for a control-plane agent, when the two are the same product. */
export function customAgentKeyForMiddlewareSlug(slug: string): string | undefined {
  return CUSTOM_AGENT_KEY_BY_MIDDLEWARE_SLUG[slug];
}

export interface ControlPlaneOnlyAgent {
  /** The middleware slug — also the engine `productId`, and the console's `?agent=`. */
  slug: string;
  name: string;
  description: string | null;
  status: MiddlewareAgent["status"];
  model: string | null;
  tags: string[];
  /** lucide icon name; the card falls back when absent. */
  icon: string | null;
  category: string | null;
  /** Null means "platform default", not free. */
  creditCost: number | null;
  /** How many steps the workflow runs — shown so a card conveys scale. */
  stageCount: number;
}

export interface AgentCatalogUnion<TLibraryAgent> {
  /** Library agents, unchanged and in their original order. */
  library: TLibraryAgent[];
  /**
   * Agents the control plane holds that no library row corresponds to.
   *
   * Rendered as their own first-class cards, with a working Run and an Edit in
   * Studio.
   *
   * Run does NOT go through the library's submit path. That path needs
   * `entrySkillDir`, `instructions` and skill roots these agents have no source
   * for, so the moment a client fell outside the engine gate it would submit an
   * agent-service job the runner cannot build. They dispatch straight to
   * agent-engine instead — see `dispatchControlPlaneAgentAction` — which is the
   * only executor they have.
   */
  controlPlaneOnly: ControlPlaneOnlyAgent[];
}

/**
 * Merges the two lists, de-duplicating on the display mapping above.
 *
 * The library list passes through untouched — same rows, same order — so this
 * can never remove or reorder an agent someone already runs. Everything new is
 * additive.
 */
export function buildAgentCatalogUnion<TLibraryAgent extends { key: string }>(
  libraryAgents: readonly TLibraryAgent[],
  middlewareAgents: readonly MiddlewareAgent[],
): AgentCatalogUnion<TLibraryAgent> {
  const libraryKeys = new Set(libraryAgents.map((a) => a.key));

  const controlPlaneOnly: ControlPlaneOnlyAgent[] = [];
  for (const agent of middlewareAgents) {
    // A slug with no mapping is by definition not in the library, so it is a
    // new card. A slug WITH a mapping is only a new card if that library row
    // is actually absent — an agent can be mapped and still missing, e.g. a
    // library the importer has not run against yet.
    const mappedKey = customAgentKeyForMiddlewareSlug(agent.slug);
    if (mappedKey !== undefined && libraryKeys.has(mappedKey)) continue;
    if (!agent.slug) continue; // a row the middleware could not parse a slug from

    controlPlaneOnly.push({
      slug: agent.slug,
      name: agent.name || agent.slug,
      description: agent.description,
      status: agent.status,
      model: agent.model,
      tags: agent.tags,
      icon: agent.icon,
      category: agent.category,
      creditCost: agent.creditCost,
      stageCount: agent.stages.length,
    });
  }

  controlPlaneOnly.sort((a, b) => a.name.localeCompare(b.name));
  return { library: [...libraryAgents], controlPlaneOnly };
}

/** Where a control-plane agent's detail view lives. */
export function controlPlaneAgentHref(slug: string): string {
  return `/admin/agents/control-plane?agent=${encodeURIComponent(slug)}`;
}
