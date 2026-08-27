import type { Capability, Vendor } from "./capabilities";

/**
 * Every model call site in the portal, as a named role that declares what it
 * needs from its vendor.
 *
 * ── Why a manifest and not just a helper ─────────────────────────────────────
 * An exemption expressed as a bare `anthropic(...)` import is invisible: the
 * next person reads a call, not a reason. Here every constraint is in one file,
 * next to the sites it governs, and `provider.ts` checks the whole set at wiring
 * time. A site cannot quietly opt out — not declaring a capability it uses is
 * itself an error (see `provider.ts`'s tool-option check).
 *
 * `sites` is not decoration. It is what makes this manifest auditable against
 * the tree, and what the coverage test asserts against, so the manifest cannot
 * drift away from the code it claims to describe.
 *
 * 43 call sites across 19 files. Three populations:
 *   · MEASUREMENT (1)  — probes a real consumer product; vendor IS the subject
 *   · COUPLED    (11)  — generation that depends on a server-side web tool
 *   · PLAIN      (31)  — generation with no vendor-specific surface
 */

export type ModelTier = "SONNET" | "HAIKU";

export interface AiRole {
  /**
   * Model tier, or "caller" when the call site legitimately chooses at runtime
   * (a client-configured chat model, a per-transcript model).
   */
  readonly tier: ModelTier | "caller";
  /**
   * Server-side capabilities this role's PROMPT DEPENDS ON — not merely ones it
   * would enjoy. If removing it would make the output wrong rather than worse,
   * it belongs here.
   */
  readonly requires?: readonly Capability[];
  /**
   * Vendor lock, with the reason stated. Only for roles where the vendor is
   * part of what the code means, not a performance or cost preference.
   */
  readonly pinnedTo?: { readonly vendor: Vendor; readonly because: string };
  /** Call sites this role covers, as `path:line`. Asserted against the tree. */
  readonly sites: readonly string[];
}

export const AI_ROLES = {
  /* ── MEASUREMENT · 1 site ────────────────────────────────────────────────
     Not generation. The GEO visibility report measures what each consumer-facing
     answer engine actually says about a client; the "claude" column IS Claude
     the product. Vertex would return the raw model, which is a different thing
     to measure — the column would still populate, with numbers that no longer
     mean what the report says they mean. */
  "geo.capture.claude": {
    tier: "HAIKU",
    requires: ["web_search"],
    pinnedTo: {
      vendor: "anthropic",
      because:
        "Measurement, not generation: this is the 'claude' engine column of the GEO " +
        "visibility capture (EngineId = chatgpt | gemini | claude). Probing the real " +
        "consumer product IS the measurement — Vertex serves the raw model, so routing " +
        "here would silently change what the report claims to have measured.",
    },
    sites: ["src/lib/intel/seo-geo-providers.ts:230"],
  },

  /* ── COUPLED · needs web_fetch · 9 sites ─────────────────────────────────
     None of these can run on a vendor without web fetch. Not "runs worse" —
     each one's prompt instructs it to report only what it observed. */
  "intel.report.pass": {
    tier: "SONNET",
    requires: ["web_search", "web_fetch"],
    sites: ["src/lib/intel/report.ts:311", "src/lib/intel/report.ts:371"],
  },
  "intel.research.agent": {
    tier: "SONNET",
    requires: ["web_search", "web_fetch"],
    sites: [
      "src/lib/intel/pipeline.ts:232",
      "src/lib/intel/pipeline.ts:266",
      "src/lib/intel/pipeline.ts:312",
      "src/lib/intel/pipeline.ts:374",
      "src/lib/intel/pipeline.ts:416",
    ],
  },
  "seo.site_audit": {
    tier: "SONNET",
    requires: ["web_search", "web_fetch"],
    sites: ["src/lib/intel/seo-geo.ts:213"],
  },
  "branding.fetch_site": {
    tier: "HAIKU",
    requires: ["web_fetch"],
    sites: ["src/lib/branding.ts:340"],
  },

  /* ── COUPLED · web_search only · 2 sites ─────────────────────────────────
     These two CAN route to Vertex — but only via the basic webSearch_20250305
     variant. That makes them the likeliest place for a silent downgrade, which
     is precisely why they declare rather than inherit. */
  "x_agent.research": {
    tier: "SONNET",
    requires: ["web_search"],
    sites: ["src/lib/actions/x-agent-actions.ts:358"],
  },
  "branding.search_brand": {
    tier: "HAIKU",
    requires: ["web_search"],
    sites: ["src/lib/branding.ts:379"],
  },

  /* ── PLAIN · no vendor-specific surface · 31 sites ───────────────────────
     These are the sites T-B2 moves. They declare nothing because they need
     nothing — which is a fact about them, now recorded rather than assumed. */
  "intel.pipeline.synthesis": {
    tier: "SONNET",
    sites: [
      "src/lib/intel/pipeline.ts:574",
      "src/lib/intel/pipeline.ts:589",
      "src/lib/intel/pipeline.ts:657",
      "src/lib/intel/pipeline.ts:687",
    ],
  },
  "simulation.persona": {
    tier: "HAIKU",
    sites: [
      "src/lib/simulation-engine.ts:329",
      "src/lib/simulation-engine.ts:368",
      "src/lib/simulation-engine.ts:382",
      "src/lib/simulation-engine.ts:393",
    ],
  },
  "competitor.analysis": {
    tier: "SONNET",
    sites: [
      "src/lib/actions/competitor-actions.ts:112",
      "src/lib/actions/competitor-actions.ts:186",
      "src/lib/actions/competitor-actions.ts:310",
    ],
  },
  // HAIKU, not SONNET: both sites read a local `const MODEL = MODELS.HAIKU`.
  // Caught by diffing the manifest against the call sites before the T-B2 sweep —
  // declaring SONNET here would have silently upgraded both at sweep time.
  "intel.actions": {
    tier: "HAIKU",
    sites: [
      "src/lib/actions/intel-actions.ts:126",
      "src/lib/actions/intel-actions.ts:469",
    ],
  },
  "task.generation": {
    tier: "HAIKU",
    sites: [
      "src/lib/actions/task-actions.ts:364",
      "src/lib/actions/task-actions.ts:485",
    ],
  },
  "intel.condense": {
    tier: "SONNET",
    sites: ["src/lib/intel/condense.ts:72", "src/lib/intel/condense.ts:99"],
  },
  "branding.extract": {
    tier: "HAIKU",
    sites: ["src/lib/branding.ts:727", "src/lib/branding.ts:742"],
  },
  "execution.sonnet": { tier: "SONNET", sites: ["src/lib/execution-engine.ts:36"] },
  "execution.haiku": { tier: "HAIKU", sites: ["src/lib/execution-engine.ts:37"] },
  "chat.client": {
    tier: "caller",
    sites: ["src/app/api/clients/[id]/chat/route.ts:110"],
  },
  "chat.followups": {
    tier: "HAIKU",
    sites: ["src/app/api/clients/[id]/chat/route.ts:703"],
  },
  "seo.prompt_drafting": { tier: "SONNET", sites: ["src/lib/intel/seo-geo.ts:415"] },
  "seo.competitor_extraction": { tier: "SONNET", sites: ["src/lib/intel/seo-geo.ts:580"] },
  "insights.summary": {
    tier: "HAIKU",
    sites: ["src/app/api/clients/[id]/insights/route.ts:26"],
  },
  "agent_swarm.step": { tier: "HAIKU", sites: ["src/lib/agent-swarm.ts:272"] },
  "asset.title": { tier: "HAIKU", sites: ["src/lib/asset-titles.ts:52"] },
  "campaign.plan": { tier: "SONNET", sites: ["src/lib/campaign-engine.ts:266"] },
  "dynamic_agent.generate": {
    tier: "SONNET",
    sites: ["src/lib/dynamic-agent-generation.ts:196"],
  },
  "transcript.ingest": { tier: "caller", sites: ["src/lib/transcripts/ingest.ts:34"] },
} as const satisfies Record<string, AiRole>;

export type AiRoleName = keyof typeof AI_ROLES;

/** Every role name, for exhaustive iteration in the wiring assertion and tests. */
export const AI_ROLE_NAMES = Object.keys(AI_ROLES) as AiRoleName[];

/**
 * Widened accessor. `AI_ROLES` is `as const satisfies` so the KEYS stay literal
 * (that is what makes `AiRoleName` exhaustive), but that also narrows each entry
 * to its own literal shape, so `.requires` does not exist on roles that omit it.
 * Read specs through here.
 */
export function roleSpec(role: AiRoleName): AiRole {
  return AI_ROLES[role];
}

/** Total call sites the manifest claims to cover. Asserted against the tree. */
export function declaredSiteCount(): number {
  return AI_ROLE_NAMES.reduce((n, r) => n + AI_ROLES[r].sites.length, 0);
}
