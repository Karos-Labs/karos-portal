import { vi, describe, expect, it } from "vitest";

vi.mock("server-only", () => ({}));

const { mapAgentEngineSeoGeoToInsights } = await import("../seo-geo-insights-mapping");

/**
 * The portal files `brand` and `navigational` prompts under "When buyers ask
 * about you by name" and excludes them from the competitor comparison. On prep
 * (2026-09-06) that heading listed "How do I find a good AI Digital Marketing
 * provider near me?" — an engine template labelled `navigational` that named
 * nobody. A label is a claim about the text; the text is here to check.
 */
describe("asPromptIntent — a branded label must be supported by the text", () => {
  function insightsFor(prompts: Array<{ promptText: string; intentType: string }>) {
    return mapAgentEngineSeoGeoToInsights({
      clientId: "c1",
      clientName: "Karos Labs",
      clientWebsite: "https://karoslabs.com",
      competitors: [{ company: "Rivalco" }],
      report: { promptSet: { prompts: prompts.map((p, i) => ({ promptId: `p${i + 1}`, ...p })) } } as never,
      cells: undefined,
      capturedAt: 1_700_000_000_000,
    });
  }

  it("keeps a brand label when the prompt names the client", () => {
    const out = insightsFor([{ promptText: "What is Karos Labs, and what do they do?", intentType: "brand" }]);
    expect(out.intentPrompts[0]).toMatchObject({ intent: "brand" });
  });

  it("keeps a navigational label when the prompt names the client's domain", () => {
    const out = insightsFor([{ promptText: "Is karoslabs.com the official site?", intentType: "navigational" }]);
    expect(out.intentPrompts[0]).toMatchObject({ intent: "navigational" });
  });

  it("reclassifies a branded label the text does not support — the prep defect", () => {
    const out = insightsFor([
      { promptText: "How do I find a good AI Digital Marketing provider near me?", intentType: "navigational" },
      { promptText: "Which AI Digital Marketing brand is most often recommended by industry analysts?", intentType: "brand" },
    ]);
    for (const row of out.intentPrompts) {
      expect(["brand", "navigational"], row.prompt).not.toContain(row.intent);
    }
  });

  it("still honours a category label as given", () => {
    const out = insightsFor([{ promptText: "What are the best AI Digital Marketing companies to work with in 2026?", intentType: "discovery" }]);
    expect(out.intentPrompts[0]).toMatchObject({ intent: "discovery" });
  });

  it("counts four engines — Copilot is accepted but not captured", () => {
    const out = insightsFor([]);
    expect(out.perEngine.map((e) => e.engine)).toEqual(["chatgpt", "perplexity", "gemini", "claude"]);
    expect(out.geoVisibilityEnginesTotal).toBe(4);
  });
});
