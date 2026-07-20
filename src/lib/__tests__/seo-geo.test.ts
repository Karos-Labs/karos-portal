import { describe, expect, it } from "vitest";
import {
  GEO_READINESS_CHECKS,
  SEO_CHECKS,
  TARGET_MENTION,
  analyzeAnswer,
  buildAnswerGrid,
  buildGazetteer,
  buildRecommendations,
  classifyIntent,
  computeCheckGaps,
  computeCheckScore,
  computeCitationLeaderboard,
  computeCitationSummary,
  computeCompetitorsNamed,
  computePerEngineVisibility,
  computeVisibilityGaps,
  computeVisibilityIndex,
  findMention,
  ratioClamp,
  rootDomain,
  tagPromptIntents,
  type EngineAnswer,
  type SeoGeoCheck,
} from "../seo-geo";

const gaz = buildGazetteer("Acme Fintech", "https://www.acmefintech.com", [
  { company: "Rival One", url: "https://rivalone.com" },
  { company: "Beta Corp" },
]);

function answer(patch: Partial<EngineAnswer> = {}): EngineAnswer {
  return {
    engine: "chatgpt",
    source: "OpenAI",
    prompt: "best fintech?",
    answerText: "",
    citations: [],
    captureTier: "MEASURED",
    ...patch,
  };
}

describe("registry weights (ported from a3-scoring-v2)", () => {
  it("SEO check weights sum to 100", () => {
    expect(SEO_CHECKS.reduce((a, c) => a + c.weight, 0)).toBe(100);
  });
  it("GEO readiness check weights sum to 100", () => {
    expect(GEO_READINESS_CHECKS.reduce((a, c) => a + c.weight, 0)).toBe(100);
  });
});

describe("gazetteer matching", () => {
  it("matches on word boundaries, case-insensitive", () => {
    expect(findMention("We recommend ACME FINTECH for payments.", "Acme Fintech")).toBeGreaterThan(0);
    expect(findMention("The acmefintechy tool", "Acme Fintech")).toBe(-1);
  });
  it("extracts registrable root domains", () => {
    expect(rootDomain("https://www.acmefintech.com/pricing")).toBe("acmefintech.com");
    expect(rootDomain("rivalone.com")).toBe("rivalone.com");
    expect(rootDomain(undefined)).toBeNull();
  });
  it("counts a competitor referenced only by its domain or short label (URL aliases)", () => {
    const byDomain = analyzeAnswer(
      answer({ answerText: "For payments, rivalone.com is the usual pick." }),
      gaz,
    );
    expect(byDomain.mentionedBrands).toContain("Rival One");

    const byLabel = analyzeAnswer(
      answer({ answerText: "Most people just use Rivalone these days." }),
      gaz,
    );
    expect(byLabel.mentionedBrands).toContain("Rival One");

    // A competitor with no URL is still matched only by name (no false domain hits).
    const betaOnly = analyzeAnswer(answer({ answerText: "Beta Corp is fine." }), gaz);
    expect(betaOnly.mentionedBrands).toEqual(["Beta Corp"]);
  });
});

describe("answer analysis + provenance", () => {
  it("detects brand mention, citation, and first position; carries the provider source", () => {
    const probe = analyzeAnswer(
      answer({
        source: "Gemini",
        engine: "gemini",
        captureTier: "MEASURED_grounded",
        answerText: "Acme Fintech leads the market, ahead of Rival One.",
        citations: ["acmefintech.com", "example.org"],
      }),
      gaz,
    );
    expect(probe.brandMentioned).toBe(true);
    expect(probe.brandCited).toBe(true);
    expect(probe.brandFirst).toBe(true);
    expect(probe.mentionedBrands).toEqual(["Acme Fintech", "Rival One"]);
    expect(probe.source).toBe("Gemini");
  });

  it("treats UNAVAILABLE cells as measured absence of nothing", () => {
    const probe = analyzeAnswer(answer({ captureTier: "UNAVAILABLE" }), gaz);
    expect(probe.brandMentioned).toBe(false);
    expect(probe.mentionedBrands).toEqual([]);
  });
});

describe("per-engine visibility + gaps", () => {
  const probes = [
    analyzeAnswer(answer({ answerText: "Rival One is the leader. Beta Corp is solid too." }), gaz),
    analyzeAnswer(answer({ answerText: "Try Rival One or Acme Fintech." }), gaz),
    analyzeAnswer(answer({ answerText: "Beta Corp and Rival One dominate." }), gaz),
  ];

  it("computes mention rate and share of voice against the roster", () => {
    const vis = computePerEngineVisibility("chatgpt", probes, gaz);
    expect(vis.promptsMeasured).toBe(3);
    expect(vis.mentionRate).toBeCloseTo(1 / 3);
    // Mentions: client 1, Rival One 3, Beta Corp 2 → SOV = 1/6.
    expect(vis.shareOfVoice).toBeCloseTo(100 / 6, 5);
    expect(vis.topCompetitor?.name).toBe("Rival One");
    expect(vis.source).toBe("OpenAI");
  });

  it("derives competitor-gap values from client-vs-competitor data with provenance", () => {
    const vis = computePerEngineVisibility("chatgpt", probes, gaz);
    const gaps = computeVisibilityGaps([vis]);
    const sovGap = gaps.find((g) => g.id === "GEO-27:chatgpt");
    expect(sovGap).toBeDefined();
    expect(sovGap!.source).toBe("OpenAI");
    expect(sovGap!.lever).toBe("GEO");
    // Client is named 33% > TARGET_MENTION 30% → no mention-rate gap.
    expect(vis.mentionRate).toBeGreaterThan(TARGET_MENTION);
    expect(gaps.find((g) => g.id === "GEO-35:chatgpt")).toBeUndefined();
  });
});

describe("visibility index (appearance-led geo-score-v3, PR#6 contract)", () => {
  it("computes the appearance-led index and reports engines-of-total coverage", () => {
    const vis = computePerEngineVisibility(
      "chatgpt",
      [analyzeAnswer(answer({ answerText: "Acme Fintech is the best choice.", citations: ["acmefintech.com"] }), gaz)],
      gaz,
    );
    // All five signals maxed (named, cited, first, sole roster mention, positive) → per-engine 1.0.
    const result = computeVisibilityIndex([vis], 5);
    expect(result.index).toBe(100);
    expect(result.model).toContain("appearance-led");
    expect(result.enginesScored).toBe(1);
    expect(result.enginesMeasured).toBe(1);
    // 1 of 5 engines returned an answer this run.
    expect(result.dataCoveragePct).toBe(20);
  });

  it("weights appearance most heavily (0.40) — named-but-uncited scores > 0", () => {
    // Brand named (appearance=1) but not cited, not first-of-multi, modest roster share.
    const vis = computePerEngineVisibility(
      "gemini",
      [
        analyzeAnswer(answer({ engine: "gemini", source: "Gemini", answerText: "Rival One and Acme Fintech both work." }), gaz),
      ],
      gaz,
    );
    const result = computeVisibilityIndex([vis], 5);
    // appearance 0.40*1 dominates even with citation 0 and shared voice.
    expect(result.index).toBeGreaterThanOrEqual(40);
  });

  it("returns zero index and coverage when no engine measured", () => {
    const vis = computePerEngineVisibility("perplexity", [], gaz);
    const result = computeVisibilityIndex([vis], 5);
    expect(result.index).toBe(0);
    expect(result.enginesScored).toBe(0);
    expect(result.dataCoveragePct).toBe(0);
  });
});

describe("check scoring (measured-only, renormalized)", () => {
  it("scores only MEASURED checks and reports coverage", () => {
    const checks: SeoGeoCheck[] = [
      { id: "BOTH-01", bucket: "eligibility", label: "", evidence: "all 200", norm: 1, tier: "MEASURED", confidence: "CONFIRMED" },
      { id: "SEO-02", bucket: "onPage", label: "", evidence: "title 74 chars", norm: 0.5, tier: "MEASURED", confidence: "CONFIRMED" },
      { id: "SEO-04a", bucket: "technicalCwv", label: "", evidence: "no CrUX", norm: 0, tier: "PENDING", confidence: "HYPOTHESIS" },
    ];
    const result = computeCheckScore(SEO_CHECKS, checks);
    // Measured weight = 10 (BOTH-01) + 5 (SEO-02) = 15; earned = 10 + 2.5 = 12.5 → 83.
    expect(result.dataCoveragePct).toBe(15);
    expect(result.score).toBe(83);
  });

  it("emits prioritized gaps for failing measured checks only", () => {
    const checks: SeoGeoCheck[] = [
      { id: "BOTH-01", bucket: "eligibility", label: "", evidence: "3 pages noindexed", norm: 0.4, tier: "MEASURED", confidence: "CONFIRMED" },
      { id: "SEO-04a", bucket: "technicalCwv", label: "", evidence: "unmeasured", norm: 0, tier: "PENDING", confidence: "HYPOTHESIS" },
    ];
    const gaps = computeCheckGaps(SEO_CHECKS, checks, "SEO");
    expect(gaps).toHaveLength(1);
    // (1 − 0.4) × weight 10 = 6 → high severity.
    expect(gaps[0].scoreLift).toBe(6);
    expect(gaps[0].severity).toBe("high");
  });
});

describe("normalization primitives", () => {
  it("ratio_clamp behaves per the a3 spec", () => {
    expect(ratioClamp(0.05, 0.1)).toBe(0.5);
    expect(ratioClamp(0.3, 0.1)).toBe(1);
    expect(ratioClamp(-1, 0.1)).toBe(0);
    expect(ratioClamp(1, 0)).toBe(0);
  });
});

describe("PDF/report contract: intent taxonomy, answer grid, citations", () => {
  it("classifies prompts into the DISC/COMP/PROB/BRAND/NAV taxonomy", () => {
    expect(classifyIntent("best cafes to work from in Tel Aviv", gaz)).toBe("discovery");
    expect(classifyIntent("best app to find work-friendly cafes", gaz)).toBe("comparison");
    expect(classifyIntent("Acme Fintech alternative", gaz)).toBe("comparison"); // comparison wins over brand
    expect(classifyIntent("where can I work with outlets right now", gaz)).toBe("problem");
    expect(classifyIntent("is Acme Fintech good?", gaz)).toBe("brand");
    expect(classifyIntent("acmefintech.com pricing", gaz)).toBe("navigational");
  });

  it("builds a per-question × per-engine grid with the right cell states", () => {
    const prompts = tagPromptIntents(["best fintech?", "is Acme Fintech good?"], gaz);
    const probes = [
      analyzeAnswer(answer({ engine: "chatgpt", prompt: "best fintech?", answerText: "Acme Fintech leads the market.", citations: ["acmefintech.com"] }), gaz),
      analyzeAnswer(answer({ engine: "gemini", source: "Gemini", prompt: "best fintech?", answerText: "Rival One is best; also see this guide.", citations: ["acmefintech.com"] }), gaz),
      analyzeAnswer(answer({ engine: "claude", source: "Anthropic", prompt: "is Acme Fintech good?", answerText: "There are other options like Rival One." }), gaz),
    ];
    const grid = buildAnswerGrid(prompts, ["chatgpt", "gemini", "claude", "perplexity", "copilot"], probes);
    expect(grid).toHaveLength(2);
    const row0 = grid[0];
    expect(row0.intent).toBe("discovery");
    expect(row0.cells).toHaveLength(5);
    // chatgpt: named + cited + sole roster mention → named_first
    expect(row0.cells.find((c) => c.engine === "chatgpt")?.state).toBe("named_first");
    // gemini: cited the client domain but named Rival One, not the client → ghost
    expect(row0.cells.find((c) => c.engine === "gemini")?.state).toBe("cited_not_named");
    // perplexity/copilot: no connector → unavailable
    expect(row0.cells.find((c) => c.engine === "perplexity")?.state).toBe("unavailable");
    // claude row: named a competitor, client absent
    expect(grid[1].cells.find((c) => c.engine === "claude")?.state).toBe("absent");
  });

  it("computes the citation leaderboard and always keeps the client's own line", () => {
    const probes = [
      analyzeAnswer(answer({ answerText: "see these", citations: ["reddit.com", "acmefintech.com"] }), gaz),
      analyzeAnswer(answer({ answerText: "and these", citations: ["reddit.com"] }), gaz),
      analyzeAnswer(answer({ captureTier: "UNAVAILABLE", citations: ["ignored.com"] }), gaz),
    ];
    const board = computeCitationLeaderboard(probes, gaz);
    expect(board[0]).toMatchObject({ domain: "reddit.com", citations: 2, isClient: false });
    expect(board.find((r) => r.isClient)?.domain).toBe("acmefintech.com");
    // UNAVAILABLE probes are excluded.
    expect(board.find((r) => r.domain === "ignored.com")).toBeUndefined();
  });

  it("summarizes ghost citations (cited but not named) and competitors named", () => {
    const probes = [
      // cited + named → not ghost
      analyzeAnswer(answer({ answerText: "Acme Fintech is great.", citations: ["acmefintech.com"] }), gaz),
      // cited, not named (client absent, competitor named) → ghost
      analyzeAnswer(answer({ answerText: "Rival One is great.", citations: ["acmefintech.com"] }), gaz),
    ];
    const summary = computeCitationSummary(probes);
    expect(summary.totalMeasuredAnswers).toBe(2);
    expect(summary.answersCited).toBe(2);
    expect(summary.answersNamed).toBe(1);
    expect(summary.ghostCitations).toBe(1);

    const competitors = computeCompetitorsNamed(probes, gaz);
    expect(competitors).toEqual([{ name: "Rival One", mentions: 1 }]);
  });
});

describe("client-facing recommendations (dev-handoff §3b/§4)", () => {
  it("maps internal gaps to a client-safe action plan with the right controls", () => {
    const seoChecks: SeoGeoCheck[] = [
      { id: "SEO-06", bucket: "onPage", label: "Meta descriptions in range", evidence: "3 over limit", norm: 0.2, tier: "MEASURED", confidence: "CONFIRMED" },
      { id: "GEO-41", bucket: "indexReach", label: "Indexed on Google", evidence: "not verified", norm: 0, tier: "MEASURED", confidence: "CONFIRMED" },
      { id: "GEO-25", bucket: "offsiteEntity", label: "Wikipedia/Wikidata entity", evidence: "none", norm: 0, tier: "MEASURED", confidence: "CONFIRMED" },
    ];
    const gaps = computeCheckGaps(SEO_CHECKS.concat(GEO_READINESS_CHECKS), seoChecks, "SEO");
    const recs = buildRecommendations(gaps);

    const meta = recs.find((r) => r.title.includes("Meta descriptions"));
    expect(meta?.actionKind).toBe("one_click"); // meta_description is machine-appliable
    expect(meta?.productIds).toEqual(["a3"]);
    expect(meta?.targetPlatform).toBe("site");

    const index = recs.find((r) => r.title.includes("Indexed on Google"));
    expect(index?.actionKind).toBe("connect"); // indexReach → existing-product → connect

    const entity = recs.find((r) => r.title.includes("Wikipedia"));
    expect(entity?.actionKind).toBe("guided_manual"); // offsiteEntity → advisory
    expect(entity?.productIds).toEqual([]); // advisory has no runnable product

    // The client-safe shape carries NO internal producer fields (§4).
    for (const r of recs) {
      expect(r).not.toHaveProperty("fixAction");
      expect(r).not.toHaveProperty("delivery");
      expect(r).not.toHaveProperty("confidence");
      expect(r).not.toHaveProperty("evidence");
    }
  });

  it("dedupes by title and caps the plan length", () => {
    const dup: SeoGeoCheck[] = [
      { id: "SEO-02", bucket: "onPage", label: "Title tags", evidence: "a", norm: 0.1, tier: "MEASURED", confidence: "CONFIRMED" },
      { id: "SEO-02", bucket: "onPage", label: "Title tags", evidence: "b", norm: 0.1, tier: "MEASURED", confidence: "CONFIRMED" },
    ];
    const recs = buildRecommendations(computeCheckGaps(SEO_CHECKS, dup, "SEO"), 5);
    expect(recs.filter((r) => r.title === "Title tags ≤ 60 chars, unique, keyword-placed").length).toBeLessThanOrEqual(1);
  });
});
