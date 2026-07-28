import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, renderFullDoc } from "@/lib/doc-render";

/**
 * The asset detail modal is the only deliverable viewer a client can reach, so
 * this sniff decides whether they see rendered structure or the verbatim
 * caption. Both directions are load-bearing: a false negative prints machine
 * formatting at a client, a false positive reflows a caption whose line breaks
 * are the content.
 */
describe("looksLikeMarkdown", () => {
  it("is false for plain captions", () => {
    expect(looksLikeMarkdown("Big news today.\n\nWe shipped it. Link in bio 🚀\n#launch #ai")).toBe(false);
    expect(looksLikeMarkdown("New drop —\nout now")).toBe(false);
    expect(looksLikeMarkdown("• point one\n• point two")).toBe(false);
    expect(looksLikeMarkdown("This is *really* good")).toBe(false);
    expect(looksLikeMarkdown("2026. What a year for the team")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
    expect(looksLikeMarkdown(null)).toBe(false);
  });

  it("is true for structured agent deliverables", () => {
    expect(looksLikeMarkdown("# LinkedIn drafts\n\n## Account 1\n\n> the post")).toBe(true);
    expect(looksLikeMarkdown("Here is the plan:\n- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdown("The **hook** carries it")).toBe(true);
    expect(looksLikeMarkdown("Use `npm run dev` first")).toBe(true);
  });
});

describe("renderFullDoc", () => {
  it("escapes source HTML before adding markup", () => {
    const html = renderFullDoc("## Heading\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
