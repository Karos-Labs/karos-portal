import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { composeContextDocsFromAgentReports } = await import("../intel/agent-onboarding");
const { coverageLineFor } = await import("@/components/seo-geo/presenter");
const { mapAgentEngineSeoGeoToInsights } = await import("../agent-engine/seo-geo-insights-mapping");

/**
 * The engine's 2026-09-07 report additions: `measuredBasisScore` on each score
 * breakdown and `measuredFacts` on the report. Every portal surface that shows a
 * score must show the coverage and the measured-basis figure beside it — a
 * coverage-weighted score alone reads low for a site that passed everything
 * the audit could see — and the facts travel into the context documents the
 * content agents read.
 */
const CLIENT = { id: "c1", name: "Geektime" };
const INTEL = { overallScore: 71, overallGrade: "B", positioningAnalysis: "Positioning prose.", recommendations: [] };
const SEO_GEO = {
  seoScore: { score: 62, dataCoveragePct: 90.4, measuredBasisScore: 69, inputs: [] },
  geoReadiness: { score: 41, dataCoveragePct: 71, measuredBasisScore: 58, inputs: [] },
  visibility: { byN: { index: 23 } },
  narrative: "The narrative.",
  measuredFacts: ["Technical crawl: 12 of 12 checked URLs answered HTTP 200; robots.txt present; sitemap with 12 entries read.", "No /llms.txt is published."],
  firedRecommendations: [{ recId: "GEO-40", recommendation: "Publish an llms.txt file", fireState: "fail" }],
  promptSet: { prompts: [] },
};

describe("context documents carry the measured facts and the measured-basis score", () => {
  it("market-strategy states coverage and measured-basis next to each score and lists the facts", () => {
    const docs = composeContextDocsFromAgentReports({ client: CLIENT, intelReport: INTEL, seoGeo: SEO_GEO });
    expect(docs["market-strategy"]).toContain("**SEO 62 (90% of checks measured; 69 on the checks that ran) · GEO readiness 41 (71% of checks measured; 58 on the checks that ran) · AI visibility index 23**");
    expect(docs["market-strategy"]).toContain("## Measured site facts\n\n- Technical crawl: 12 of 12 checked URLs answered HTTP 200");
    expect(docs["action-plan"]).toContain("## Measured site facts");
    expect(docs["action-plan"]).toContain("- No /llms.txt is published.");
  });

  it("an older deliverable without the new fields renders exactly the line it always did", () => {
    const docs = composeContextDocsFromAgentReports({
      client: CLIENT,
      intelReport: INTEL,
      seoGeo: { seoScore: { score: 30 }, geoReadiness: { score: 19 }, narrative: "n", firedRecommendations: [], promptSet: { prompts: [] } },
    });
    expect(docs["market-strategy"]).toContain("**SEO 30 · GEO readiness 19**");
    expect(docs["market-strategy"]).not.toContain("Measured site facts");
  });
});

describe("clientSeoGeo carries the measured-basis figures and facts, and the score tile says both halves", () => {
  it("maps the new fields only when the engine reported them", () => {
    const withFields = mapAgentEngineSeoGeoToInsights({
      clientId: "c1",
      clientName: "Geektime",
      clientWebsite: "https://www.geektime.co.il",
      competitors: [],
      report: SEO_GEO,
      cells: undefined,
      capturedAt: 1,
    });
    expect(withFields.seoMeasuredBasisScore).toBe(69);
    expect(withFields.geoReadinessMeasuredBasisScore).toBe(58);
    expect(withFields.measuredFacts).toEqual(SEO_GEO.measuredFacts);

    const legacy = mapAgentEngineSeoGeoToInsights({
      clientId: "c1",
      clientName: "Geektime",
      competitors: [],
      report: { seoScore: { score: 30, dataCoveragePct: 30 }, geoReadiness: { score: 19, dataCoveragePct: 19 } },
      cells: undefined,
      capturedAt: 1,
    });
    expect("seoMeasuredBasisScore" in legacy).toBe(false);
    expect("measuredFacts" in legacy).toBe(false);
  });

  it("coverageLineFor adds the measured-basis half only when there is one and coverage is partial", () => {
    expect(coverageLineFor(90, 69)).toBe("measured 90% of checks · 69/100 on the checks that ran");
    expect(coverageLineFor(90, undefined)).toBe("measured 90% of checks");
    expect(coverageLineFor(90, null)).toBe("measured 90% of checks");
    // At full coverage the two numbers are the same number; at zero there is nothing measured to speak of.
    expect(coverageLineFor(100, 100)).toBe("measured 100% of checks");
    expect(coverageLineFor(0, null)).toBe("measured 0% of checks");
  });
});
