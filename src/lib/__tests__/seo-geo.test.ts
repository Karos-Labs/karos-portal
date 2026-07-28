import { describe, expect, it } from "vitest";
import {
  GEO_READINESS_CHECKS,
  REC_COPY,
  SEO_CHECKS,
  TARGET_MENTION,
  analyzeAnswer,
  brandKeys,
  buildAnswerGrid,
  buildGazetteer,
  buildRecommendations,
  categoryMetrics,
  classifyIntent,
  countBrandInAnswers,
  dedupeGapsByRecId,
  engineVisibilityScore,
  normalizeBrandKey,
  dedupeNearDuplicates,
  selectByIntentQuota,
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
    expect(meta?.title).toBe("Fix your meta descriptions"); // plain-English, no thresholds
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
