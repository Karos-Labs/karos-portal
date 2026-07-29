import { describe, it, expect, vi, beforeEach } from "vitest";
import { stripPreamble, stripTrailingMetaCommentary, escapeHtml } from "../text-utils";

/**
 * Regression suite for the 2026-07 fleet document corruption.
 *
 * stripPreamble used to search the WHOLE string for a `---` line and slice to
 * it, so a horizontal rule in the document body was mistaken for the closing
 * frontmatter fence and every section above it was deleted. Every client-tier
 * doc in the fleet opened mid-document with its first `##` section missing.
 * The condense retry guard then detected the missing section and re-ran the
 * identical call, so the corruption was deterministic rather than flaky.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The exact fleet symptom: no frontmatter, a body `---` rule after a short first section. */
const BODY_RULE_DOC = [
  "## ICP Persona Profile",
  "",
  "**Primary ICP: Growth Lead at Series-B SaaS**",
  "",
  "Judged on pipeline contribution.",
  "",
  "---",
  "",
  "### Secondary ICP: Ops Manager",
  "",
  "Runs the tooling budget.",
  "",
  "## Tech Stack & Current Solutions",
  "",
  "Named products only.",
].join("\n");

/** Frontmatter plus body `---` rules — the shape the condense prompt asks for. */
const FRONTMATTER_DOC = [
  "---",
  "module: target-audience",
  "client: acme",
  "status: published",
  "sources: []",
  "consumed_by: [e10, e13]",
  "---",
  "",
  "# Target Audience — Acme",
  "",
  "> DEFINITIVE ICP BLUEPRINT. Read this before writing a word.",
  "",
  "## ICP Persona Profile",
  "",
  "Primary ICP text.",
  "",
  "---",
  "",
  "## Tech Stack",
  "",
  "Stack text.",
  "",
  "---",
  "",
  "## Content Engagement Patterns",
  "",
  "Channel text.",
].join("\n");

describe("stripPreamble — frontmatter detection", () => {
  it("keeps the first ## section when a body --- rule follows it (fleet symptom)", () => {
    const out = stripPreamble(BODY_RULE_DOC);
    expect(out.split("\n")[0]).toBe("## ICP Persona Profile");
    expect(out).toContain("## ICP Persona Profile");
    expect(out).toContain("**Primary ICP: Growth Lead at Series-B SaaS**");
    expect(out).toContain("Judged on pipeline contribution.");
    // Nothing at all should be removed from a doc with no preamble.
    expect(out).toBe(BODY_RULE_DOC);
  });

  it("strips real frontmatter while keeping every section around body --- rules", () => {
    const out = stripPreamble(FRONTMATTER_DOC);
    expect(out.split("\n")[0]).toBe("## ICP Persona Profile");
    expect(out).toContain("## ICP Persona Profile");
    expect(out).toContain("## Tech Stack");
    expect(out).toContain("## Content Engagement Patterns");
    // Frontmatter, H1 and the instruction blockquote are gone.
    expect(out).not.toContain("module: target-audience");
    expect(out).not.toContain("# Target Audience");
    expect(out).not.toContain("DEFINITIVE ICP BLUEPRINT");
    // Body rules survive as content.
    expect(out.match(/^---$/gm)).toHaveLength(2);
  });

  it("handles a document that opens directly with a ## heading", () => {
    const doc = "## Voice in one line\n\nA smart, trustworthy friend.\n\n## Persona\n\nWho speaks.";
    expect(stripPreamble(doc)).toBe(doc);
  });

  it("handles a document with no frontmatter and no rules at all", () => {
    const doc = "## Only Section\n\nBody text.";
    expect(stripPreamble(doc)).toBe(doc);
  });

  it("handles CRLF frontmatter followed by a CRLF body rule", () => {
    const doc = [
      "---",
      "module: brand-voice",
      "status: published",
      "---",
      "",
      "## Voice in one line",
      "",
      "Short.",
      "",
      "---",
      "",
      "## Five voice adjectives",
      "",
      "Bold.",
    ].join("\r\n");
    const out = stripPreamble(doc);
    expect(out.split(/\r?\n/)[0]).toBe("## Voice in one line");
    expect(out).toContain("## Voice in one line");
    expect(out).toContain("## Five voice adjectives");
    expect(out).not.toContain("module: brand-voice");
  });

  it("tolerates leading blank lines before the frontmatter", () => {
    const doc = "\n\n---\nmodule: brand-voice\n---\n\n## Voice in one line\n\nShort.";
    const out = stripPreamble(doc);
    expect(out).toBe("## Voice in one line\n\nShort.");
  });

  it("does not treat a prose block between two --- rules as frontmatter", () => {
    // A doc that opens with a horizontal rule: only the rule line goes, never content.
    const doc = "---\n\n## First Section\n\nBody.\n\n---\n\n## Second Section\n\nMore.";
    const out = stripPreamble(doc);
    expect(out).toContain("## First Section");
    expect(out).toContain("## Second Section");
    expect(out).toContain("Body.");
  });

  it("leaves an unterminated frontmatter block's content in place", () => {
    const doc = "---\nmodule: brand-voice\nstatus: published\n\n## Voice in one line\n\nShort.";
    const out = stripPreamble(doc);
    expect(out).toContain("## Voice in one line");
    expect(out).toContain("Short.");
  });
});

describe("stripPreamble — H1, blockquote and code fences", () => {
  it("strips a leading H1 title but keeps ## section headings", () => {
    const doc = "# Brand Voice — Acme\n\n## Voice in one line\n\nShort.";
    expect(stripPreamble(doc)).toBe("## Voice in one line\n\nShort.");
  });

  it("does not delete an H1-looking hashtag line inside the body", () => {
    const doc = "## Social Voice\n\nUse these tags.\n\n#AcmeGrowth is the campaign tag.\n\n## Next";
    const out = stripPreamble(doc);
    expect(out).toContain("#AcmeGrowth is the campaign tag.");
    expect(out).toBe(doc);
  });

  it("strips leading instruction blockquotes", () => {
    const doc = "> HOW the brand speaks.\n> Words only.\n\n## Voice in one line\n\nShort.";
    expect(stripPreamble(doc)).toBe("## Voice in one line\n\nShort.");
  });

  it("unwraps a whole-document code fence", () => {
    const doc = "```markdown\n## Voice in one line\n\nShort.\n```";
    expect(stripPreamble(doc)).toBe("## Voice in one line\n\nShort.");
  });

  it("unwraps a fence preceded by a one-line prose preamble", () => {
    const doc = "Here is the condensed document:\n\n```markdown\n## Voice in one line\n\nShort.\n```";
    expect(stripPreamble(doc)).toBe("## Voice in one line\n\nShort.");
  });

  it("leaves a document that opens with a real code block intact", () => {
    const doc = '```json\n{"@type":"Organization"}\n```\n\n## Schema Notes\n\nUse it site-wide.';
    expect(stripPreamble(doc)).toBe(doc);
  });

  it("does not slice to a code fence inside the document body", () => {
    const doc = [
      "## Schema Markup",
      "",
      "Use this snippet.",
      "",
      "```json",
      '{"@type":"Organization"}',
      "```",
      "",
      "## Next Section",
      "",
      "Body.",
    ].join("\n");
    const out = stripPreamble(doc);
    expect(out.split("\n")[0]).toBe("## Schema Markup");
    expect(out).toContain("## Schema Markup");
    expect(out).toContain("## Next Section");
    expect(out).toBe(doc);
  });
});

describe("stripPreamble — idempotence (retry must not double-strip)", () => {
  const cases: Record<string, string> = {
    "fleet symptom doc": BODY_RULE_DOC,
    "frontmatter doc": FRONTMATTER_DOC,
    "fenced doc": "```markdown\n## A\n\nBody.\n\n---\n\n## B\n\nMore.\n```",
    "h1 doc": "# Title\n\n## A\n\nBody.\n\n---\n\n## B\n\nMore.",
    "blockquote doc": "> Instructions.\n\n## A\n\nBody.\n\n---\n\n## B",
  };

  for (const [name, doc] of Object.entries(cases)) {
    it(`is idempotent for the ${name}`, () => {
      const once = stripPreamble(doc);
      expect(stripPreamble(once)).toBe(once);
      expect(stripPreamble(stripPreamble(once))).toBe(once);
    });
  }

  it("empty and whitespace-only input stay empty", () => {
    expect(stripPreamble("")).toBe("");
    expect(stripPreamble("   \n\n  ")).toBe("");
  });
});

describe("stripTrailingMetaCommentary", () => {
  const DOC = "## Voice in one line\n\nA smart friend.\n\n## Persona\n\nWho speaks.";

  it("removes a trailing 'the document is complete' note", () => {
    const out = stripTrailingMetaCommentary(
      `${DOC}\n\nThe document is complete as written. No sections were dropped.`,
    );
    expect(out).toBe(DOC);
  });

  it("removes a trailing 'if you intended a different template' note", () => {
    const out = stripTrailingMetaCommentary(
      `${DOC}\n\nIf you intended a different template, let me know and I will redo it.`,
    );
    expect(out).toBe(DOC);
  });

  it("removes two stacked commentary paragraphs and the separator rule above them", () => {
    const out = stripTrailingMetaCommentary(
      `${DOC}\n\n---\n\nThe document is complete as written.\n\nIf you intended a different template, tell me.`,
    );
    expect(out).toBe(DOC);
  });

  it("removes an italicised note wrapper", () => {
    const out = stripTrailingMetaCommentary(
      `${DOC}\n\n*Note: The document is complete as written.*`,
    );
    expect(out).toBe(DOC);
  });

  it("removes a first-person model self-report", () => {
    const out = stripTrailingMetaCommentary(
      `${DOC}\n\nI have condensed each section to roughly half its original length.`,
    );
    expect(out).toBe(DOC);
  });

  it("keeps a legitimate closing section", () => {
    const doc = `${DOC}\n\n## Measurement\n\nTrack reply rate weekly.`;
    expect(stripTrailingMetaCommentary(doc)).toBe(doc);
  });

  it("keeps a closing paragraph that merely mentions the document", () => {
    const doc = `${DOC}\n\nThis document governs every caption the brand publishes.`;
    expect(stripTrailingMetaCommentary(doc)).toBe(doc);
  });

  it("keeps a trailing table, list and blockquote", () => {
    const table = `${DOC}\n\n| Platform | Tone |\n|---|---|\n| Instagram | Warm |`;
    expect(stripTrailingMetaCommentary(table)).toBe(table);
    const list = `${DOC}\n\n- Never use em dashes.\n- Always name the product.`;
    expect(stripTrailingMetaCommentary(list)).toBe(list);
    const quote = `${DOC}\n\n> Let me know if this lands.`;
    expect(stripTrailingMetaCommentary(quote)).toBe(quote);
  });

  it("keeps a long trailing paragraph even if it opens like commentary", () => {
    const long = `${DOC}\n\nThe document is complete ${"and every section carries the client's own language rather than generic marketing filler. ".repeat(8)}`;
    expect(stripTrailingMetaCommentary(long).length).toBeGreaterThan(DOC.length);
  });

  it("never empties a document that is nothing but commentary", () => {
    const only = "The document is complete as written.";
    expect(stripTrailingMetaCommentary(only)).toBe(only);
  });

  it("is idempotent", () => {
    const once = stripTrailingMetaCommentary(
      `${DOC}\n\nThe document is complete as written.\n\nLet me know if you want changes.`,
    );
    expect(stripTrailingMetaCommentary(once)).toBe(once);
  });
});

describe("escapeHtml", () => {
  it("escapes the four dangerous characters", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("renders null and undefined as an empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Condensation boundary — the pipeline surface that corrupted the fleet
// ---------------------------------------------------------------------------

const streamCalls: string[] = [];
let queuedOutputs: string[] = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/intel/brain", () => ({ CONDENSATION_RULES: "rules" }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: (m: string) => m }));
vi.mock("@/services/logger", () => ({ logger: { trackStream: () => {} } }));
vi.mock("ai", () => ({
  streamText: (opts: { messages: { content: string }[] }) => {
    streamCalls.push(opts.messages.map((m) => m.content).join("\n"));
    const next = queuedOutputs.shift() ?? "";
    return { text: Promise.resolve(next) };
  },
}));

const { condenseDocs } = await import("../intel/condense");

const CLIENT = { id: "acme", name: "Acme" } as never;

describe("condenseDocs — fleet corruption regression", () => {
  beforeEach(() => {
    streamCalls.length = 0;
    queuedOutputs = [];
  });

  it("stores the model's first ## section when the doc has body --- rules", async () => {
    queuedOutputs = [BODY_RULE_DOC];
    const [doc] = await condenseDocs(
      CLIENT,
      ["target-audience"] as never,
      { "target-audience": BODY_RULE_DOC },
      "rules",
    );
    expect(doc.content.split("\n")[0]).toBe("## ICP Persona Profile");
    expect(doc.content).toContain("## ICP Persona Profile");
    expect(doc.content).toContain("## Tech Stack & Current Solutions");
    // One call only: the guard has nothing to retry because nothing was eaten.
    expect(streamCalls).toHaveLength(1);
  });

  it("scrubs trailing meta-commentary from the stored client doc", async () => {
    queuedOutputs = [
      `${BODY_RULE_DOC}\n\n---\n\nThe document is complete as written. If you intended a different template, let me know.`,
    ];
    const [doc] = await condenseDocs(
      CLIENT,
      ["target-audience"] as never,
      { "target-audience": BODY_RULE_DOC },
      "rules",
    );
    expect(doc.content).not.toContain("The document is complete as written");
    expect(doc.content).not.toContain("If you intended a different template");
    expect(doc.content).toContain("## ICP Persona Profile");
    expect(doc.content).toContain("## Tech Stack & Current Solutions");
    expect(streamCalls).toHaveLength(1);
  });

  it("does not double-strip on the retry path", async () => {
    // First pass genuinely drops the last section, so the guard fires.
    const truncated = "## ICP Persona Profile\n\nPrimary ICP.\n\n---\n\n### Secondary ICP: Ops";
    queuedOutputs = [truncated, BODY_RULE_DOC];
    const [doc] = await condenseDocs(
      CLIENT,
      ["target-audience"] as never,
      { "target-audience": BODY_RULE_DOC },
      "rules",
    );
    expect(streamCalls).toHaveLength(2);
    // The retry result is stripped exactly once — first section still present.
    expect(doc.content.split("\n")[0]).toBe("## ICP Persona Profile");
    expect(doc.content).toBe(BODY_RULE_DOC);
  });

  it("keeps the first-pass result when the retry covers fewer sections", async () => {
    const firstPass = "## ICP Persona Profile\n\nPrimary ICP.\n\n---\n\n### Secondary ICP: Ops";
    // Covers none of the internal doc's ## headings — strictly worse.
    const worseRetry = "### Secondary ICP: Ops\n\nOnly a fragment.";
    queuedOutputs = [firstPass, worseRetry];
    const [doc] = await condenseDocs(
      CLIENT,
      ["target-audience"] as never,
      { "target-audience": BODY_RULE_DOC },
      "rules",
    );
    expect(streamCalls).toHaveLength(2);
    expect(doc.content).toBe(firstPass);
  });

  it("returns empty content for an empty internal doc without calling the model", async () => {
    const [doc] = await condenseDocs(CLIENT, ["target-audience"] as never, {}, "rules");
    expect(doc.content).toBe("");
    expect(streamCalls).toHaveLength(0);
  });
});
