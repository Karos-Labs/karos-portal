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
 * 34 call sites across 18 files. Three populations:
 *   · MEASUREMENT (1)  — probes a real consumer product; vendor IS the subject
 *   · COUPLED     (5)  — generation that depends on a server-side web tool
 *   · PLAIN       (28) — generation with no vendor-specific surface
 *
 * SCRUM-387 added three sites to the PLAIN population (27 -> 28), all in the
 * NEW file `src/lib/intel/context-doc-routing.ts`: "intel.condense" moved its
 * one remaining site there from `condense.ts` (which called it twice, once
 * per pass — the two passes now share one routed call site), and two new
 * "caller"-tier roles, "intel.condense.complexity_escalation" and
 * "intel.condense.context_overflow", cover the Opus/Gemini escalation
 * branches. See that role's own comment below and context-doc-routing.ts's
 * header for the full design.
 *
 * SCRUM-274 (T-B19) swept 10 sites off this manifest: `src/lib/intel/
 * pipeline.ts` (the hardcoded onboarding pipeline D1 killed) and `src/lib/
 * intel/seo-geo.ts` (its old, now-unreachable in-process SEO/GEO research
 * orchestrator) are both deleted, not merely bypassed. The "intel.research.
 * agent" role (5 sites, all in pipeline.ts) and "seo.site_audit" /
 * "seo.prompt_drafting" / "seo.competitor_extraction" (3 sites, all in the
 * deleted seo-geo.ts) are gone with them. "intel.pipeline.synthesis" keeps 2
 * of its former 4 sites — the 2 in `generateDoc` (pipeline.ts-only) are gone;
 * the 2 in `applyDocCorrections` moved verbatim to the new `src/lib/intel/
 * doc-corrections.ts` (still called from `src/lib/actions/intel-actions.ts`,
 * outside the deleted pipeline).
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
    sites: ["src/lib/intel/seo-geo-providers.ts:234"],
  },

  /* ── COUPLED · needs web_fetch · 1 site ──────────────────────────────────
     This cannot run on a vendor without web fetch. Not "runs worse" — its
     prompt instructs it to report only what it observed.
     SCRUM-274 (T-B19) removed "intel.research.agent" (5 sites) and
     "seo.site_audit" (1 site) — both lived exclusively in files this ticket
     deleted (`src/lib/intel/pipeline.ts`, `src/lib/intel/seo-geo.ts`); see
     this file's header comment. The Phase A cutover then removed
     "intel.report.pass" (2 sites) the same way: both lived in
     `runIntelReportPipeline`'s in-process report generation, which is deleted
     — the report now comes from `intel-report-agent`'s deliverable, so the
     live-web tools those sites needed are agent-engine's problem and no longer
     a vendor constraint on this repo. It was the last role requiring BOTH
     web_search and web_fetch. */
  "branding.fetch_site": {
    tier: "HAIKU",
    requires: ["web_fetch"],
    // Re-pinned twice: from :346 by SCRUM-394 (IGSTYLE-9), which inserted the
    // role-based palette resolver earlier in branding.ts, and again when
    // `normalizeHex` moved out to `branding-hex.ts` and the verified-palette
    // observer was wired in. Line pins are load-bearing here and drift with
    // any edit above them — that is the cost of pinning, and the sweep test
    // is what makes the cost visible instead of silent.
    sites: ["src/lib/branding.ts:500"],
  },

  /* ── COUPLED · web_search only · 2 sites ─────────────────────────────────
     These two CAN route to Vertex — but only via the basic webSearch_20250305
     variant. That makes them the likeliest place for a silent downgrade, which
     is precisely why they declare rather than inherit. */
  "x_agent.research": {
    tier: "SONNET",
    requires: ["web_search"],
    sites: ["src/lib/actions/x-agent-actions.ts:359"],
  },
  "branding.search_brand": {
    tier: "HAIKU",
    requires: ["web_search"],
    // Re-pinned from :386 — see branding.fetch_site's own comment above.
    sites: ["src/lib/branding.ts:540"],
  },

  /* ── PLAIN · no vendor-specific surface · 27 sites ───────────────────────
     These are the sites T-B2 moves. They declare nothing because they need
     nothing — which is a fact about them, now recorded rather than assumed.
     SCRUM-274 (T-B19): "intel.pipeline.synthesis" drops 2 of its 4 sites
     (`generateDoc`, deleted with pipeline.ts) and "seo.prompt_drafting" /
     "seo.competitor_extraction" (2 sites, deleted with seo-geo.ts) are gone
     entirely — see this file's header comment. */
  "intel.pipeline.synthesis": {
    tier: "SONNET",
    sites: [
      "src/lib/intel/doc-corrections.ts:67",
      "src/lib/intel/doc-corrections.ts:97",
    ],
  },
  "simulation.persona": {
    tier: "HAIKU",
    sites: [
      "src/lib/simulation-engine.ts:328",
      "src/lib/simulation-engine.ts:367",
      "src/lib/simulation-engine.ts:381",
      "src/lib/simulation-engine.ts:392",
    ],
  },
  "competitor.analysis": {
    tier: "SONNET",
    sites: [
      "src/lib/actions/competitor-actions.ts:111",
      "src/lib/actions/competitor-actions.ts:185",
      "src/lib/actions/competitor-actions.ts:309",
    ],
  },
  // HAIKU, not SONNET: both sites read a local `const MODEL = MODELS.HAIKU`.
  // Caught by diffing the manifest against the call sites before the T-B2 sweep —
  // declaring SONNET here would have silently upgraded both at sweep time.
  "intel.actions": {
    tier: "HAIKU",
    sites: [
      "src/lib/actions/intel-actions.ts:129",
      "src/lib/actions/intel-actions.ts:539",
    ],
  },
  "task.generation": {
    tier: "HAIKU",
    sites: [
      "src/lib/actions/task-actions.ts:364",
      "src/lib/actions/task-actions.ts:485",
    ],
  },
  // SCRUM-387 — the baseline (standard-complexity) condensation model. The
  // literal call site MOVED from condense.ts (which called this twice, once
  // per pass) into context-doc-routing.ts's routeContextDocCondensation:
  // one shared line, tried once per candidate vendor at runtime
  // (Vertex-primary, Anthropic-fallback), reused by both of condense.ts's
  // passes. See that file's own header for why this is not a fallback
  // mechanism competing with the two escalation roles below.
  "intel.condense": {
    tier: "SONNET",
    sites: ["src/lib/intel/context-doc-routing.ts:329"],
  },
  // SCRUM-387 — the complexity-driven premium escalation for a `high`-tier
  // document (`assessContextDocComplexity`). "caller"-tier and Anthropic-only
  // on purpose: `claude-opus-4-8` has no Vertex row in agent-engine's own
  // verified model catalog, so there is no per-vendor id to look up here —
  // see context-doc-routing.ts's own comment on HIGH_COMPLEXITY_MODEL.
  "intel.condense.complexity_escalation": {
    tier: "caller",
    sites: ["src/lib/intel/context-doc-routing.ts:312"],
  },
  // SCRUM-387 — the large-context escalation for a document that would not
  // fit Claude's context window even before considering complexity.
  // "caller"-tier because it is the one place this call site legitimately
  // crosses to vendor "google" (Gemini) — see context-doc-routing.ts's
  // LARGE_CONTEXT_MODEL comment.
  "intel.condense.context_overflow": {
    tier: "caller",
    sites: ["src/lib/intel/context-doc-routing.ts:293"],
  },
  "branding.extract": {
    tier: "HAIKU",
    // SCRUM-394 (IGSTYLE-9) inserted the role-based palette resolver above
    // this call in branding.ts, shifting these two line numbers down from
    // 736/751 — re-pinned against the real file, not carried over stale.
    // Re-pinned three times in 2026-09: the flow audit (R14) added reported
    // fields to `BrandingGenResult` above these calls, main's "stop inventing
    // colours" change moved them again, and the ScrappyCoco brand-evidence
    // change (rendered screenshot + Instagram images) moved them a third time.
    // All merged; provider-wiring.test.ts is what catches the drift.
    sites: ["src/lib/branding.ts:1030", "src/lib/branding.ts:1037"],
  },
  // Shifted 36/37 → 37/38 by the credits rework (2026-09), which added one
  // import above them. Re-pinned against the real file, per the rule above.
  "execution.sonnet": { tier: "SONNET", sites: ["src/lib/execution-engine.ts:37"] },
  "execution.haiku": { tier: "HAIKU", sites: ["src/lib/execution-engine.ts:38"] },
  "chat.client": {
    tier: "caller",
    // T-B3 picks the model here, T-B4 captures the full `aiFor` resolution at
    // the same call and T-B23 prices off it — three tickets moved this line, so
    // it is recomputed against the merged file rather than carried over from
    // any one branch.
    // Shifted 187 → 188 by the credits rework (2026-09), which added one import
    // above it. Re-pinned against the real file, per the rule above.
    sites: ["src/app/api/clients/[id]/chat/route.ts:188"],
  },
  "chat.followups": {
    tier: "HAIKU",
    // Shifted 825 → 834 by the credits rework's copy change to the copilot's
    // price appendix, which sits above this call.
    sites: ["src/app/api/clients/[id]/chat/route.ts:834"],
  },
  "insights.summary": {
    tier: "HAIKU",
    sites: ["src/app/api/clients/[id]/insights/route.ts:25"],
  },
  "agent_swarm.step": { tier: "HAIKU", sites: ["src/lib/agent-swarm.ts:284"] },
  "asset.title": { tier: "HAIKU", sites: ["src/lib/asset-titles.ts:51"] },
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
