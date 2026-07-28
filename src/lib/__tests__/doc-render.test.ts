import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, renderAssetBody, renderFullDoc } from "@/lib/doc-render";

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

  it("still drops the context doc's frontmatter and H1 title", () => {
    const html = renderFullDoc("---\nmodule: brand\n---\n# Brand guide\n\nBody one.");
    expect(html).not.toContain("module: brand");
    expect(html).not.toContain("Brand guide");
    expect(html).toContain("Body one.");
  });
});

/**
 * renderAssetBody must destroy nothing: asset content is the agent's own
 * output, where the first line is the deliverable's headline and a leading
 * `---` separates drafts. Each case below is a verified way the context-doc
 * entry point silently swallowed client-facing content.
 */
describe("renderAssetBody", () => {
  it("keeps a leading H1 and renders it as a heading", () => {
    const html = renderAssetBody("# Weekly recap\n\nBody one.");
    expect(html).toContain("Weekly recap");
    expect(html).toContain("Body one.");
    expect(html).not.toContain("# Weekly recap");
  });

  it("keeps content that opens with a horizontal rule", () => {
    const html = renderAssetBody("---\nDraft 1 text\n---\nDraft 2 text");
    expect(html).toContain("Draft 1 text");
    expect(html).toContain("Draft 2 text");
    expect(html).toContain("<hr");
  });

  it("renders blockquotes as quotes, not as arrows on screen", () => {
    const html = renderAssetBody("## Account 1\n\n> the reply text");
    expect(html).toContain("<blockquote");
    expect(html).toContain("the reply text");
    expect(html).not.toContain("&gt; the reply");
  });

  it("renders every heading level's text without its hashes", () => {
    const html = renderAssetBody("# One\n\n## Two\n\n### Three\n\nBody.");
    for (const word of ["One", "Two", "Three", "Body."]) expect(html).toContain(word);
    expect(html).not.toMatch(/#{1,3}\s/);
  });

  it("escapes source HTML before adding markup", () => {
    const html = renderAssetBody("# Title\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
