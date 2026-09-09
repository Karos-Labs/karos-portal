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
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { agentKeyMatchesClientSlug } from "@/lib/custom-agent-launch";
import type { AgentCatalogEntry } from "@/lib/ai/prompts/proactive-assistant";

/** Client-safe summary of a custom agent — never exposes instructions/skill paths. */
export interface ClientCustomAgentSummary {
  id: string;
  /**
   * The lab identity (e.g. "karos-x-agent-v2") — carried so price quotes can
   * resolve the agent's launch profile (defaultRunBatchSize: a batch agent's
   * "per run" price is base × its pinned batch size, and quoting the base
   * alone understates the X agent by 10×). Not sensitive: client surfaces
   * already render it inside AgentIdentity strings.
   */
  key: string;
  name: string;
  /**
   * The CURATED client line, never `CustomAgent.description`. That field is the
   * lab manifest's own copy, written for the people who build agents ("Master
   * content-social skill…"), and this summary feeds the copilot's prompt — an
   * LLM the client is charged for, whose output the client reads. A prompt is
   * not a private place: the model quotes what it is given, so shipping the
   * manifest here is the CD-G2 defect with an extra step. Resolved through
   * clientAgentBlurb, the same helper every visible agent surface uses.
   */
  description: string;
  /**
   * Per-run price for billable client actors; null ⇒ CREDIT_COSTS.customAgentRun.
   * Carried so the copilot can quote the same figure the agent card shows
   * instead of refusing or guessing (QA F95).
   */
  creditCost?: number | null;
  /**
   * C4 (SCRUM-212) descriptor fields, carried straight from `CustomAgent`
   * (see the doc comment there) — never derived here from `key`/`name`. Real
   * values await the S-A16/SCRUM-230 data-population pass (not yet landed);
   * until then these are absent on every custom agent this repo has, and
   * `buildAgentCatalog` below defaults each to its empty/undefined form.
   */
  capabilities?: string[] | null;
  platforms?: string[] | null;
  consumesMedia?: boolean | null;
  requiredInputs?: string[] | null;
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
    .map((a) => ({
      id: a.id,
      key: a.key,
      name: a.name,
      description: clientAgentBlurb({
        key: a.key,
        name: a.name,
        clientBlurb: a.clientBlurb ?? null,
      }),
      creditCost: a.creditCost ?? null,
      capabilities: a.capabilities ?? null,
      platforms: a.platforms ?? null,
      consumesMedia: a.consumesMedia ?? null,
      requiredInputs: a.requiredInputs ?? null,
    }));
}

/** Managed-product entries in AgentCatalogEntry form (always available). */
export function managedCatalogEntries(): AgentCatalogEntry[] {
  return MANAGED_PRODUCTS.map((p) => ({
    id: p.taskType,
    name: p.name,
    outputKind: p.taskType,
    description: `${p.tagline}. ${p.description}`,
    capabilities: p.capabilities,
    platforms: p.platforms,
    consumesMedia: p.consumesMedia,
    requiredInputs: p.requiredInputs,
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
    // Descriptor rides straight through from the agent's own record (see
    // `ClientCustomAgentSummary`'s doc comment) — no per-agent name/key check.
    capabilities: a.capabilities ?? [],
    platforms: a.platforms ?? undefined,
    consumesMedia: a.consumesMedia ?? undefined,
    requiredInputs: a.requiredInputs ?? undefined,
    kind: "custom" as const,
  }));
  return [...managedCatalogEntries(), ...custom];
}
