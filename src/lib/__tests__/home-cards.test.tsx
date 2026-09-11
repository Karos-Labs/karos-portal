import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeKpisWidget } from "@/components/home-kpis";
import { HomeStandingWidget } from "@/components/home-standing";
import type { PresenceTile, PresenceView, ScoreView } from "@/components/seo-geo/presenter";
import { THROUGHPUT_WINDOW_DAYS } from "@/lib/content-throughput";

/**
 * Two Home cards, after Albert's 2026-09-11 pass: the lone Published number is
 * a strip rather than a tile that "takes the whole screen", and the SEO card
 * draws the Reporting tab's own tiles, so the two screens quoting one snapshot
 * look the same and the details stay on the report.
 */

function tile(heading: string, pctLabel: string | null): PresenceTile {
  return {
    heading,
    caption: "questions that don't mention your name",
    fractionLine: pctLabel ? "Named in 3 of 16" : null,
    pct: pctLabel ? 19 : null,
    pctLabel,
    explainer: "Questions buyers ask before they know you exist.",
    emptyLine: pctLabel ? null : "No category questions were measured this run.",
    detail: { title: "How we measured this", lines: ["We asked 16 questions.", "3 named you."] },
  };
}

const PRESENCE: PresenceView = {
  brand: tile("When buyers ask about you by name", "100%"),
  category: tile("When buyers ask about your category", "19%"),
  takeaway: "Engines know who you are, but you're missing from the questions new customers ask.",
  rosterShare: { value: "23%", pct: 23, caption: "of every brand mention across you and the 5 competitors we track", explainer: "Category questions only." },
};

const SCORE: ScoreView = {
  key: "visibility",
  label: "AI visibility today",
  explainer: "How often AI assistants name you.",
  value: 19,
  tone: "danger",
  bandLabel: "needs attention",
  coveragePct: 80,
  coverageLine: "based on 4 of 5 AI engines",
  breakdownTitle: "What's behind this score",
  breakdown: [{ label: "ChatGPT", pct: 20, note: null }],
};

describe("Home's SEO & AI visibility card", () => {
  const html = renderToStaticMarkup(
    <HomeStandingWidget
      presence={PRESENCE}
      href="/clients/c1/settings?tab=reporting"
      competitorsHref="/clients/c1/settings?tab=competitors"
      visibilityScore={SCORE}
    />,
  );

  it("draws the report's three readings, in the report's words", () => {
    expect(html).toContain("AI visibility today");
    expect(html).toContain("needs attention");
    expect(html).toContain("based on 4 of 5 AI engines");
    expect(html).toContain("When buyers ask about your category");
    expect(html).toContain("Your share of the conversation");
    expect(html).toContain("23%");
  });

  it("keeps the details on the report: no popover, no breakdown, one link", () => {
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("What&#x27;s behind this score");
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
    expect(html).toContain("Open the full report");
  });
});

describe("Home's Your numbers card", () => {
  const throughput = {
    count: 0,
    previousCount: 3,
    deltaPct: -100,
    daily: Array.from({ length: THROUGHPUT_WINDOW_DAYS }, () => 0),
  };

  it("draws a lone Published number as a strip, not a tile", () => {
    const html = renderToStaticMarkup(
      <HomeKpisWidget throughput={throughput} contentHref="/clients/c1/calendar?view=archive" />,
    );
    expect(html).toContain(`Published · ${THROUGHPUT_WINDOW_DAYS} days`);
    expect(html).toContain("flex flex-wrap items-center");
    expect(html).not.toContain("text-3xl");
    expect(html).not.toContain("Total followers");
  });

  it("keeps the tile beside a followers cell", () => {
    const html = renderToStaticMarkup(
      <HomeKpisWidget
        throughput={throughput}
        contentHref="/clients/c1/calendar?view=archive"
        audienceTotal={1200}
        audienceGrowthPct={2.5}
        audienceSeries={[{ at: 1, count: 1100 }, { at: 2, count: 1200 }] as never}
        audienceHref="/clients/c1/settings?tab=reporting"
      />,
    );
    expect(html).toContain("Total followers");
    expect(html.match(/text-3xl/g) ?? []).toHaveLength(2);
  });
});
