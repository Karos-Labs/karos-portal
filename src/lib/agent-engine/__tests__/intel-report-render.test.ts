import { describe, expect, it } from "vitest";
import { renderIntelReport } from "../intel-report-render";

/**
 * [T-B17/SCRUM-270] Unit coverage for the structured renderer in isolation
 * from `materialize.ts`'s own asset-assembly plumbing (that wiring is
 * covered separately by `materialize.test.ts`'s intel-report cases).
 */

/** A realistic, fully-populated deliverable — every field this renderer reads. */
const FULL_DELIVERABLE = {
  overallScore: 78,
  overallGrade: "B+",
  dimensionScores: [
    { dimension: "Content & Messaging", score: 82, weight: 20 },
    { dimension: "SEO & Discoverability", score: 71, weight: 15 },
    { dimension: "Brand & Trust", score: 88, weight: 10 },
  ],
  contentAnalysis: "The content library covers the funnel but leans heavily on generic SaaS language.",
  conversionAnalysis: "The pricing page buries the CTA below the fold on mobile.",
  seoAnalysis: "Technical SEO fundamentals are sound; internal linking is thin.",
  geoAnalysis: "The brand is rarely cited by name in AI answer engines for category prompts.",
  positioningAnalysis: "Positioned as a generalist against two funded category specialists.",
  brandAnalysis: "Visual identity is consistent; voice varies noticeably across channels.",
  growthAnalysis: "Organic acquisition has plateaued for two consecutive quarters.",
  brandSynchronizationUpdate: "Tighten the homepage headline to match the established positioning line.",
  swot: {
    strengths: ["Fast delivery cycle", "Strong customer NPS"],
    weaknesses: ["Thin case-study library"],
    opportunities: ["Category is still naming its leader"],
    threats: ["Two newly-funded entrants", "A platform-level competitor bundling the feature for free"],
  },
  recommendations: [
    { title: "Publish three named case studies", priorityLabel: "Priority 1 — Quick wins", tag: "Content", description: "Close the credibility gap the report flags." },
    { title: "Move the pricing CTA above the fold on mobile", priorityLabel: "Priority 1 — Quick wins", tag: "Conversion" },
    { title: "Run a category-naming campaign", priorityLabel: "Priority 2 — Strategic", tag: "Positioning" },
  ],
};

describe("renderIntelReport — a fully-populated deliverable", () => {
  const result = renderIntelReport(FULL_DELIVERABLE);

  it("titles the asset with the overall grade", () => {
    expect(result.title).toBe("Competitive intelligence report (B+)");
  });

  it("renders a real Overall Assessment heading with the score, grade and a dimension table", () => {
    expect(result.content).toContain("## Overall Assessment");
    expect(result.content).toContain("**Overall score: 78/100 (Grade B+)**");
    expect(result.content).toContain("| Dimension | Score | Weight |");
    expect(result.content).toContain("| Content & Messaging | 82/100 | 20% |");
    expect(result.content).toContain("| Brand & Trust | 88/100 | 10% |");
  });

  it("renders every populated analysis section under its own heading, in order", () => {
    const headings = [
      "## Content & Messaging",
      "## Conversion Optimization",
      "## SEO & Discoverability",
      "## GEO & AI Visibility",
      "## Competitive Positioning",
      "## Brand & Trust",
      "## Growth & Strategy",
      "## Brand Synchronization Update",
    ];
    let cursor = -1;
    for (const heading of headings) {
      const idx = result.content.indexOf(heading);
      expect(idx, `${heading} missing or out of order`).toBeGreaterThan(cursor);
      cursor = idx;
    }
    expect(result.content).toContain("leans heavily on generic SaaS language.");
    expect(result.content).toContain("buries the CTA below the fold on mobile.");
  });

  it("renders all four SWOT arms as their own sub-headings with bullet items", () => {
    expect(result.content).toContain("## SWOT Analysis");
    expect(result.content).toContain("### Strengths\n\n- Fast delivery cycle\n- Strong customer NPS");
    expect(result.content).toContain("### Weaknesses\n\n- Thin case-study library");
    expect(result.content).toContain("### Opportunities\n\n- Category is still naming its leader");
    expect(result.content).toContain("### Threats\n\n- Two newly-funded entrants\n- A platform-level competitor bundling the feature for free");
  });

  it("groups recommendations by priority label and numbers them within each group", () => {
    expect(result.content).toContain("## Recommendations");
    expect(result.content).toContain("### Priority 1 — Quick wins");
    expect(result.content).toContain("1. **Publish three named case studies** [Content]\n   Close the credibility gap the report flags.");
    expect(result.content).toContain("2. **Move the pricing CTA above the fold on mobile** [Conversion]");
    expect(result.content).toContain("### Priority 2 — Strategic");
    expect(result.content).toContain("1. **Run a category-naming campaign** [Positioning]");
  });
});

describe("renderIntelReport — graceful degradation", () => {
  it("an entirely empty deliverable renders to an empty string, no headings at all", () => {
    const result = renderIntelReport({});
    expect(result.content).toBe("");
    expect(result.title).toBe("Competitive intelligence report");
  });

  it("omits the Overall Assessment heading entirely when neither a score nor any dimension is present", () => {
    const result = renderIntelReport({ contentAnalysis: "Some text." });
    expect(result.content).not.toContain("## Overall Assessment");
    expect(result.content).toContain("## Content & Messaging");
  });

  it("still shows a dimension table under Overall Assessment when the score itself is missing", () => {
    const result = renderIntelReport({ dimensionScores: [{ dimension: "Content", score: 60 }] });
    expect(result.content).toContain("## Overall Assessment");
    expect(result.content).not.toContain("Overall score:");
    expect(result.content).toContain("| Content | 60/100 |");
  });

  it("drops a malformed dimension row (no score) without dropping the well-formed ones", () => {
    const result = renderIntelReport({
      dimensionScores: [{ dimension: "Content", score: "not-a-number" }, { dimension: "SEO", score: 70 }],
    });
    expect(result.content).toContain("| SEO | 70/100 |");
    expect(result.content).not.toContain("| Content |");
  });

  it("omits the dimension table's Weight column when no row carries a weight", () => {
    const result = renderIntelReport({ dimensionScores: [{ dimension: "Content", score: 60 }] });
    expect(result.content).toContain("| Dimension | Score |\n|---|---|");
    expect(result.content).not.toContain("Weight");
  });

  it("omits the SWOT heading entirely when every arm is empty or absent", () => {
    const result = renderIntelReport({ swot: { strengths: [], weaknesses: [] } });
    expect(result.content).not.toContain("SWOT");
  });

  it("omits the SWOT heading when `swot` itself is missing", () => {
    const result = renderIntelReport({ contentAnalysis: "Text." });
    expect(result.content).not.toContain("SWOT");
  });

  it("omits the Recommendations heading entirely when the array is empty or absent", () => {
    expect(renderIntelReport({ recommendations: [] }).content).not.toContain("Recommendations");
    expect(renderIntelReport({}).content).not.toContain("Recommendations");
  });

  it("drops a recommendation with no title-bearing field at all, keeping the rest", () => {
    const result = renderIntelReport({
      recommendations: [{ score: 5 }, { title: "A real recommendation" }],
    });
    expect(result.content).toContain("A real recommendation");
    // Only one survived, so the group renders unlabeled (no redundant single sub-heading).
    expect(result.content).not.toContain("###");
  });

  it("falls back to an id as the title when nothing else is present, rather than dropping the record", () => {
    const result = renderIntelReport({ recommendations: [{ id: "REC-7" }] });
    expect(result.content).toContain("**REC-7**");
  });

  it("groups recommendations with no priority information at all into one unlabeled section", () => {
    const result = renderIntelReport({
      recommendations: [{ title: "First" }, { title: "Second" }],
    });
    expect(result.content).toContain("## Recommendations");
    expect(result.content).not.toContain("###");
    expect(result.content).toContain("1. **First**");
    expect(result.content).toContain("2. **Second**");
  });

  it("falls back to a numeric `Priority N` label when the deliverable has a priority number but no label", () => {
    const result = renderIntelReport({
      recommendations: [
        { title: "First", priority: 1 },
        { title: "Second", priority: 2 },
      ],
    });
    expect(result.content).toContain("### Priority 1");
    expect(result.content).toContain("### Priority 2");
  });

  it("never crashes on a deliverable whose fields are the wrong type entirely", () => {
    expect(() =>
      renderIntelReport({
        overallScore: "not-a-number",
        dimensionScores: "not-an-array",
        swot: "not-an-object",
        recommendations: [null, 42, { title: 123 }],
        contentAnalysis: 999,
      } as unknown as Record<string, unknown>),
    ).not.toThrow();
  });
});
