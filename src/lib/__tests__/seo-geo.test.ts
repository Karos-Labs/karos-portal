import { describe, expect, it } from "vitest";
import {
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  GEO_READINESS_CHECKS,
  REC_COPY,
  resolveRecCopy,
  SEO_CHECKS,
  TARGET_MENTION,
  analyzeAnswer,
  brandKeys,
  buildAnswerGrid,
  buildGazetteer,
  buildRecommendations,
  calculateOverallVisibilityScore,
  categoryMetrics,
  classifyIntent,
  countBrandInAnswers,
  dedupeGapsByRecId,
  engineVisibilityScore,
  normalizeBrandKey,
  dedupeNearDuplicates,
  selectByIntentQuota,
  buildQuestionSet,
  countByIntent,
  computePresence,
  presenceCounts,
  INTENT_QUOTA,
  PLANNED_BRANDED_QUESTIONS,
  PLANNED_CATEGORY_QUESTIONS,
  PLANNED_QUESTIONS_TOTAL,
  computeCheckGaps,
  computeCheckScore,
  computeCitationLeaderboard,
  computeCitationSummary,
  computeCompetitorsNamed,
  computePerEngineVisibility,
  computeVisibilityGaps,
  computeVisibilityIndex,
  findMention,
  normalizeEvidence,
  ratioClamp,
  rootDomain,
  tagPromptIntents,
  type EngineAnswer,
  type PerEngineVisibility,
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
    const vis = computePerEngineVisibility("claude", [], gaz);
    const result = computeVisibilityIndex([vis], 5);
    expect(result.index).toBe(0);
    expect(result.enginesScored).toBe(0);
    expect(result.dataCoveragePct).toBe(0);
  });

  /** QA F10 — the headline used the FULL prompt set while every card below it used
   *  the category subset, and the sentiment term gave 5/100 to a brand with no
   *  presence at all. Both are grade-honesty defects, not weighting preferences. */
  it("scores zero for a brand with no presence, instead of a 5-point sentiment floor", () => {
    const isCategory = (p: string) => !/acme/i.test(p);
    const vis = computePerEngineVisibility(
      "chatgpt",
      [analyzeAnswer(answer({ prompt: "best fintech app?", answerText: "Rival One leads." }), gaz)],
      gaz,
      isCategory,
    );
    expect(vis.category.mentionRate).toBe(0);
    expect(engineVisibilityScore(vis)).toBe(0);
    expect(computeVisibilityIndex([vis], 5).index).toBe(0);
  });

  it("scores the index on category questions, so tile and cards share a denominator", () => {
    const isCategory = (p: string) => !/acme/i.test(p);
    const probes = [
      // Branded question: named by construction, guaranteed hit.
      analyzeAnswer(answer({ prompt: "is Acme Fintech good?", answerText: "Acme Fintech is great.", citations: ["acmefintech.com"] }), gaz),
      // Category question: only the competitor is named.
      analyzeAnswer(answer({ prompt: "best fintech app?", answerText: "Rival One leads the space." }), gaz),
    ];
    const vis = computePerEngineVisibility("chatgpt", probes, gaz, isCategory);
    // Full-set metrics still see the branded hit...
    expect(vis.mentionRate).toBeGreaterThan(0);
    // ...but the grade follows the category questions the fixes are designed to move.
    expect(vis.category.mentionRate).toBe(0);
    expect(computeVisibilityIndex([vis], 5).index).toBe(0);
  });

  it("still keeps the sentiment term once the brand is actually mentioned", () => {
    const vis = computePerEngineVisibility(
      "chatgpt",
      [analyzeAnswer(answer({ answerText: "Acme Fintech is the best choice.", citations: ["acmefintech.com"] }), gaz)],
      gaz,
    );
    expect(engineVisibilityScore(vis)).toBeCloseTo(1, 10);
  });

  it("falls back to full-set metrics for snapshots captured before `category` existed", () => {
    const vis = computePerEngineVisibility(
      "chatgpt",
      [analyzeAnswer(answer({ answerText: "Acme Fintech is the best choice.", citations: ["acmefintech.com"] }), gaz)],
      gaz,
    );
    const legacy = { ...vis, category: undefined as unknown as typeof vis.category };
    expect(categoryMetrics(legacy).mentionRate).toBe(vis.mentionRate);
    expect(engineVisibilityScore(legacy)).toBeCloseTo(1, 10);
  });
});

/**
 * Dashboard bug: the headline "AI Visibility Today" tile showed 37/100 next to
 * per-engine cards of ChatGPT 23% / Gemini 26% / Claude 25% — whose arithmetic
 * mean is 25, not 37. `calculateOverallVisibilityScore` is the one function that
 * turns a set of per-engine percentages into the headline; it must be a plain
 * mean of exactly those numbers so the tile and its own breakdown can never
 * contradict each other again.
 */
describe("calculateOverallVisibilityScore (aggregate score maths)", () => {
  it("averages measured engine scores deterministically", () => {
    expect(calculateOverallVisibilityScore([23, 26, 25])).toBe(25);
  });

  it("rounds to the nearest whole percent", () => {
    expect(calculateOverallVisibilityScore([1, 1, 2])).toBe(1); // mean 1.333 → 1
    expect(calculateOverallVisibilityScore([1, 2, 2])).toBe(2); // mean 1.667 → 2
  });

  it("returns 0 for an empty (no engines measured) input, never NaN", () => {
    expect(calculateOverallVisibilityScore([])).toBe(0);
  });

  it("is a no-op mean for a single engine", () => {
    expect(calculateOverallVisibilityScore([42])).toBe(42);
  });

  it("computeVisibilityIndex's headline is always calculateOverallVisibilityScore of its own perEngineScore — never a separately-rounded figure that can drift from the displayed breakdown", () => {
    const engines: PerEngineVisibility[] = [
      computePerEngineVisibility(
        "chatgpt",
        [analyzeAnswer(answer({ engine: "chatgpt", source: "OpenAI", answerText: "Acme Fintech is solid, Rival One too." }), gaz)],
        gaz,
      ),
      computePerEngineVisibility(
        "gemini",
        [analyzeAnswer(answer({ engine: "gemini", source: "Gemini", answerText: "Rival One leads the category." }), gaz)],
        gaz,
      ),
      computePerEngineVisibility(
        "claude",
        [analyzeAnswer(answer({ engine: "claude", source: "Anthropic", answerText: "Acme Fintech is the best choice.", citations: ["acmefintech.com"] }), gaz)],
        gaz,
      ),
    ];
    const result = computeVisibilityIndex(engines, 5);
    expect(result.index).toBe(calculateOverallVisibilityScore(result.perEngineScore.map((e) => e.score)));
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
    // Names the brand — a guaranteed mention, not earned visibility — so brand wins over comparison wording.
    expect(classifyIntent("Acme Fintech alternative", gaz)).toBe("brand");
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
    // CD-B2: the tracked roster is the three engines with wired providers.
    const grid = buildAnswerGrid(prompts, ["chatgpt", "gemini", "claude"], probes);
    expect(grid).toHaveLength(2);
    const row0 = grid[0];
    expect(row0.intent).toBe("discovery");
    expect(row0.cells).toHaveLength(3);
    // chatgpt: named + cited + sole roster mention → named_first
    expect(row0.cells.find((c) => c.engine === "chatgpt")?.state).toBe("named_first");
    // gemini: cited the client domain but named Rival One, not the client → ghost
    expect(row0.cells.find((c) => c.engine === "gemini")?.state).toBe("cited_not_named");
    // claude answered the other prompt only → no cell data for this row
    expect(row0.cells.find((c) => c.engine === "claude")?.state).toBe("unavailable");
    // claude row: named a competitor, client absent
    expect(grid[1].cells.find((c) => c.engine === "claude")?.state).toBe("absent");
  });

  it("has a wired provider for every tracked engine (CD-B2)", () => {
    for (const engine of Object.keys(ENGINE_PROVIDERS) as Array<keyof typeof ENGINE_PROVIDERS>) {
      expect(ENGINE_PROVIDERS[engine]).not.toBeNull();
    }
    expect(Object.keys(ENGINE_LABELS).sort()).toEqual(["chatgpt", "claude", "gemini"]);
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

describe("QA Fix 4: two-stage prompt pipeline (dedupe + quota)", () => {
  it("drops near-duplicate prompts by shingle overlap", () => {
    const deduped = dedupeNearDuplicates([
      "best cafes to work from in tel aviv",
      "best cafes to work from around tel aviv", // near-dup of the first
      "quiet place to work near me right now",
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toContain("best cafes to work from");
    expect(deduped).toContain("quiet place to work near me right now");
  });

  it("balances the final set by per-intent quota and caps brand prompts", () => {
    // A pool over-weighted with brand prompts must not dominate the final set.
    const pool = [
      "What is Acme Fintech?",
      "Is Acme Fintech good?",
      "Is Acme Fintech worth it?",
      "Acme Fintech reviews", // 4 brand prompts (quota is 3)
      "Best fintech apps",
      "Top fintech providers",
      "Where to find a fintech tool",
      "How do I choose a fintech provider?",
      "Fintech alternative to the big banks",
    ];
    const selected = selectByIntentQuota(pool, gaz, 20);
    const brandCount = selected.filter((p) => classifyIntent(p, gaz) === "brand").length;
    expect(brandCount).toBeLessThanOrEqual(3); // brand quota respected
    expect(selected.length).toBeGreaterThanOrEqual(5);
  });
});

/* ── CD-J1 directive 1: the question plan is a contract ─────────────── */

const TEMPLATES = {
  discovery: [
    "What are the best fintech companies right now?",
    "Who are the most trusted names in fintech?",
    "Top-rated fintech providers",
    "Which fintech provider should I choose and why?",
    "What should I look for when picking a fintech provider?",
    "Who are the leading fintech providers people recommend?",
    "What are the most popular fintech options?",
  ],
  comparison: [
    "Compare the top fintech options for a new customer",
    "Best app or tool for fintech",
    "What are the alternatives worth comparing in fintech?",
    "Which app to use for fintech?",
    "Compare pricing and features across fintech providers",
    "Best apps for fintech compared",
  ],
  problem: [
    "How do I choose a fintech provider near me?",
    "I need help with fintech right now — where do I start?",
    "How do I get started with fintech?",
    "How can I fix a bad experience with fintech?",
    "Where can I find a reliable fintech provider?",
    "How do I know if a fintech provider is any good?",
  ],
  brand: [
    "What is Acme Fintech?",
    "Is Acme Fintech good?",
    "Is Acme Fintech worth it?",
    "What do customers say about Acme Fintech?",
  ],
  navigational: ["Acme Fintech official site", "acmefintech.com"],
};

describe("CD-J1: the question plan is fixed, deterministic and category-heavy", () => {
  it("derives its totals from the quota rather than restating them", () => {
    expect(PLANNED_CATEGORY_QUESTIONS).toBe(
      INTENT_QUOTA.discovery + INTENT_QUOTA.comparison + INTENT_QUOTA.problem,
    );
    expect(PLANNED_BRANDED_QUESTIONS).toBe(INTENT_QUOTA.brand + INTENT_QUOTA.navigational);
    expect(PLANNED_QUESTIONS_TOTAL).toBe(PLANNED_CATEGORY_QUESTIONS + PLANNED_BRANDED_QUESTIONS);
    // The measurement base must dominate: every client-facing comparison is
    // computed on category questions alone (CD-B3).
    expect(PLANNED_CATEGORY_QUESTIONS).toBeGreaterThan(PLANNED_BRANDED_QUESTIONS);
  });

  it("pads a thin pool up to the full plan instead of shipping a short set", () => {
    // The old failure: three usable questions in, three questions measured, and a
    // client scored against a denominator no other client shared.
    const set = buildQuestionSet(["Best fintech apps", "What is Acme Fintech?"], gaz, TEMPLATES);
    expect(set).toHaveLength(PLANNED_QUESTIONS_TOTAL);
    expect(countByIntent(set, gaz)).toEqual(INTENT_QUOTA);
    // The drafted questions survive — padding tops up, it does not replace.
    expect(set).toContain("Best fintech apps");
    expect(set).toContain("What is Acme Fintech?");
  });

  it("trims an intent the pool over-supplies, so shape never varies by pool", () => {
    const brandHeavy = [
      "What is Acme Fintech?",
      "Is Acme Fintech good?",
      "Is Acme Fintech worth it?",
      "Acme Fintech reviews",
      "What do customers say about Acme Fintech?", // 5 brand questions, quota is 3
    ];
    const set = buildQuestionSet(brandHeavy, gaz, TEMPLATES);
    const counts = countByIntent(set, gaz);
    expect(counts.brand).toBe(INTENT_QUOTA.brand);
    expect(counts).toEqual(INTENT_QUOTA);
  });

  it("is deterministic: the same pool and bank always produce the same set", () => {
    const pool = ["Best fintech apps", "How do I get started with fintech?", "Is Acme Fintech good?"];
    expect(buildQuestionSet(pool, gaz, TEMPLATES)).toEqual(buildQuestionSet(pool, gaz, TEMPLATES));
  });

  it("never double-counts a question the pool and the bank both contain", () => {
    const set = buildQuestionSet(["Top-rated fintech providers"], gaz, TEMPLATES);
    expect(new Set(set).size).toBe(set.length);
  });

  it("files every padded question where the classifier agrees it belongs", () => {
    // The plan, the report's intent tags and the branded/category denominators are
    // all produced by classifyIntent — a template filed under the wrong intent
    // would put the emitted shape back out of step with the displayed one.
    const set = buildQuestionSet([], gaz, TEMPLATES);
    expect(countByIntent(set, gaz)).toEqual(INTENT_QUOTA);
  });
});

describe("CD-J1: a question no engine answered is not a question we didn't ask", () => {
  const promptSet = ["Best fintech apps", "Top fintech providers", "What is Acme Fintech?"];
  const probeFor = (prompt: string, tier: "MEASURED" | "UNAVAILABLE", named: boolean) =>
    analyzeAnswer(
      answer({
        prompt,
        captureTier: tier,
        answerText: named ? "We recommend Acme Fintech." : "Try Rival One.",
      }),
      gaz,
    );

  it("keeps an all-unavailable question in the denominator as not-measured", () => {
    const presence = computePresence(
      [
        probeFor("Best fintech apps", "MEASURED", true),
        probeFor("Top fintech providers", "UNAVAILABLE", false), // every engine failed
        probeFor("What is Acme Fintech?", "MEASURED", true),
      ],
      gaz,
      (p) => classifyIntent(p, gaz) === "brand" || classifyIntent(p, gaz) === "navigational",
      promptSet,
    );
    const cat = presenceCounts(presence.category);
    // Two category questions were ASKED; one came back. The old maths reported
    // "1 of 1" — a perfect score built by deleting the question that failed.
    expect(cat.planned).toBe(2);
    expect(cat.measured).toBe(1);
    expect(cat.named).toBe(1);
    expect(cat.notMeasured).toBe(1);
  });

  it("counts a planned question no engine even attempted", () => {
    const presence = computePresence(
      [probeFor("Best fintech apps", "MEASURED", false)],
      gaz,
      () => false,
      promptSet,
    );
    const cat = presenceCounts(presence.category);
    expect(cat.planned).toBe(3); // the whole frozen set, branded predicate off
    expect(cat.measured).toBe(1);
    expect(cat.notMeasured).toBe(2);
  });

  it("reads a legacy bucket by its own rules: no `measured` means measured == total", () => {
    // Pre-v2 snapshots counted nothing unless it was measured, so there is no
    // not-measured remainder to disclose and none may be invented.
    expect(presenceCounts({ named: 3, total: 8 })).toEqual({
      named: 3,
      measured: 8,
      planned: 8,
      notMeasured: 0,
    });
    expect(presenceCounts(undefined)).toEqual({ named: 0, measured: 0, planned: 0, notMeasured: 0 });
  });
});

describe("QA Fix 1/2: tracked roster dedup + category-only comparison", () => {
  it("dedupes near-duplicate competitors into one entity (Kairos AI Agency == KAIROS.ai)", () => {
    const g = buildGazetteer("Acme", "https://acme.com", [
      { company: "Kairos AI Agency" },
      { company: "KAIROS.ai", url: "https://kairos.ai" },
      { company: "Distinct Co", url: "https://distinct.io" },
    ]);
    expect(Object.keys(g.competitors)).toHaveLength(2); // the two Kairos rows merged
  });

  it("computes the client-vs-competitor comparison on CATEGORY prompts only", () => {
    const isCategory = (p: string) => {
      const it = classifyIntent(p, gaz);
      return it !== "brand" && it !== "navigational";
    };
    const probes = [
      // brand prompt: client guaranteed a mention (must NOT inflate the comparison)
      analyzeAnswer(answer({ prompt: "is Acme Fintech good?", answerText: "Acme Fintech is solid." }), gaz),
      // category prompt: only a competitor is named
      analyzeAnswer(answer({ prompt: "best fintech app?", answerText: "Rival One leads the space." }), gaz),
    ];
    const vis = computePerEngineVisibility("chatgpt", probes, gaz, isCategory);
    // Full set (index inputs) still sees the brand mention.
    expect(vis.mentionRate).toBeGreaterThan(0);
    // Category comparison: client absent → 0% share of voice (NOT 100%), competitor leads.
    expect(vis.category.shareOfVoice).toBe(0);
    expect(vis.category.brandMentions.find((b) => b.isClient)?.mentions).toBe(0);
    expect(vis.category.topCompetitor?.name).toBe("Rival One");
    // Brand split is reported separately.
    expect(vis.brandNamed).toBe(1);
    expect(vis.brandPromptsMeasured).toBe(1);
  });
});

describe("one severity scale for every gap type (QA F22)", () => {
  const catMetrics = (patch: Record<string, unknown> = {}) => ({
    promptsMeasured: 10, mentionRate: 0, citationRate: 0, firstPositionRate: 0,
    shareOfVoice: 0, netSentiment: 0, ghostCitationRate: 0, topCompetitor: null,
    brandMentions: [], ...patch,
  });
  const engine = (patch: Record<string, unknown> = {}) =>
    ({
      engine: "chatgpt", source: "OpenAI", captureTier: "MEASURED", promptsMeasured: 10,
      promptsTotal: 10, mentionRate: 0, citationRate: 0, firstPositionRate: 0, shareOfVoice: 0,
      netSentiment: 0, ghostCitationRate: 0, topCompetitor: null, brandMentions: [],
      brandNamed: 0, brandPromptsMeasured: 0, category: catMetrics(), ...patch,
    }) as Parameters<typeof computeVisibilityGaps>[0][number];

  it("lands every visibility gap in the 0-10 band the site checks use", () => {
    const gaps = computeVisibilityGaps([
      engine({ category: catMetrics({ topCompetitor: { name: "Rival", mentionRate: 1, shareOfVoice: 100 } }) }),
    ]);
    for (const g of gaps) {
      expect(g.scoreLift).toBeGreaterThanOrEqual(0);
      expect(g.scoreLift).toBeLessThanOrEqual(10);
    }
  });

  it("derives the chip from the number the list is sorted by", () => {
    const gaps = computeVisibilityGaps([
      engine({ category: catMetrics({ topCompetitor: { name: "Rival", mentionRate: 1, shareOfVoice: 100 } }) }),
    ]);
    const bySeverity = { critical: 7, high: 4, medium: 2, low: 0 } as const;
    for (const g of gaps) expect(g.scoreLift).toBeGreaterThanOrEqual(bySeverity[g.severity]);
  });

  it("keeps a total miss at the severity the product intends", () => {
    const gaps = computeVisibilityGaps([
      engine({ category: catMetrics({ topCompetitor: { name: "Rival", mentionRate: 1, shareOfVoice: 100 } }) }),
    ]);
    // Never named at all: urgent. Never cited at all: important.
    expect(gaps.find((g) => g.id.startsWith("GEO-35"))!.severity).toBe("critical");
    expect(gaps.find((g) => g.id.startsWith("GEO-11"))!.severity).toBe("high");
    // Leader holding 100% to your 0%: urgent.
    expect(gaps.find((g) => g.id.startsWith("GEO-27"))!.severity).toBe("critical");
  });

  it("orders the client plan by impact, not by a lift on another scale", () => {
    const g = (patch: Partial<Parameters<typeof buildRecommendations>[0][number]>) => ({
      id: "SEO-02", lever: "SEO" as const, title: "t", severity: "low" as const, evidence: "",
      confidence: "CONFIRMED" as const, fixAction: "manual" as const, target: "site-wide",
      delivery: "agent-direct" as const, benchmark: "", measured: "", scoreLift: 1, ...patch,
    });
    const recs = buildRecommendations([
      // Higher lift, lower severity — used to sort above the urgent row.
      g({ id: "SEO-02", severity: "medium", scoreLift: 6 }),
      g({ id: "GEO-35:chatgpt", severity: "critical", scoreLift: 4.5 }),
    ]);
    expect(recs.map((r) => r.impact)).toEqual(["high", "medium"]);
    expect(recs[0].recId).toBe("GEO-35:chatgpt");
  });
});

describe("lever comes from the registry, not the id prefix (QA F16)", () => {
  const failing = (defs: typeof SEO_CHECKS): SeoGeoCheck[] =>
    defs.map((d) => ({
      id: d.id, bucket: d.bucket, label: d.label, evidence: "failing", norm: 0,
      tier: "MEASURED", confidence: "CONFIRMED",
    }));

  it("keeps GEO-prefixed SEARCH checks on the search channel", () => {
    // The four the finding names: GEO-01, GEO-02, GEO-17, GEO-20 all live in
    // SEO_CHECKS, and prefix-reading filed them as AI-only.
    const gaps = computeCheckGaps(SEO_CHECKS, failing(SEO_CHECKS), "SEO");
    for (const id of ["GEO-01", "GEO-02", "GEO-17", "GEO-20"]) {
      expect(gaps.find((g) => g.id === id)!.lever).toBe("SEO");
    }
  });

  it("still honours a BOTH- prefix for a check that lives in one registry only", () => {
    // BOTH-05 is in SEO_CHECKS alone; forcing the registry lever would hide it
    // from the AI tab — the same mis-filing in the other direction.
    const gaps = computeCheckGaps(SEO_CHECKS, failing(SEO_CHECKS), "SEO");
    expect(gaps.find((g) => g.id === "BOTH-05")!.lever).toBe("BOTH");
  });

  it("ends up as BOTH for a check scored in both registries", () => {
    const merged = dedupeGapsByRecId([
      ...computeCheckGaps(SEO_CHECKS, failing(SEO_CHECKS), "SEO"),
      ...computeCheckGaps(GEO_READINESS_CHECKS, failing(GEO_READINESS_CHECKS), "GEO"),
    ]);
    for (const id of ["GEO-01", "GEO-02", "GEO-17", "GEO-20"]) {
      expect(merged.find((g) => g.id === id)!.lever).toBe("BOTH");
    }
    // A search-only check stays search-only.
    expect(merged.find((g) => g.id === "SEO-04a")!.lever).toBe("SEO");
    // An AI-only check stays AI-only.
    expect(merged.find((g) => g.id === "GEO-18")!.lever).toBe("GEO");
  });

  it("files no check under a channel its registry never scored", () => {
    const seoIds = new Set(SEO_CHECKS.map((d) => d.id));
    const geoIds = new Set(GEO_READINESS_CHECKS.map((d) => d.id));
    const merged = dedupeGapsByRecId([
      ...computeCheckGaps(SEO_CHECKS, failing(SEO_CHECKS), "SEO"),
      ...computeCheckGaps(GEO_READINESS_CHECKS, failing(GEO_READINESS_CHECKS), "GEO"),
    ]);
    for (const gap of merged) {
      if (gap.lever === "SEO") expect(seoIds.has(gap.id)).toBe(true);
      if (gap.lever === "GEO") expect(geoIds.has(gap.id)).toBe(true);
    }
  });
});

describe("duplicate cards across the two registries (QA F11)", () => {
  /** The nine ids that live in both SEO_CHECKS and GEO_READINESS_CHECKS. */
  const SHARED_IDS = ["BOTH-01", "BOTH-02", "BOTH-03", "BOTH-09", "BOTH-16", "GEO-01", "GEO-02", "GEO-17", "GEO-20"];

  it("confirms the nine shared ids are still the duplication source", () => {
    const seo = new Set(SEO_CHECKS.map((d) => d.id));
    const shared = GEO_READINESS_CHECKS.filter((d) => seo.has(d.id)).map((d) => d.id);
    expect(shared.sort()).toEqual([...SHARED_IDS].sort());
  });

  it("emits one card per defect when the model answers both registries", () => {
    // Exactly what the audit prompt asks for: every id from both registries.
    const check = (id: string, bucket: string): SeoGeoCheck => ({
      id, bucket, label: id, evidence: "failing", norm: 0, tier: "MEASURED", confidence: "CONFIRMED",
    });
    const seoChecks = SEO_CHECKS.map((d) => check(d.id, d.bucket));
    const geoChecks = GEO_READINESS_CHECKS.map((d) => check(d.id, d.bucket));
    const raw = [
      ...computeCheckGaps(SEO_CHECKS, seoChecks, "SEO"),
      ...computeCheckGaps(GEO_READINESS_CHECKS, geoChecks, "GEO"),
    ];
    // Before: BOTH-09 (weight 5 vs 2) and GEO-20 (4 vs 7) each produced two rows
    // whose severity chips disagreed.
    expect(raw.filter((g) => g.id === "BOTH-09")).toHaveLength(2);
    expect(new Set(raw.filter((g) => g.id === "GEO-20").map((g) => g.severity)).size).toBe(2);

    const deduped = dedupeGapsByRecId(raw);
    for (const id of SHARED_IDS) expect(deduped.filter((g) => g.id === id)).toHaveLength(1);
    // Survivor keeps the higher lift, so the stronger priority wins.
    expect(deduped.find((g) => g.id === "GEO-20")!.scoreLift).toBe(7);
    expect(deduped.find((g) => g.id === "BOTH-09")!.scoreLift).toBe(5);
  });

  it("never merges per-engine visibility gaps that share a rec-id prefix", () => {
    const gaps = [
      { id: "GEO-11:chatgpt", lever: "GEO", title: "a", severity: "high", evidence: "", confidence: "CONFIRMED", fixAction: "manual", target: "off-site", delivery: "advisory", benchmark: "", measured: "", scoreLift: 3 },
      { id: "GEO-11:gemini", lever: "GEO", title: "b", severity: "high", evidence: "", confidence: "CONFIRMED", fixAction: "manual", target: "off-site", delivery: "advisory", benchmark: "", measured: "", scoreLift: 2 },
    ] as Parameters<typeof dedupeGapsByRecId>[0];
    expect(dedupeGapsByRecId(gaps)).toHaveLength(2);
  });

  it("promotes the survivor's lever to BOTH when the registries disagree", () => {
    const gaps = [
      { id: "GEO-01", lever: "SEO", title: "a", severity: "high", evidence: "", confidence: "CONFIRMED", fixAction: "manual", target: "site-wide", delivery: "agent-direct", benchmark: "", measured: "", scoreLift: 5 },
      { id: "GEO-01", lever: "GEO", title: "a", severity: "high", evidence: "", confidence: "CONFIRMED", fixAction: "manual", target: "site-wide", delivery: "agent-direct", benchmark: "", measured: "", scoreLift: 6 },
    ] as Parameters<typeof dedupeGapsByRecId>[0];
    const [survivor] = dedupeGapsByRecId(gaps);
    expect(survivor.lever).toBe("BOTH");
    expect(survivor.scoreLift).toBe(6);
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

    // SEO-06 maps to plain-English copy (QA Fix 7) and a machine-appliable control.
    const meta = recs.find((r) => r.recId.startsWith("SEO-06"));
    expect(meta?.actionKind).toBe("one_click"); // meta_description is machine-appliable
    expect(meta?.title).toBe("Write the summary that appears under your search result"); // plain-English, no thresholds
    expect(meta?.description.length).toBeGreaterThan(10);
    expect(meta?.owner).toContain("we draft, you approve");
    expect(meta?.targetPlatform).toBe("site");

    const index = recs.find((r) => r.recId.startsWith("GEO-41"));
    expect(index?.actionKind).toBe("connect"); // indexReach → existing-product → connect

    const entity = recs.find((r) => r.recId.startsWith("GEO-25"));
    expect(entity?.actionKind).toBe("guided_manual"); // offsiteEntity → advisory
    expect(entity?.owner).toContain("Advisory");

    // The client-safe shape carries NO internal producer fields (§4) — and no phantom product id.
    for (const r of recs) {
      expect(r).not.toHaveProperty("fixAction");
      expect(r).not.toHaveProperty("delivery");
      expect(r).not.toHaveProperty("confidence");
      expect(r).not.toHaveProperty("evidence");
      expect(r).not.toHaveProperty("productIds");
    }
  });

  it("dedupes by title and caps the plan length", () => {
    const dup: SeoGeoCheck[] = [
      { id: "SEO-02", bucket: "onPage", label: "Title tags", evidence: "a", norm: 0.1, tier: "MEASURED", confidence: "CONFIRMED" },
      { id: "SEO-02", bucket: "onPage", label: "Title tags", evidence: "b", norm: 0.1, tier: "MEASURED", confidence: "CONFIRMED" },
    ];
    const recs = buildRecommendations(computeCheckGaps(SEO_CHECKS, dup, "SEO"), 5);
    expect(recs.filter((r) => r.title === "Tighten your page titles")).toHaveLength(1);
  });

  /**
   * QA F9: an uncovered id used to fall through to `def.label` — the internal
   * registry string — and became the client's card title ("LCP p75 ≤ 2.5s"). This
   * pins the coverage contract so adding a check without copy fails here, not in
   * front of a client.
   */
  it("has plain-English copy for every id in both check registries", () => {
    const uncovered = [...SEO_CHECKS, ...GEO_READINESS_CHECKS]
      .map((d) => d.id)
      .filter((id) => !REC_COPY[id]);
    expect(uncovered).toEqual([]);
  });

  /**
   * CD-J1 directive 5: coverage was already pinned; the BAR was not. Every entry
   * here is read by a client deciding whether to click Approve, and the technical
   * phrasing has a home — the staff-only block on the gap behind the row carries the
   * measured value and benchmark verbatim. These two checks stop a jargon-grade line
   * ("Answer capsules: 40–60 word summary under key H2s") returning through a later
   * addition, which is how the last batch of them arrived.
   */
  it("keeps markup and protocol vocabulary out of client-facing copy", () => {
    const jargon =
      /\b(h1s?|h2s?|canonical|noindex|nosnippet|robots\.txt|alt text|crawlers?|meta description|schema|sitemap dates?|indexation|p75|lcp|cls|inp|answer capsules?)\b/i;
    const offenders = Object.entries(REC_COPY)
      .filter(([, c]) => jargon.test(c.title) || jargon.test(c.description))
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  /**
   * CD-J1 bounce 1: the plan is FROZEN into the snapshot at capture, so every
   * improvement to REC_COPY previously healed only clients measured afterwards. A
   * July-22 snapshot was still serving the exact engineering labels the copy table
   * was written to eliminate. Ids are stable, so re-resolution at render heals every
   * stored snapshot without a re-capture.
   */
  it("re-resolves a frozen registry label to today's plain-English copy", () => {
    // The literal strings the Albert-match walk found rendering on a live client.
    const healed = resolveRecCopy("GEO-02", {
      title: "Answer capsules: 40–60 word summary under key H2s",
      description: "Answer capsules: 40–60 word summary under key H2s",
    });
    expect(healed).toEqual(REC_COPY["GEO-02"]);
    expect(healed.title).not.toContain("40–60");

    expect(resolveRecCopy("SEO-02", { title: "Title tags ≤ 60 chars, unique, keyword-placed" })).toEqual(
      REC_COPY["SEO-02"],
    );
  });

  it("heals a per-engine id through its prefix", () => {
    expect(resolveRecCopy("GEO-27:chatgpt", { title: "whatever was frozen" })).toEqual(
      REC_COPY["GEO-27"],
    );
  });

  it("refuses to hand back an internal label for an id it cannot resolve", () => {
    // Signatures of the pre-F9 fall-through: an exact registry label, or a title
    // echoed verbatim as its own description. Neither may reach a client.
    const asLabel = resolveRecCopy("MODEL-INVENTED-1", {
      title: "Indexable: pages return 200, no noindex/nosnippet",
      description: "something else",
    });
    expect(asLabel.title).toBe("A technical finding your team is reviewing");

    const echoed = resolveRecCopy("MODEL-INVENTED-2", { title: "LCP p75 ≤ 2.5s", description: "LCP p75 ≤ 2.5s" });
    expect(echoed.title).toBe("A technical finding your team is reviewing");

    expect(resolveRecCopy("MODEL-INVENTED-3", {}).title).toBe("A technical finding your team is reviewing");
  });

  it("keeps genuinely plain stored copy for an unknown id", () => {
    // An id we cannot reconstruct, whose stored copy is already client-safe, is
    // left alone — the honest answer rather than a blanket downgrade.
    const stored = { title: "Fix the thing on your pricing page", description: "A plain description." };
    expect(resolveRecCopy("MODEL-INVENTED-4", stored)).toEqual(stored);
  });

  it("keeps numeric thresholds out of client-facing copy", () => {
    // A client cannot act on "under 60 characters" — they are approving that we go
    // and fix it. Counts of things they own ("one headline") are fine; measurement
    // specs are not. Word/character/second budgets and ranges are the tell.
    const spec = /\b\d+\s*(–|-|to)\s*\d+\s*(word|character|char|second|sec|s)\b|\b(under|over|at least|below|above)\s+\d+\s*(word|character|char|%|second)/i;
    const offenders = Object.entries(REC_COPY)
      .filter(([, c]) => spec.test(c.title) || spec.test(c.description))
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  it("never lets a registry label reach a client-facing title or description", () => {
    const labels = new Set([...SEO_CHECKS, ...GEO_READINESS_CHECKS].map((d) => d.label));
    const checks: SeoGeoCheck[] = [...SEO_CHECKS, ...GEO_READINESS_CHECKS].map((d) => ({
      id: d.id,
      bucket: d.bucket,
      label: d.label,
      evidence: "observed this run",
      norm: 0,
      tier: "MEASURED",
      confidence: "CONFIRMED",
    }));
    const gaps = [
      ...computeCheckGaps(SEO_CHECKS, checks, "SEO"),
      ...computeCheckGaps(GEO_READINESS_CHECKS, checks, "GEO"),
    ];
    for (const rec of buildRecommendations(gaps, 999)) {
      expect(labels.has(rec.title)).toBe(false);
      expect(labels.has(rec.description)).toBe(false);
      expect(rec.description.length).toBeGreaterThan(10);
    }
  });

  /** QA F3a: markdown + free-form casing from the audit model, normalized once at
   *  the server boundary so no downstream surface renders raw model formatting. */
  it("normalizes audit-model evidence at the persistence boundary", () => {
    expect(normalizeEvidence("**robots.txt** (fetched today) has _no_ `Disallow` for ClaudeBot")).toBe(
      "Robots.txt (fetched today) has no Disallow for ClaudeBot.",
    );
    expect(normalizeEvidence("- homepage title is 74 chars:  'Acme — the best'")).toBe(
      "Homepage title is 74 chars: 'Acme — the best'",
    );
    expect(normalizeEvidence("## Findings\n\nsitemap returns 404")).toBe("Findings sitemap returns 404.");
    expect(normalizeEvidence("[the sitemap](https://x.com/sitemap.xml) is valid")).toBe(
      "The sitemap is valid.",
    );
    expect(normalizeEvidence("   ")).toBe("");
  });

  it("falls back to neutral copy for an id the model invented, never its own label", () => {
    const invented: SeoGeoCheck[] = [
      { id: "GEO-999", bucket: "extractability", label: "Vibes score above 0.8", evidence: "x", norm: 0, tier: "MEASURED", confidence: "CONFIRMED" },
    ];
    const [rec] = buildRecommendations(computeCheckGaps(GEO_READINESS_CHECKS, invented, "GEO"));
    expect(rec.title).not.toContain("Vibes");
    expect(rec.description).not.toContain("Vibes");
    expect(rec.title).toBe("A technical finding your team is reviewing");
  });
});

describe("brand identity keys (cross-surface matching)", () => {
  it("derives the brand label from subdomain-sectioned hosts, not the section", () => {
    expect(normalizeBrandKey("Walla Tech", "https://tech.walla.co.il")).toBe("walla");
    expect(normalizeBrandKey("Mapstr", "https://en.mapstr.com")).toBe("mapstr");
    expect(normalizeBrandKey("CTech by Calcalist", "https://www.calcalistech.com")).toBe("calcalistech");
  });

  it("returns both name and url keys when they differ, one when they agree", () => {
    expect(brandKeys("CTech by Calcalist", "https://www.calcalistech.com")).toEqual([
      "ctechbycalcalist",
      "calcalistech",
    ]);
    expect(brandKeys("Whop", "https://whop.com")).toEqual(["whop"]);
    expect(brandKeys("Yelp")).toEqual(["yelp"]);
  });

  it("never aliases a brand to its generic subdomain label", () => {
    const g = buildGazetteer("Client", undefined, [
      { company: "Walla Tech", url: "https://tech.walla.co.il" },
    ]);
    expect(g.competitors["Walla Tech"]).toContain("walla");
    expect(g.competitors["Walla Tech"]).not.toContain("tech");
  });
});

describe("countBrandInAnswers", () => {
  it("counts word-boundary mentions per engine, skipping unavailable answers", () => {
    const answers = [
      { engine: "chatgpt" as const, answerText: "Try NewRival for this.", captureTier: "MEASURED" as const },
      { engine: "chatgpt" as const, answerText: "NewRivalish is unrelated.", captureTier: "MEASURED" as const },
      { engine: "gemini" as const, answerText: "newrival.com is popular.", captureTier: "MEASURED" as const },
      { engine: "claude" as const, answerText: "NewRival again", captureTier: "UNAVAILABLE" as const },
    ];
    const counts = countBrandInAnswers(answers, ["NewRival", "newrival.com"]);
    expect(counts.mentions).toBe(2);
    expect(counts.perEngine).toEqual([
      { engine: "chatgpt", mentions: 1 },
      { engine: "gemini", mentions: 1 },
    ]);
  });
});
