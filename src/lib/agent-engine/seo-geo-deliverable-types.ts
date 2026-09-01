/**
 * agent-engine's own `seo-geo-agent` output shapes, transcribed rather than
 * imported (T-B16/SCRUM-271) — the same convention `product-mapping.ts` and
 * `routable-recommendation.ts` already use for everything that crosses this
 * service boundary: agent-engine is a separate deployable with its own
 * release cycle, so a shared package would couple two independent deploys.
 *
 * Sources, read directly against agent-engine's real `origin/main`
 * (`56eae44`, the read-only reference clone at `/root/work9-engine-ref/ref-clone`):
 *   - `agents/seo-geo-agent/src/workflow/types.ts` — `SeoGeoReport` (the
 *     persisted deliverable, `kind: "seo-geo-report"`) and its sub-shapes.
 *   - `packages/tools/karos-seo-geo/src/types.ts` — `ScoreBreakdown`,
 *     `EvaluatedInput`, `VisibilityIndexResult`, `SeoGeoCaptureCell`,
 *     `SeoGeoVisibilityEngine`.
 *   - `packages/tools/karos-research/src/capture-visibility.ts` — the tool
 *     that actually captures each cell (`CaptureCell`, identical shape).
 *
 * ONLY THE FIELDS THIS TICKET'S MAPPER READS ARE TRANSCRIBED. Every field
 * below is asked for defensively in `seo-geo-insights-mapping.ts` (never
 * asserted), the same rule `materialize.ts`'s own header comment states for
 * every other cross-boundary reader in this file's neighborhood — a payload
 * whose shape drifted produces a thinner `SeoGeoInsights`, never a thrown
 * mapping.
 *
 * ============================================================================
 * FINDING (see the T-B16 report): agent-engine's real, persisted
 * `SeoGeoReport.visibility.byN`/`byNe` are the bare `VisibilityIndexResult`
 * (`{index, componentNorms}`) — the workflow computes a much richer
 * `VisibilityMetricsResult` (per-engine rates, the KNOWN/FOUND cohort split,
 * the RESOLVED `denominatorDecision`) internally
 * (`packages/tools/karos-seo-geo/src/score-tool.ts`'s own doc: "This is what
 * a report should publish") but discards it before persisting
 * (`create-seo-geo-agent-workflow.ts`'s step 09 keeps only `nResult.visibility`,
 * never `nResult.visibilityMetrics`). Per-engine rates, the citation
 * leaderboard, and the KNOWN/FOUND split are therefore NOT reconstructable
 * from the deliverable alone — this mapper reconstructs everything it
 * honestly can from the raw `SeoGeoCaptureCell[]` (persisted separately, as
 * step `08-assemble-visibility-cells`'s own checkpoint output) instead.
 * ============================================================================
 */

/** `packages/tools/karos-seo-geo/src/types.ts`'s `SeoGeoVisibilityEngine` / `SEO_GEO_VISIBILITY_ENGINES` — identical literal set to this portal's own (widened) `EngineId`. */
export const AGENT_ENGINE_VISIBILITY_ENGINES = ["chatgpt", "perplexity", "gemini", "claude", "copilot"] as const;
export type AgentEngineVisibilityEngine = (typeof AGENT_ENGINE_VISIBILITY_ENGINES)[number];

/** `SeoGeoCaptureCell.captureTier` / `CaptureCell.captureTier`. */
export type AgentEngineCaptureTier = "MEASURED" | "MEASURED_grounded" | "ESTIMATED" | "UNAVAILABLE";

/**
 * The load-bearing subset of `SeoGeoCaptureCell` (`karos-seo-geo/src/types.ts`)
 * / `CaptureCell` (`karos-research/src/capture-visibility.ts`) — identical
 * shape on both sides of that internal package boundary. This is what step
 * `08-assemble-visibility-cells` checkpoints as its own step output, one
 * entry per (prompt × engine) pair actually attempted this run.
 */
export interface AgentEngineCaptureCell {
  promptId: string;
  engine: string;
  captureTier: AgentEngineCaptureTier;
  brandMentioned: boolean;
  /** 1-based char offset of the client's own first mention — only meaningful when `brandMentioned`. */
  brandFirstMentionCharOffset?: number;
  brandCited: boolean;
  /** Roster members named in this answer, each with the char offset of their first mention. `brandId` is a roster display name, never `"client"`. */
  competitorsNamed?: Array<{ brandId: string; charOffset: number }>;
  citations?: Array<{ domain: string; ordinal: number }>;
  /** brandId ("client" or a roster name) -> mention count in this answer. */
  mentionCounts?: Record<string, number>;
  sentimentPerMention?: Array<{ mentionIndex: number; label: "pos" | "neg" | "neutral" }>;
  /** Gemini-only — see `GeoProbe.aioAbsent` in `@/lib/seo-geo` for the full contract this preserves. */
  aioAbsent?: boolean;
}

/** Step `08-assemble-visibility-cells`'s own checkpointed output (`SeoGeoVisibilityCapture`). */
export interface AgentEngineVisibilityCapture {
  cells: AgentEngineCaptureCell[];
  attemptedCount?: number;
  capturedCount?: number;
  measuredCount?: number;
}

/** `packages/tools/karos-seo-geo/src/types.ts`'s `EvaluatedInput` — one scored check instance. */
export interface AgentEngineEvaluatedInput {
  recId: string;
  bucket: string;
  measure?: string;
  norm: number;
  weight: number;
  coverage: "measured" | "estimated" | "unavailable";
}

/** `ScoreBreakdown` — `seoScore` / `geoReadiness` on the persisted deliverable. */
export interface AgentEngineScoreBreakdown {
  score: number;
  dataCoveragePct: number;
  inputs?: AgentEngineEvaluatedInput[];
}

/** `SeoGeoPrompt` — one entry of `promptSet.prompts`. */
export interface AgentEngineSeoGeoPrompt {
  promptId: string;
  promptText: string;
  /** `SEO_GEO_PROMPT_INTENT_TYPES` — identical literal set to this portal's own `PromptIntent`. */
  intentType: string;
}

/**
 * The subset of the persisted `SeoGeoReport` (`kind: "seo-geo-report"`) this
 * mapper reads. `visibility.denominatorDecision` is deliberately NOT
 * transcribed here — see the file header finding above and
 * `seo-geo-insights-mapping.ts`'s own comment for why it is never read.
 */
export interface AgentEngineSeoGeoReport {
  seoScore?: AgentEngineScoreBreakdown;
  geoReadiness?: AgentEngineScoreBreakdown;
  firedRecommendations?: unknown[];
  promptSet?: {
    prompts?: AgentEngineSeoGeoPrompt[];
  };
}

/**
 * `visibility.byN`/`byNe` (bare `VisibilityIndexResult`) are DELIBERATELY NOT
 * transcribed above, and the mapper never reads them. Two independent reasons,
 * both load-bearing:
 *
 *  1. They carry only the blended `{index, componentNorms}` — the per-engine
 *     rows, citation leaderboard and KNOWN/FOUND split this mapper needs are
 *     not in them (see this file's header finding).
 *  2. `computeVisibilityIndex` (`karos-seo-geo/src/visibility-index.ts`) is
 *     the EXACT "weighted-index" formula (citation 35 / first 20 /
 *     share_of_voice 20 / mention 15 / sentiment 6 / ghost 4) that THIS
 *     portal's own `src/lib/seo-geo.ts` explicitly retired as its headline —
 *     see that file's `GEO_VISIBILITY_MODEL` doc comment: "It replaced an
 *     earlier weighted-index model ... that diverged ~3x on the same frozen
 *     inputs ... Do NOT reintroduce the old model as the headline." Reading
 *     `report.visibility.byN.index` into `SeoGeoInsights.geoVisibilityIndex`
 *     would do exactly that — a second, silent reintroduction of the retired
 *     model, this time by pipeline choice rather than by mistake. The mapper
 *     instead recomputes the headline from the raw capture cells through this
 *     portal's own `computeVisibilityIndex`/`engineVisibilityScore`
 *     (appearance-led, geo-score-v3) — the same call `runSeoGeoResearch`
 *     already makes for a portal-direct capture, so both sources agree on
 *     what "visibility" means.
 */
