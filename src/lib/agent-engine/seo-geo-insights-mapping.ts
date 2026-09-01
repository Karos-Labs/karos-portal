/**
 * T-B16/SCRUM-271 — the typed mapping from agent-engine's real `seo-geo-agent`
 * output to `clientSeoGeo` (`SeoGeoInsights`, `@/lib/seo-geo`).
 *
 * WHY THIS IS A REAL MAPPING JOB, NOT A WIRING ONE (per the ticket). The
 * persisted deliverable alone (`seo-geo-deliverable-types.ts`'s
 * `AgentEngineSeoGeoReport`) carries scores, fired recommendations and the
 * frozen prompt set — but NOT the per-engine visibility breakdown, the
 * per-question answer grid, the citation leaderboard, or a KNOWN/FOUND split
 * (see that file's header finding: the workflow computes all of that
 * internally and discards it before persisting). This module reconstructs
 * everything it honestly can from the ONE place that data really does survive
 * — the raw `SeoGeoCaptureCell[]` checkpointed as step
 * `08-assemble-visibility-cells`'s own output (read via `readAgentEngineRun`,
 * the same Firestore mirror the Job page's step-output panel already reads)
 * — by converting each cell into this portal's own `GeoProbe` shape and
 * running it through the EXACT SAME pure functions
 * (`computePerEngineVisibility`, `computeVisibilityIndex`, `buildAnswerGrid`,
 * `computeCitationLeaderboard`, `computeCitationSummary`,
 * `computeCompetitorsNamed`, `computePresence`, `computeRosterSharePct`,
 * `buildRecommendations`) a portal-direct capture (`runSeoGeoResearch`,
 * `src/lib/intel/seo-geo.ts`) already uses. One methodology, two sources.
 *
 * WHAT STAYS HONESTLY ABSENT. `discoveredBrands` (open-ended brand discovery)
 * needs an LLM extraction pass over raw answer TEXT, which no capture cell
 * carries (cells are already-parsed structured fields, never the prose) — a
 * capability agent-engine's capture layer does not expose to this portal.
 * Left `undefined`, which `SeoGeoInsights.discoveredBrands` already types as
 * optional for exactly this reason ("Absent on snapshots captured before
 * brand discovery shipped" — equally true of "captured by a source that has
 * no discovery pass at all").
 *
 * `pipelineVersion`/`methodologyVersion` are also left `undefined` on
 * purpose, not copied from `SEO_GEO_PIPELINE_VERSION`/
 * `SEO_GEO_METHODOLOGY_VERSION`: agent-engine's own prompt plan
 * (`agents/seo-geo-agent/src/workflow/prompt-set.ts`'s `INTENT_QUOTA_TARGET`)
 * is an EVEN 5-per-intent-type split (25 questions), not this portal's
 * 20-question, category-heavy CD-J1 plan those two stamps assert. Claiming
 * either stamp would be a second dishonest claim on top of the one this
 * ticket exists to fix. Leaving both undefined means `buildSnapshotTrust`
 * (`components/seo-geo/presenter.ts`) shows its "not directly comparable"
 * banner on every engine-sourced snapshot — correct in substance (the
 * denominators genuinely differ from a portal-direct capture), even though
 * its copy ("an earlier measurement setup") reads as if only time separates
 * the two, which is a wording gap for a future ticket, not this one.
 *
 * PURE, LIKE `seo-geo.ts` ITSELF. This module makes no server call of its
 * own (no Firestore, no fetch, no env read) — it only transforms typed data
 * it is handed, so it carries no `server-only` marker and is directly
 * unit-testable. The server-boundary reads (the deliverable, the run's step
 * checkpoints, the client record) live in `persist-seo-geo-insights.ts`,
 * which calls this module.
 */
import {
  buildAnswerGrid,
  buildGazetteer,
  buildRecommendations,
  classifyIntent,
  computeCitationLeaderboard,
  computeCitationSummary,
  computeCompetitorsNamed,
  computePerEngineVisibility,
  computePresence,
  computeRosterSharePct,
  computeVisibilityIndex,
  dedupeGapsByRecId,
  intentBasis,
  isEngineId,
  normalizeBrandKey,
  GEO_READINESS_CHECKS,
  SEO_CHECKS,
  type EngineId,
  type Gazetteer,
  type GeoProbe,
  type IntentPrompt,
  type ProviderSource,
  type PromptIntent,
  type SeoGeoCheck,
  type SeoGeoInsights,
  type VisibilityGap,
} from "@/lib/seo-geo";
import { toRoutableRecommendation, type RoutableRecommendation } from "./routable-recommendation";
import type {
  AgentEngineCaptureCell,
  AgentEngineEvaluatedInput,
  AgentEngineScoreBreakdown,
  AgentEngineSeoGeoReport,
} from "./seo-geo-deliverable-types";

/** Which vendor genuinely answered for each engine on an agent-engine-sourced capture — see `ProviderSource`'s own doc for why `copilot` is `"Microsoft"` even though it shares `chatgpt`'s ScrappyCoco delivery route. */
const AGENT_ENGINE_SOURCE_BY_ENGINE: Record<EngineId, ProviderSource> = {
  chatgpt: "OpenAI",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Anthropic",
  copilot: "Microsoft",
};

/** Every engine T-A3 captures, in the portal's fixed roster order. */
const AGENT_ENGINE_ROSTER: readonly EngineId[] = ["chatgpt", "perplexity", "gemini", "claude", "copilot"];

const KNOWN_PROMPT_INTENTS: ReadonlySet<string> = new Set([
  "discovery",
  "comparison",
  "problem",
  "brand",
  "navigational",
]);

function asPromptIntent(value: string | undefined, prompt: string, gazetteer: Gazetteer): PromptIntent {
  if (value && KNOWN_PROMPT_INTENTS.has(value)) return value as PromptIntent;
  // Payload drift (a missing/unrecognized intentType) never blocks the mapping
  // — re-derive deterministically with the same classifier a portal-direct
  // capture uses, rather than dropping the prompt.
  return classifyIntent(prompt, gazetteer);
}

/**
 * One capture cell -> this portal's own `GeoProbe`, or `undefined` when the
 * cell can't be placed (an engine this portal doesn't know, or a `promptId`
 * with no matching prompt text) — dropped defensively, never thrown, same
 * rule every cross-boundary reader near this module follows.
 */
function cellToProbe(
  cell: AgentEngineCaptureCell,
  promptText: string,
  gazetteer: Gazetteer,
): GeoProbe | undefined {
  if (!isEngineId(cell.engine)) return undefined;
  const engine = cell.engine;

  // Roster hits, ordered by first appearance — the exact discipline
  // `analyzeAnswer` (seo-geo.ts) applies for a portal-direct capture: only
  // brands this portal actually tracks enter `mentionedBrands`, so an
  // off-roster name the engine happened to name never pads the roster-scoped
  // share-of-voice denominator (that is what `discoveredBrands` is for, and
  // it isn't derivable here — see this file's header).
  const competitorKeyToName = new Map<string, string>();
  for (const name of Object.keys(gazetteer.competitors)) competitorKeyToName.set(normalizeBrandKey(name), name);

  const clientName = gazetteer.client[0];
  const rosterHits: Array<{ brand: string; index: number }> = [];
  if (cell.brandMentioned) {
    rosterHits.push({ brand: clientName, index: cell.brandFirstMentionCharOffset ?? 0 });
  }
  for (const named of cell.competitorsNamed ?? []) {
    const canonical = competitorKeyToName.get(normalizeBrandKey(named.brandId));
    if (canonical) rosterHits.push({ brand: canonical, index: named.charOffset });
  }
  rosterHits.sort((a, b) => a.index - b.index);

  // ESTIMATED, never graded (same rule seo-geo.ts states three times) — the
  // cell's sentiment labels aren't attributed per-brand, so this averages
  // every mention in the answer rather than isolating the client's own,
  // which is a real fidelity reduction against a portal-direct capture's
  // `estimateMentionSentiment` (documented, not silently assumed equal).
  const sentiments = cell.sentimentPerMention ?? [];
  const sentimentScore = (label: "pos" | "neg" | "neutral") => (label === "pos" ? 1 : label === "neg" ? -1 : 0);
  const brandSentiment =
    cell.brandMentioned && sentiments.length > 0
      ? sentiments.reduce((sum, s) => sum + sentimentScore(s.label), 0) / sentiments.length
      : 0;

  return {
    engine,
    source: AGENT_ENGINE_SOURCE_BY_ENGINE[engine],
    prompt: promptText,
    captureTier: cell.captureTier,
    brandMentioned: cell.brandMentioned,
    brandCited: cell.brandCited,
    brandFirst: rosterHits.length > 0 && rosterHits[0].brand === clientName,
    mentionedBrands: rosterHits.map((h) => h.brand),
    brandSentiment,
    citations: (cell.citations ?? []).map((c) => c.domain),
    // Gemini-only, and only when the engine actually reported it — see
    // GeoProbe.aioAbsent's own doc for the contract this preserves end to end.
    ...(engine === "gemini" && cell.aioAbsent === true ? { aioAbsent: true } : {}),
  };
}

/** One `EvaluatedInput` -> this portal's `SeoGeoCheck`, labeled from the portal's own registry (the two repos' rec ids are the same a3 vocabulary — verified against `CRITICAL_ELIGIBILITY_RECS` in agent-engine's own `recommend.ts`). */
function evaluatedInputToCheck(
  input: AgentEngineEvaluatedInput,
  labelsById: ReadonlyMap<string, string>,
): SeoGeoCheck {
  const tier: SeoGeoCheck["tier"] =
    input.coverage === "measured" ? "MEASURED" : input.coverage === "estimated" ? "ESTIMATED" : "PENDING";
  const confidence: SeoGeoCheck["confidence"] =
    input.coverage === "measured" ? "CONFIRMED" : input.coverage === "estimated" ? "LIKELY" : "HYPOTHESIS";
  return {
    id: input.recId,
    bucket: input.bucket,
    label: labelsById.get(input.recId) ?? input.recId,
    // `measure` is a machine key on the wire (e.g. "lcp_p75"), not the
    // audit agent's free-text evidence prose — there is no evidence STRING on
    // a deterministic scorer's output to carry over honestly, so this states
    // what was actually measured (the normalized score) rather than
    // fabricating an observation sentence no one wrote.
    evidence: `Deterministically scored: norm ${Math.round(input.norm * 100) / 100} (${input.coverage})`,
    norm: Math.min(Math.max(input.norm, 0), 1),
    tier,
    confidence,
  };
}

/**
 * One `RoutableRecommendation` (already the C2 wire shape this portal parses
 * everywhere else it reads `firedRecommendations` — see
 * `materialize.ts`'s `materializeSeoGeoReport`) -> this portal's internal
 * `VisibilityGap`, the shape `buildRecommendations` (seo-geo.ts) already
 * knows how to turn into client-facing plan rows. `impact`/`delivery` are
 * loose strings on the wire (`routable-recommendation.ts`'s own doc explains
 * why); both are validated against the portal's closed unions here, with the
 * same never-guess fallback the rest of this module uses.
 */
const IMPACT_TO_SEVERITY: Record<string, VisibilityGap["severity"]> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};
const DELIVERY_TO_PORTAL: Record<string, VisibilityGap["delivery"]> = {
  "agent-direct": "agent-direct",
  "existing-product": "existing-product",
  // "new-product" has no portal-side equivalent yet — the fix genuinely can't
  // ship today, which is what "advisory" already means on this side.
  "new-product": "advisory",
};

function routableRecToGap(rec: RoutableRecommendation): VisibilityGap {
  return {
    id: rec.recId,
    lever: rec.lever,
    title: rec.check || rec.recommendation,
    severity: IMPACT_TO_SEVERITY[rec.impact] ?? "medium",
    evidence: rec.check || rec.recommendation,
    // The scorer is deterministic (zero LLM judgment, `recommend.ts`'s own
    // doc), so its verdicts are CONFIRMED, not an inferred/estimated tier.
    confidence: "CONFIRMED",
    fixAction: rec.fixAction,
    target: rec.productRef?.folder ?? (rec.lever === "GEO" ? "off-site" : "site-wide"),
    delivery: DELIVERY_TO_PORTAL[rec.delivery] ?? "advisory",
    benchmark: rec.check || rec.recommendation,
    measured: rec.recommendation,
    scoreLift: rec.scoreLift,
    productRef: rec.productRef,
    artifactRef: null,
  };
}

export interface SeoGeoMappingInput {
  clientId: string;
  clientName: string;
  clientWebsite?: string;
  competitors: Array<{ company: string; url?: string }>;
  report: AgentEngineSeoGeoReport;
  /** Raw capture cells from step `08-assemble-visibility-cells`'s checkpoint, or `undefined` when that step's output could not be read (not yet run, or archived to GCS — see `persist-seo-geo-insights.ts`). A mapping without cells still returns a valid, honestly degraded `SeoGeoInsights` (scores + recommendations + prompt set, zero engines scored). */
  cells: AgentEngineCaptureCell[] | undefined;
  capturedAt: number;
}

function scoreOf(breakdown: AgentEngineScoreBreakdown | undefined): { score: number; dataCoveragePct: number } {
  return { score: breakdown?.score ?? 0, dataCoveragePct: breakdown?.dataCoveragePct ?? 0 };
}

/**
 * The typed mapping (T-B16 acceptance #1): agent-engine's real `seo-geo-agent`
 * output -> `SeoGeoInsights`, with no `any` bridge anywhere on the path.
 */
export function mapAgentEngineSeoGeoToInsights(input: SeoGeoMappingInput): SeoGeoInsights {
  const { clientId, clientName, clientWebsite, competitors, report, cells, capturedAt } = input;

  const gazetteer = buildGazetteer(clientName, clientWebsite, competitors);

  const promptsById = new Map<string, string>();
  const rawPrompts = report.promptSet?.prompts ?? [];
  for (const p of rawPrompts) if (p.promptId && p.promptText) promptsById.set(p.promptId, p.promptText);

  const promptSet = rawPrompts.map((p) => p.promptText).filter((t): t is string => Boolean(t));
  const intentPrompts: IntentPrompt[] = rawPrompts
    .filter((p) => Boolean(p.promptText))
    .map((p) => ({ prompt: p.promptText, intent: asPromptIntent(p.intentType, p.promptText, gazetteer) }));

  const intentByPrompt = new Map(intentPrompts.map((ip) => [ip.prompt, ip.intent] as const));
  const isCategoryPrompt = (prompt: string): boolean => {
    const intent = intentByPrompt.get(prompt) ?? classifyIntent(prompt, gazetteer);
    return intentBasis(intent) === "category";
  };

  const probes: GeoProbe[] = (cells ?? [])
    .map((cell) => {
      const promptText = promptsById.get(cell.promptId);
      return promptText ? cellToProbe(cell, promptText, gazetteer) : undefined;
    })
    .filter((p): p is GeoProbe => p !== undefined);

  const perEngine = AGENT_ENGINE_ROSTER.map((engine) => {
    const computed = computePerEngineVisibility(engine, probes, gazetteer, isCategoryPrompt);
    // Always the real capture provenance for an engine-sourced snapshot —
    // never `ENGINE_PROVIDERS[engine]` (that table is this portal's OWN
    // direct-connector map, `null` for perplexity/copilot by construction;
    // see that constant's own doc in seo-geo.ts).
    return { ...computed, source: AGENT_ENGINE_SOURCE_BY_ENGINE[engine] };
  });

  const visibility = computeVisibilityIndex(perEngine, AGENT_ENGINE_ROSTER.length);

  const categoryProbes = probes.filter((p) => isCategoryPrompt(p.prompt));
  const presence = computePresence(probes, gazetteer, (prompt) => !isCategoryPrompt(prompt), promptSet);
  const rosterSharePct = computeRosterSharePct(probes, gazetteer, isCategoryPrompt);

  const seoLabels = new Map(SEO_CHECKS.map((c) => [c.id, c.label] as const));
  const geoLabels = new Map(GEO_READINESS_CHECKS.map((c) => [c.id, c.label] as const));
  const seoChecks = (report.seoScore?.inputs ?? []).map((i) => evaluatedInputToCheck(i, seoLabels));
  const geoChecks = (report.geoReadiness?.inputs ?? []).map((i) => evaluatedInputToCheck(i, geoLabels));

  const routable = (report.firedRecommendations ?? [])
    .map(toRoutableRecommendation)
    .filter((r): r is RoutableRecommendation => r !== undefined);
  const gaps: VisibilityGap[] = dedupeGapsByRecId(routable.map(routableRecToGap).sort((a, b) => b.scoreLift - a.scoreLift));

  // seoScore/geoReadiness come straight off the deliverable's own
  // ScoreBreakdown.score/dataCoveragePct — agent-engine's real, deterministic
  // scorer output — never recomputed from `seoChecks` here: that would risk
  // silently disagreeing with the number the engine actually persisted over
  // a mapping-only rounding or bucket difference.
  const seo = scoreOf(report.seoScore);
  const geo = scoreOf(report.geoReadiness);

  return {
    clientId,
    capturedAt,
    seoScore: seo.score,
    seoDataCoveragePct: seo.dataCoveragePct,
    geoReadiness: geo.score,
    geoReadinessCoveragePct: geo.dataCoveragePct,
    geoVisibilityIndex: visibility.index,
    geoVisibilityCoveragePct: visibility.dataCoveragePct,
    geoVisibilityModel: visibility.model,
    geoVisibilityEnginesMeasured: visibility.enginesMeasured,
    geoVisibilityEnginesScored: visibility.enginesScored,
    geoVisibilityEnginesTotal: visibility.enginesTotal,
    rosterSharePct,
    categoryPresence: presence.category,
    brandPresence: presence.brand,
    perEngine,
    gaps,
    recommendations: buildRecommendations(gaps),
    seoChecks,
    geoChecks,
    promptSet,
    intentPrompts,
    answerGrid: buildAnswerGrid(intentPrompts, [...AGENT_ENGINE_ROSTER], probes),
    citationLeaderboard: computeCitationLeaderboard(probes, gazetteer),
    citationSummary: computeCitationSummary(probes),
    competitorsNamed: computeCompetitorsNamed(categoryProbes, gazetteer),
    // Honestly absent — see this file's header.
    discoveredBrands: undefined,
    roster: [clientName, ...competitors.map((c) => c.company)],
    updatedAt: capturedAt,
  };
}
