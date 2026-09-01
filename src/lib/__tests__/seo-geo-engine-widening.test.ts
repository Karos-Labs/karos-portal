import { describe, expect, it } from "vitest";
import {
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  KNOWN_ENGINE_IDS,
  buildAnswerGrid,
  computeVisibilityIndex,
  isEngineId,
  type EngineId,
  type GeoProbe,
  type IntentPrompt,
  type PerEngineVisibility,
} from "@/lib/seo-geo";
import { buildEngineViews } from "@/components/seo-geo/presenter";
import type { SeoGeoInsights } from "@/lib/seo-geo";

/**
 * T-B16/SCRUM-271, acceptance #2: "`EngineId` covers all five engines with a
 * stated migration for old records." These pin the migration story stated in
 * `EngineId`'s own doc comment: the widening is a strict superset, so a
 * record persisted under the old three-value enum keeps rendering unchanged.
 */
describe("EngineId widened to agent-engine's real five-engine roster", () => {
  it("covers exactly the five engines T-A3 captures, matching agent-engine's own SEO_GEO_VISIBILITY_ENGINES literal set", () => {
    expect(KNOWN_ENGINE_IDS.slice().sort()).toEqual(["chatgpt", "claude", "copilot", "gemini", "perplexity"]);
    for (const engine of KNOWN_ENGINE_IDS) {
      expect(ENGINE_LABELS[engine]).toBeTruthy();
      // ENGINE_PROVIDERS may legitimately be null (no direct portal connector) —
      // the point is every engine has a row, not that every row is wired.
      expect(engine in ENGINE_PROVIDERS).toBe(true);
    }
  });

  it("isEngineId validates the five real values and rejects an unknown/garbled one crossing a service boundary", () => {
    for (const engine of KNOWN_ENGINE_IDS) expect(isEngineId(engine)).toBe(true);
    expect(isEngineId("bing")).toBe(false);
    expect(isEngineId(undefined)).toBe(false);
    expect(isEngineId(42)).toBe(false);
  });

  it("MIGRATION: a snapshot persisted under the old three-value enum (chatgpt/gemini/claude only) keeps computing and rendering unchanged", () => {
    const legacyPerEngine: PerEngineVisibility[] = (["chatgpt", "gemini", "claude"] as EngineId[]).map((engine) => ({
      engine,
      source: ENGINE_PROVIDERS[engine],
      captureTier: "MEASURED",
      promptsMeasured: 10,
      promptsTotal: 10,
      mentionRate: 0.4,
      citationRate: 0.1,
      firstPositionRate: 0.2,
      shareOfVoice: 30,
      netSentiment: 0.5,
      ghostCitationRate: 0,
      topCompetitor: null,
      brandMentions: [{ name: "Acme", mentions: 4, isClient: true }],
      category: {
        promptsMeasured: 10,
        mentionRate: 0.4,
        citationRate: 0.1,
        firstPositionRate: 0.2,
        shareOfVoice: 30,
        netSentiment: 0.5,
        ghostCitationRate: 0,
        topCompetitor: null,
        brandMentions: [{ name: "Acme", mentions: 4, isClient: true }],
      },
      brandNamed: 2,
      brandPromptsMeasured: 4,
    }));

    // No perplexity/copilot rows at all — exactly what every pre-T-B16 record looks like.
    const result = computeVisibilityIndex(legacyPerEngine, 3);
    expect(result.enginesTotal).toBe(3);
    expect(result.enginesScored).toBe(3);
    expect(result.index).toBeGreaterThan(0);

    const insights = { perEngine: legacyPerEngine, roster: ["Acme"], capturedAt: Date.now() } as SeoGeoInsights;
    const views = buildEngineViews(insights);
    // Widening ENGINE_ORDER to five adds no phantom cards for engines a legacy
    // snapshot never captured — chatgpt/gemini/claude still measured, and
    // perplexity/copilot render their honest "no answers this run" state
    // rather than vanishing or erroring.
    expect(views.filter((v) => v.status === "measured").map((v) => v.engine).sort()).toEqual(["chatgpt", "claude", "gemini"]);
    expect(views.find((v) => v.engine === "perplexity")?.status).toBe("no-data");
    expect(views.find((v) => v.engine === "copilot")?.status).toBe("no-data");
  });
});

/**
 * T-B16/SCRUM-271, acceptance #3: "AIO-absent and brand-absent remain
 * distinguishable end to end, proven by a test." This one exercises
 * `@/lib/seo-geo`'s own `cellState`/`buildAnswerGrid` directly (the mapping
 * layer's own end-to-end proof lives in
 * `agent-engine/__tests__/materialize.test.ts`).
 */
describe("Gemini AIO-absent vs brand-absent stay distinguishable in the answer grid", () => {
  it("a probe with aioAbsent:true renders a different cell state than an ordinary brand-absent probe", () => {
    const intentPrompts: IntentPrompt[] = [
      { prompt: "aio prompt", intent: "discovery" },
      { prompt: "plain absent prompt", intent: "discovery" },
    ];
    const probes: GeoProbe[] = [
      {
        engine: "gemini",
        source: "Gemini",
        prompt: "aio prompt",
        captureTier: "MEASURED_grounded",
        brandMentioned: false,
        brandCited: false,
        brandFirst: false,
        mentionedBrands: [],
        brandSentiment: 0,
        citations: [],
        aioAbsent: true,
      },
      {
        engine: "gemini",
        source: "Gemini",
        prompt: "plain absent prompt",
        captureTier: "MEASURED_grounded",
        brandMentioned: false,
        brandCited: false,
        brandFirst: false,
        mentionedBrands: [],
        brandSentiment: 0,
        citations: [],
        // aioAbsent omitted: an AI Overview genuinely rendered and just didn't name the brand.
      },
    ];
    const grid = buildAnswerGrid(intentPrompts, ["gemini"], probes);
    const aioRow = grid.find((r) => r.prompt === "aio prompt")!;
    const plainRow = grid.find((r) => r.prompt === "plain absent prompt")!;
    expect(aioRow.cells[0]!.state).toBe("aio_absent");
    expect(plainRow.cells[0]!.state).toBe("absent");
    expect(aioRow.cells[0]!.state).not.toBe(plainRow.cells[0]!.state);
  });

  it("aioAbsent never overrides a genuine brand mention or citation — it only distinguishes the two absent cases", () => {
    const intentPrompts: IntentPrompt[] = [{ prompt: "named prompt", intent: "discovery" }];
    const probes: GeoProbe[] = [
      {
        engine: "gemini",
        source: "Gemini",
        prompt: "named prompt",
        captureTier: "MEASURED_grounded",
        brandMentioned: true,
        brandCited: true,
        brandFirst: true,
        mentionedBrands: ["Acme"],
        brandSentiment: 1,
        citations: ["acme.example"],
        aioAbsent: true, // malformed/impossible on real data, but must not silently win over a real mention
      },
    ];
    const grid = buildAnswerGrid(intentPrompts, ["gemini"], probes);
    expect(grid[0]!.cells[0]!.state).toBe("named_first");
  });
});
