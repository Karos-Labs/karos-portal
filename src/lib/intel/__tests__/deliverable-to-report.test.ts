import { vi, describe, expect, it } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only.
vi.mock("server-only", () => ({}));

const { parsedReportFromDeliverable, rawMarkdownFromDeliverable, INTEL_DIMENSIONS } = await import(
  "../deliverable-to-report"
);

/**
 * The Phase A cutover's load-bearing seam.
 *
 * `runIntelReportPipeline` no longer generates a report; it maps
 * `intel-report-agent`'s deliverable onto `ParsedReport` and hands it to the
 * same `buildClientReport`/`generateReportHtml` that have always stored it. If
 * this mapping is wrong, the failure is a report that renders blank sections —
 * exactly the class of defect SCRUM-274's own six field-path bugs were, and the
 * reason they went unnoticed for a release.
 *
 * The fixture is the same shape `agent-onboarding-cutover.test.ts` uses, which
 * was verified field-by-field against the real wire contract
 * (`packages/tools/karos-intel/src/types.ts`'s `IntelReportOutputSchema`).
 */
const NOW = 1_700_000_000_000;

const DELIVERABLE: Record<string, unknown> = {
  overallScore: 64,
  overallGrade: "C",
  dimensionScores: [
    { dimension: "contentMessaging", score: 60 },
    { dimension: "positioning", score: 55 },
  ],
  swot: {
    strengths: ["Strong docs SEO"],
    weaknesses: ["No comparison content"],
    opportunities: ["Answer-engine visibility gap"],
    threats: ["Two funded entrants closing the gap"],
  },
  recommendations: [{ number: 1, title: "Publish a comparison hub", priority: 1, priorityLabel: "P1", tag: "Content" }],
  competitorRankings: [
    { company: "Rival Co", score: 70, grade: "B", rank: 1, bestDimension: "seo", weakestDimension: "geo" },
  ],
  competitors: [
    { company: "Rival Co", marketTier: "Leader", overlap: "High", deepDive: true, threatLevel: "HIGH" },
    { company: "Second Rival", marketTier: "Niche", overlap: "Low" },
  ],
  brandVoiceRows: [{ dimension: "Formality", scores: { "Fixture Co": "3/5" } }],
  brandVoiceArchetypes: [{ company: "Fixture Co", archetype: "Everyman" }],
  brandVoiceTerritory: "Approachable expert, never condescending.",
  customerSentiment: [{ company: "Fixture Co", rating: "3.9", ratingLabel: "Good" }],
  whitespaceOpportunities: ["Buyer-comparison content"],
  contentAnalysis: "Product pages outrank the blog on every buying term.",
  conversionAnalysis: "Signup flow is the drop-off, not awareness.",
  positioningAnalysis: "Positioned as the developer-first option.",
  growthAnalysis: "Growth is inbound-led with no outbound assist.",
  brandAnalysis: "Consistent voice across docs and site.",
  brandSynchronizationUpdate: "Carry the docs voice into marketing pages verbatim.",
};

describe("parsedReportFromDeliverable", () => {
  it("carries every field the portal stores across, without a markdown round trip", () => {
    const parsed = parsedReportFromDeliverable(DELIVERABLE, { now: NOW });

    expect(parsed.overallScore).toBe(64);
    expect(parsed.overallGrade).toBe("C");
    expect(parsed.contentAnalysis).toBe("Product pages outrank the blog on every buying term.");
    expect(parsed.swot.strengths).toEqual(["Strong docs SEO"]);
    expect(parsed.swot.threats).toEqual(["Two funded entrants closing the gap"]);
    expect(parsed.recommendations).toEqual([
      { number: 1, title: "Publish a comparison hub", description: "", priority: 1, priorityLabel: "P1", tag: "Content" },
    ]);
    expect(parsed.competitorRankings[0]).toMatchObject({ company: "Rival Co", score: 70, rank: 1 });
    expect(parsed.brandVoiceRows).toEqual([{ dimension: "Formality", scores: { "Fixture Co": "3/5" } }]);
    expect(parsed.brandVoiceArchetypes).toEqual([{ company: "Fixture Co", archetype: "Everyman" }]);
    expect(parsed.brandVoiceTerritory).toBe("Approachable expert, never condescending.");
    expect(parsed.customerSentiment).toEqual([{ company: "Fixture Co", rating: "3.9", ratingLabel: "Good" }]);
    expect(parsed.whitespaceOpportunities).toEqual(["Buyer-comparison content"]);
  });

  it("resolves the engine's dimension KEYS to the labels and weights already in Firestore", () => {
    // The engine emits `contentMessaging`; every stored ClientReport says
    // "Content & Messaging", because that is what the legacy prompt's own
    // Dimension Scores table said and what `parseDimensionScores` read out of
    // it. Passing the key straight through would make a new report disagree
    // with every historical one on screen.
    const parsed = parsedReportFromDeliverable(DELIVERABLE, { now: NOW });

    expect(parsed.dimensionScores).toEqual([
      { dimension: "Content & Messaging", weight: 15, score: 60 },
      { dimension: "Competitive Positioning", weight: 15, score: 55 },
    ]);
  });

  it("keeps the eight weights summing to 100, as the scoring methodology requires", () => {
    expect(INTEL_DIMENSIONS.reduce((n, d) => n + d.weight, 0)).toBe(100);
    expect(INTEL_DIMENSIONS).toHaveLength(8);
  });

  it("matches DEFAULT_INTEL_PROMPT's own Dimension Scores table, label and weight", async () => {
    // Otherwise this module's table is only ever checked against itself, and a
    // typo in a label would be asserted rather than caught. `brain.ts` is the
    // rubric every stored report was written against — it no longer executes
    // after the Phase A cutover, but it is still the spec these labels have to
    // agree with, and agent-engine's port is measured against it too
    // (intel-rubric-engine-roster.test.ts reads it for the same reason).
    const { DEFAULT_INTEL_PROMPT } = await import("../brain");

    // Up to the next heading, not the next "---": the table's own separator
    // row (`|-----------|--------|`) contains one and would cut the section
    // off above every data row.
    const section = DEFAULT_INTEL_PROMPT.split("## Dimension Scores")[1]!.split(/^## /m)[0]!;
    const rows = [...section.matchAll(/^\|\s*([^|]+?)\s*\|\s*(\d+)%\s*\|/gm)].map((m) => ({
      label: m[1]!,
      weight: Number(m[2]),
    }));

    expect(rows).toHaveLength(8);
    expect(INTEL_DIMENSIONS.map((d) => ({ label: d.label, weight: d.weight }))).toEqual(rows);
  });

  it("orders dimensions by the fixed table, not by the order the model emitted them", () => {
    const shuffled = {
      ...DELIVERABLE,
      dimensionScores: [
        { dimension: "social", score: 10 },
        { dimension: "contentMessaging", score: 20 },
        { dimension: "seo", score: 30 },
      ],
    };
    const parsed = parsedReportFromDeliverable(shuffled, { now: NOW });

    expect(parsed.dimensionScores.map((d) => d.dimension)).toEqual([
      "Content & Messaging",
      "SEO & Discoverability",
      "Social Media & Community",
    ]);
  });

  it("keeps an unrecognised dimension rather than dropping scored judgment", () => {
    const parsed = parsedReportFromDeliverable(
      { ...DELIVERABLE, dimensionScores: [{ dimension: "accessibility", score: 41, weight: 5 }] },
      { now: NOW },
    );

    expect(parsed.dimensionScores).toEqual([{ dimension: "accessibility", weight: 5, score: 41 }]);
  });

  it("maps competitors into the row shape replaceReportCompetitors writes", () => {
    const parsed = parsedReportFromDeliverable(DELIVERABLE, { now: NOW });

    expect(parsed.competitorRows).toEqual([
      {
        company: "Rival Co",
        marketTier: "Leader",
        overlap: "High",
        deepDive: true,
        threatLevel: "HIGH",
        keyStrengths: [],
        keyWeaknesses: [],
      },
      {
        company: "Second Rival",
        marketTier: "Niche",
        overlap: "Low",
        deepDive: false,
        keyStrengths: [],
        keyWeaknesses: [],
      },
    ]);
  });

  it("refuses to write a tier or overlap the portal's own union does not declare", () => {
    // A drifted engine must not be able to put an unrepresentable literal into
    // Firestore. Neutral member, not a throw: the run has already paid for two
    // agents by the time this executes.
    const parsed = parsedReportFromDeliverable(
      {
        ...DELIVERABLE,
        competitors: [{ company: "Odd Co", marketTier: "Disruptor", overlap: "Total", threatLevel: "SEVERE" }],
      },
      { now: NOW },
    );

    expect(parsed.competitorRows[0]).toMatchObject({ company: "Odd Co", marketTier: "Other", overlap: "Low" });
    expect(parsed.competitorRows[0]).not.toHaveProperty("threatLevel");
  });

  it("drops rows with no company rather than storing an unnamed competitor", () => {
    const parsed = parsedReportFromDeliverable(
      { ...DELIVERABLE, competitors: [{ marketTier: "Leader" }, { company: "Real Co", marketTier: "Niche", overlap: "Low" }] },
      { now: NOW },
    );

    expect(parsed.competitorRows.map((r) => r.company)).toEqual(["Real Co"]);
  });

  it("degrades an empty deliverable to empty fields instead of throwing mid-pipeline", () => {
    const parsed = parsedReportFromDeliverable({}, { now: NOW });

    expect(parsed.overallScore).toBe(0);
    expect(parsed.dimensionScores).toEqual([]);
    expect(parsed.competitorRows).toEqual([]);
    expect(parsed.swot).toEqual({ strengths: [], weaknesses: [], opportunities: [], threats: [] });
    expect(parsed.reportDate).toBe("2023-11-14");
  });

  it("falls back to the client's own website when the model omitted the url", () => {
    const parsed = parsedReportFromDeliverable(DELIVERABLE, { fallbackUrl: "https://fixture.co", now: NOW });
    expect(parsed.url).toBe("https://fixture.co");

    const explicit = parsedReportFromDeliverable(
      { ...DELIVERABLE, url: "https://from-the-model.co" },
      { fallbackUrl: "https://fixture.co", now: NOW },
    );
    expect(explicit.url).toBe("https://from-the-model.co");
  });
});

describe("rawMarkdownFromDeliverable", () => {
  it("renders the same sections the run's reviewable asset shows", () => {
    const markdown = rawMarkdownFromDeliverable(DELIVERABLE);

    expect(markdown).toContain("Product pages outrank the blog on every buying term.");
    expect(markdown).toContain("Strong docs SEO");
    expect(markdown).toContain("Publish a comparison hub");
    expect(markdown.trim()).not.toBe("");
  });
});
