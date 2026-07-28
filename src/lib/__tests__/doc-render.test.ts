import { describe, expect, it } from "vitest";
import {
  isSafeHref,
  looksLikeMarkdown,
  renderAssetBody,
  renderFullDoc,
  renderSectionBody,
  stripInlineMarkdown,
  toPlainSummary,
} from "@/lib/doc-render";

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

/**
 * The calendar's day detail is a client surface fed by whatever the agent wrote.
 * The real photographed leak (2026-07-22) carried four classes at once: markdown
 * syntax, the raw status enum, the lab product code and a job hash.
 */
describe("toPlainSummary", () => {
  const REAL_LEAK = [
    "# Karos X — full draft batch across every avenue (company page + seat)",
    "",
    "status: pending_review · product e13 · 2026-07-22 · job e52ffe1e · draft-only, nothing posted",
    "",
    "This batch drafts **one post in every avenue** for both managed accounts:",
  ].join("\n");

  it("drops the record's bookkeeping line entirely", () => {
    const out = toPlainSummary(REAL_LEAK);
    expect(out).not.toContain("pending_review");
    expect(out).not.toContain("e13");
    expect(out).not.toContain("e52ffe1e");
    expect(out).not.toContain("status:");
  });

  it("keeps the human sentences, without their markdown", () => {
    const out = toPlainSummary(REAL_LEAK);
    expect(out).toContain("Karos X");
    expect(out).toContain("one post in every avenue");
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
  });

  it("flattens bullets, quotes and inline code", () => {
    expect(toPlainSummary("- first\n- second\n> quoted\n`code`")).toBe("first second quoted code");
  });

  it("keeps a literal asterisk in a caption", () => {
    expect(toPlainSummary("5 * 3 = 15")).toBe("5 * 3 = 15");
  });

  it("resolves links to their label", () => {
    expect(toPlainSummary("See [our guide](https://example.com/x) today")).toBe(
      "See our guide today",
    );
  });

  it("truncates on a word boundary with an ellipsis", () => {
    const out = toPlainSummary("alpha bravo charlie delta echo foxtrot", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toContain("delt…");
  });

  it("survives empty and absent content", () => {
    expect(toPlainSummary("")).toBe("");
    expect(toPlainSummary(null)).toBe("");
    expect(toPlainSummary("status: queued")).toBe("");
  });

  /**
   * The same bookkeeping arrives wrapped in whatever markdown the template that
   * wrote it used. Testing the raw line alone missed every one of these: the
   * mark sits between the line start and the key.
   */
  describe("catches the bookkeeping line whatever markdown wraps it", () => {
    const CASES: [string, string][] = [
      ["bold key", "**Status:** pending_review"],
      ["bulleted bold key", "- **Status:** pending_review"],
      ["blockquote", "> status: pending_review"],
      ["heading", "## status: pending_review"],
      ["table row", "| status | pending_review |"],
      ["ordered item", "1. status: pending_review"],
      ["nested bullet + quote", "- > status: pending_review"],
      ["bold product code", "**product:** e13"],
      ["job hash behind a bullet", "- job: e52ffe1e"],
    ];
    for (const [name, line] of CASES) {
      it(name, () => {
        const out = toPlainSummary(`${line}\nThe real sentence.`);
        expect(out).toBe("The real sentence.");
      });
    }
  });

  it("does not eat the prose that follows a wrapped bookkeeping line", () => {
    const out = toPlainSummary(
      "# Weekly batch\n\n- **Status:** pending_review\n- **Product:** e13\n\nThree posts, ready for a look.",
    );
    expect(out).toBe("Weekly batch Three posts, ready for a look.");
  });
});

describe("stripInlineMarkdown", () => {
  it("unwraps paired emphasis but leaves lone marks alone", () => {
    expect(stripInlineMarkdown("**bold** and *italic* and 2 * 3")).toBe("bold and italic and 2 * 3");
  });
});

/**
 * Every case here is markup the client used to read verbatim inside their own
 * strategy documents. The four-hash persona heading is not hypothetical — it is
 * in the shipped Market Strategy template.
 */
describe("renderSectionBody: markup that used to leak", () => {
  it("renders a four-hash heading instead of printing its hashes", () => {
    const html = renderSectionBody("#### Persona name\n\nShe runs ops.");
    expect(html).toContain("Persona name");
    expect(html).not.toContain("#### ");
    expect(html).not.toContain("####");
  });

  it("folds an indented sub-bullet into the list instead of a dash paragraph", () => {
    const html = renderSectionBody("- top level\n  - nested point");
    expect(html).toContain("nested point");
    expect(html).not.toMatch(/<p[^>]*>\s*-\s/);
    expect(html.match(/<ul/g) ?? []).toHaveLength(1);
  });

  it("renders link syntax as a link, not as brackets and a raw address", () => {
    const html = renderSectionBody("See [the source](https://example.com/a).");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain(">the source</a>");
    expect(html).not.toContain("](");
  });

  it("refuses a script-scheme href and leaves it as text", () => {
    const html = renderSectionBody("[click](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });
});

describe("isSafeHref", () => {
  it("accepts web schemes and same-origin targets", () => {
    for (const href of ["https://x.co", "http://x.co", "mailto:a@b.co", "/docs", "/", "#top"]) {
      expect(isSafeHref(href)).toBe(true);
    }
  });

  it("rejects script and data schemes", () => {
    for (const href of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x"]) {
      expect(isSafeHref(href)).toBe(false);
    }
  });

  /**
   * A leading slash does not make a target same-origin: the WHATWG parser
   * resolves both of these to https://evil.com/. Not script execution — a
   * plantable off-site link that reads as an in-document reference, on a
   * surface fed by client-authored corrections and by research fetched from
   * competitor sites.
   */
  it("rejects protocol-relative and backslash-escaped hosts", () => {
    for (const href of ["//evil.com", "/\\evil.com", " //evil.com", "//evil.com/a?b=c"]) {
      expect(isSafeHref(href)).toBe(false);
    }
  });

  it("does not turn a protocol-relative target into a link", () => {
    const html = renderSectionBody("See [our docs](//evil.com).");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });
});
