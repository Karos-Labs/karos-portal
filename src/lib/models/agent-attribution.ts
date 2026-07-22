/**
 * Canonical agent/source attribution for cost analytics.
 *
 * Every LLM call site already stamps a UsageLog with (agentId, agentName,
 * operation) — see src/services/logger.ts call sites. Almost none of them set
 * a distinct `agentId` (it's `null` everywhere except agent-service runs,
 * which all share the literal `"agent-service"`), so raw `agentId` can't drive
 * a real per-agent breakdown. This module derives a stable grouping key +
 * display name from the fields that ARE always populated, so the Analytics
 * dashboard can attribute cost/tokens per agent without any backfill:
 *
 *   - Managed products / custom agents (agent-service): grouped by the human
 *     `agentName` each job was created with (e.g. "X Agent", "Social posts") —
 *     the only thing that distinguishes them, since agentId is generic.
 *   - Copilot / conversational surfaces: one "Copilot" row.
 *   - SEO/GEO and onboarding/intel pipeline operations: elevated to their own
 *     agent-style rows, matching how the product is described to users.
 *   - Everything else: collapsed under "Other".
 *
 * Pure and dependency-light so it can run both at read time over historical
 * Firestore docs (data-analytics.ts) and, for O(1) snapshot rollups, at write
 * time (services/logger.ts) — same taxonomy either way.
 */

import { AGENT_SERVICE_AGENT_ID } from "@/lib/agent-service/products";

export interface AgentAttribution {
  /** Stable grouping key — safe to use as a Map key or sanitized Firestore field segment. */
  agentKey: string;
  /** Human label for the leaderboard/drilldown UI. */
  agentDisplayName: string;
}

/** Operations belonging to the SEO/GEO visibility pipeline (src/lib/intel/seo-geo*.ts). */
const SEO_GEO_OPERATIONS = new Set(["seo_audit", "geo_capture", "geo_promptset"]);

/** Operations belonging to the onboarding / company-intel pipeline (src/lib/intel/*.ts). */
const ONBOARDING_OPERATIONS = new Set([
  "intel_research",
  "intel_doc_generation",
  "intel_report",
  "doc_condense",
  "doc_correction",
  "client_brief",
  "doc_summary",
]);

/** Operations that are conversational/copilot surfaces rather than background jobs. */
const COPILOT_OPERATIONS = new Set(["chat_copilot", "operational_signal_extraction"]);

function slug(s: string): string {
  const cleaned = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

export function resolveAgentAttribution(input: {
  agentId: string | null;
  agentName: string;
  operation: string;
}): AgentAttribution {
  // Agent-service runs (managed products + custom agents, incl. the X agent
  // and every other portal agent) all share one generic agentId — agentName
  // is the only field that distinguishes them.
  if (input.agentId === AGENT_SERVICE_AGENT_ID) {
    return { agentKey: `agent:${slug(input.agentName)}`, agentDisplayName: input.agentName };
  }
  if (COPILOT_OPERATIONS.has(input.operation)) {
    return { agentKey: "copilot", agentDisplayName: "Copilot" };
  }
  if (SEO_GEO_OPERATIONS.has(input.operation)) {
    return { agentKey: "feature:seo_geo", agentDisplayName: "SEO/GEO Agent" };
  }
  if (ONBOARDING_OPERATIONS.has(input.operation)) {
    return { agentKey: "feature:onboarding_pipeline", agentDisplayName: "Onboarding Pipeline" };
  }
  return { agentKey: "other", agentDisplayName: "Other" };
}
