/**
 * Client agent roster — the single source of "which agents can act for this
 * client". Agents are now two kinds: the managed karos-agents lab products
 * (MANAGED_PRODUCTS) and the client's assigned Custom agents (git-imported into
 * the customAgents collection, granted per client via client.customAgentIds).
 *
 * This helper unifies both into the AgentCatalogEntry shape the copilot and the
 * Agent Swarm feed to their LLM context, so task generation is aware of the full
 * roster — not just the four hardcoded products. Server-only (reads Firestore).
 */

import "server-only";
import { getClient, listCustomAgents } from "@/lib/data";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { agentKeyMatchesClientSlug } from "@/lib/custom-agent-launch";
import type { AgentCatalogEntry } from "@/lib/ai/prompts/proactive-assistant";

/** Client-safe summary of a custom agent — never exposes instructions/skill paths. */
export interface ClientCustomAgentSummary {
  id: string;
  name: string;
  description: string;
}

/**
 * The custom agents a client can actually use: assigned to the client
 * (client.customAgentIds) AND enabled AND not a per-client instance bound to a
 * different client — both submit cores refuse that pair, so proposing it in a
 * task would be an offer nothing can fulfil. Empty when none are granted.
 */
export async function getClientCustomAgents(clientId: string): Promise<ClientCustomAgentSummary[]> {
  const client = await getClient(clientId);
  const allowed = new Set(client?.customAgentIds ?? []);
  if (allowed.size === 0) return [];
  const agents = await listCustomAgents();
  return agents
    .filter(
      (a) =>
        a.enabled &&
        allowed.has(a.id) &&
        agentKeyMatchesClientSlug(a.key, client?.agentsRepoSlug),
    )
    .map((a) => ({ id: a.id, name: a.name, description: a.description }));
}

/** Managed-product entries in AgentCatalogEntry form (always available). */
export function managedCatalogEntries(): AgentCatalogEntry[] {
  return MANAGED_PRODUCTS.map((p) => ({
    id: p.taskType,
    name: p.name,
    outputKind: p.taskType,
    description: `${p.tagline}. ${p.description}`,
    capabilities: [] as string[],
    deliverables: p.deliverables,
    estimate: p.estimate,
    briefKeys: p.briefFields.map((f) => f.key),
    kind: "managed" as const,
  }));
}

/**
 * The unified agent catalog for LLM context: managed products first, then the
 * client's custom agents. Pure — takes the already-fetched custom agents so the
 * caller controls the query (and tests stay I/O-free).
 */
export function buildAgentCatalog(customAgents: ClientCustomAgentSummary[]): AgentCatalogEntry[] {
  const custom: AgentCatalogEntry[] = customAgents.map((a) => ({
    id: a.id,
    name: a.name,
    outputKind: "custom",
    description: a.description,
    capabilities: [] as string[],
    kind: "custom" as const,
  }));
  return [...managedCatalogEntries(), ...custom];
}
