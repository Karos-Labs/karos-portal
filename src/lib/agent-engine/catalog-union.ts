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
  /**
   * The distinct models the workflow's model stages are compiled to run, in
   * stage order. Read from each stage's `defaultModel`, never from the
   * agent-level `model` field the engine does not read: that field was seeded
   * as Sonnet for every agent, so the catalog said "Sonnet" for workflows
   * whose drafting step runs on Opus and whose vision steps run on Gemini.
   */
  models: string[];
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
/** Each model stage's compiled default, de-duplicated, in workflow order. */
export function stageModels(agent: Pick<MiddlewareAgent, "stages">): string[] {
  const seen = new Set<string>();
  for (const stage of agent.stages) {
    if (stage.kind === "agent" && stage.defaultModel) seen.add(stage.defaultModel);
  }
  return [...seen];
}

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
      models: stageModels(agent),
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
