import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderBriefing } from "@/components/ai-insights";

/**
 * The AI Insights briefing is Haiku prose, so what it reaches for changes week
 * to week. The renderer exists precisely so raw markdown never lands on the
 * client's dashboard — QA F126 was single-asterisk emphasis surviving into the
 * page ("Top performers: *Playbook* (4.2 score)") because the split only
 * matched the double form. Modelled on the presenter's leak-guard test: sweep a
 * corpus of plausible outputs and assert no syntax survives.
 */

function html(text: string): string {
  return renderToStaticMarkup(renderBriefing(text) as React.ReactElement);
}

/** Text content only — the markup's own characters (tags, and the numeric
 *  entities React escapes quotes into) aren't a leak. */
function textOf(text: string): string {
  return html(text)
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const CORPUS = [
  "# GEEKTIME - WEEKLY BRIEFING\n\n**Week over week**\n- Engagement up *12%* on Instagram\n",
  "## What's winning\nTop performers: *Playbook* (4.2 score, 6.8% engagement) and *Special Edition*.\n",
  "**Next moves**\n1. Double down on _Playbook_ — it carries the week.\n2. Phase out the *weak* format.\n",
  "### Deeper header\n• A bullet with **bold** and *emphasis* together\n",
  "###### Sixth-level header\n- _underscored emphasis_ mid-sentence works too\n",
  "Plain paragraph with no syntax at all.\n",
  // The follow-up shapes: each one used to leave a delimiter on the page.
  "**Reach is up 40% on *Playbook*, down on the rest**\n",
  "***Special Edition*** carried the week.\n",
  "__Week over week__ the numbers held.\n",
  "- **Winner:** *Playbook* · **Loser:** _Special Edition_\n",
];

describe("AI Insights briefing renderer", () => {
  it("leaves no markdown syntax in the rendered text", () => {
    for (const sample of CORPUS) {
      const rendered = textOf(sample);
      expect(rendered).not.toContain("*");
      expect(rendered).not.toContain("#");
    }
  });

  it("renders single-asterisk emphasis as <em>, not literal asterisks (F126)", () => {
    const out = html("Top performers: *Playbook* (4.2 score) and *Special Edition*.");
    expect(out).toContain("<em");
    expect(out).toContain("Playbook");
    expect(textOf("Top performers: *Playbook*.")).toBe("Top performers: Playbook.");
  });

  it("renders underscore emphasis as <em>", () => {
    expect(html("Double down on _Playbook_.")).toContain("<em");
  });

  it("still renders **bold** as <strong> and doesn't confuse it with emphasis", () => {
    const out = html("**Week over week**");
    expect(out).toContain("<strong");
    expect(out).not.toContain("<em");
    expect(textOf("**Week over week**")).toBe("Week over week");
  });

  it("keeps mixed emphasis in one line intact", () => {
    expect(textOf("A **bold** and an *emphasis* together")).toBe(
      "A bold and an emphasis together",
    );
  });

  it("drops the model's restated title but keeps later headers", () => {
    expect(textOf("# GEEKTIME - WEEKLY BRIEFING\n## What's winning\n")).not.toContain("GEEKTIME");
    expect(textOf("# GEEKTIME - WEEKLY BRIEFING\n## What's winning\n")).toContain("What's winning");
  });

  it("leaves an unpaired asterisk alone rather than eating text", () => {
    expect(textOf("Reach 4 * 3 posts")).toBe("Reach 4 * 3 posts");
  });

  /* ── Verifier follow-up: shapes that still leaked a delimiter ───────── */

  it("renders emphasis nested inside bold without leaking a star", () => {
    const out = html("**Reach is up 40% on *Playbook*, down on the rest**");
    expect(out).toContain("<strong");
    expect(out).toContain("<em");
    expect(textOf("**Reach is up 40% on *Playbook*, down on the rest**")).toBe(
      "Reach is up 40% on Playbook, down on the rest",
    );
  });

  it("renders ***triple*** as bold emphasis, not a stray asterisk", () => {
    const out = html("***Special Edition*** carried the week.");
    expect(out).toContain("<strong");
    expect(out).toContain("<em");
    expect(textOf("***Special Edition*** carried the week.")).toBe(
      "Special Edition carried the week.",
    );
  });

  it("renders __bold__ as bold, not _really bold_", () => {
    const out = html("__Week over week__ the numbers held.");
    expect(out).toContain("<strong");
    expect(textOf("__Week over week__ the numbers held.")).toBe("Week over week the numbers held.");
  });

  it("leaves underscores inside ordinary tokens alone (asset labels)", () => {
    // Asset labels are quoted verbatim into briefings, so a snake_case title is
    // reachable prose — the underscore branch used to eat its middle.
    expect(textOf("Top performer: client_id_value (4.2)")).toBe(
      "Top performer: client_id_value (4.2)",
    );
    expect(textOf("ig_post_2026_07 and li_article_04 both landed")).toBe(
      "ig_post_2026_07 and li_article_04 both landed",
    );
  });

  it("still opens underscore emphasis at a word boundary", () => {
    expect(html("Double down on _Playbook_ this week")).toContain("<em");
    expect(textOf("_Playbook_ led")).toBe("Playbook led");
  });

  it("does not swallow runs of bare delimiters", () => {
    expect(textOf("****")).toBe("****");
    expect(textOf("___")).toBe("___");
    expect(textOf("**")).toBe("**");
  });
});
