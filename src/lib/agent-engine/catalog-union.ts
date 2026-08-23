import type { MiddlewareAgent } from "./middleware-admin";

/**
 * The engine agents the catalog renders.
 *
 * This used to de-duplicate against the lab-imported library, which hid five
 * of the eleven behind legacy cards: an agent that had a `customAgents` twin
 * rendered as the twin and lost its stages, its credit cost, its model and its
 * Studio link. The twin runs on a different executor, so "the same product"
 * was never quite true — and hiding a first-class agent to avoid showing two
 * cards traded a small duplication for a real omission.
 *
 * All eleven now render uniformly. The lab library still lists its own rows
 * below, because those are what most clients run today and they are not going
 * anywhere until the drain finishes.
 */

export interface EngineAgentCardModel {
  /** The middleware slug — also the engine `productId` and the Studio route. */
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

/**
 * Every control-plane agent, as catalog cards.
 *
 * Rows the middleware could not parse a slug from are dropped: prep's
 * `agents/` collection shares its name with karosCMO's since-removed in-app
 * engine and still holds one of its documents.
 */
export function buildEngineAgentCards(
  middlewareAgents: readonly MiddlewareAgent[],
): EngineAgentCardModel[] {
  const cards = middlewareAgents
    .filter((agent) => agent.slug !== "")
    .map((agent) => ({
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
    }));

  // Stable between loads; a catalog that reorders itself is its own bug.
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return cards;
}

/** An agent's native Studio page. */
export function agentStudioHref(slug: string): string {
  return `/agents/${encodeURIComponent(slug)}/studio`;
}
