import { vi, describe, it, expect } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only or Firebase
vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn() }));
vi.mock("@/lib/data", () => ({
  getClient: vi.fn(),
  getClientContextDoc: vi.fn(),
  updateClient: vi.fn(),
  upsertClientContextDoc: vi.fn(),
}));

import type { BrandingGuidelines } from "@/lib/types";
import { stripDocPreamble } from "@/lib/doc-render";
import {
  normalizeHex,
  brandingToContextDocContent,
  buildBrandVoiceSection,
  injectBrandVoiceSection,
} from "../branding";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture
// ─────────────────────────────────────────────────────────────────────────────

const fullGuidelines: BrandingGuidelines = {
  primaryAccent: "#ff0000",
  secondaryAccent: "#0000ff",
  brandNeutralDark: "#09090b",
  brandNeutralLight: "#fafafa",
  fontHeading: "Inter",
  fontBody: "Roboto",
  toneKeywords: ["Bold", "Innovative", "Human"],
  visualStyle: "Dark Mode",
  guidelines: "Be bold.\n\nAvoid jargon.",
  updatedAt: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// normalizeHex
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeHex", () => {
  it("expands a 3-digit hex to 6 digits", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("#f0f")).toBe("#ff00ff");
  });

  it("returns a valid 6-digit hex unchanged (lowercased)", () => {
    expect(normalizeHex("#aabbcc")).toBe("#aabbcc");
    expect(normalizeHex("#FF0000")).toBe("#ff0000");
  });

  it("strips alpha channel from 8-digit hex", () => {
    expect(normalizeHex("#aabbccdd")).toBe("#aabbcc");
    expect(normalizeHex("#FF000080")).toBe("#ff0000");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHex("  #abc  ")).toBe("#aabbcc");
  });

  it("is case-insensitive", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#AABBCC")).toBe("#aabbcc");
  });

  it("returns null for invalid inputs", () => {
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#gg0000")).toBeNull();
    expect(normalizeHex("#abcde")).toBeNull(); // 5-digit
    expect(normalizeHex("#ab")).toBeNull();    // 2-digit
    expect(normalizeHex("aabbcc")).toBeNull(); // missing #
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// brandingToContextDocContent
// ─────────────────────────────────────────────────────────────────────────────

describe("brandingToContextDocContent", () => {
  it("includes the client name in the heading", () => {
    const result = brandingToContextDocContent(fullGuidelines, "Acme Corp");
    expect(result).toContain("# Branding Guidelines - Acme Corp");
  });

  it("includes a Color Palette section when colors are present", () => {
    const result = brandingToContextDocContent(fullGuidelines, "Acme");
    expect(result).toContain("## Color Palette");
    expect(result).toContain("**Primary Accent:** #ff0000");
    expect(result).toContain("**Secondary Accent:** #0000ff");
    expect(result).toContain("**Neutral Dark:** #09090b");
    expect(result).toContain("**Neutral Light:** #fafafa");
  });

  it("omits Color Palette when no color fields are set", () => {
    const minimal: BrandingGuidelines = { updatedAt: 0 };
    const result = brandingToContextDocContent(minimal, "Client");
    expect(result).not.toContain("## Color Palette");
  });

  it("includes Typography section when fonts are set", () => {
    const result = brandingToContextDocContent(fullGuidelines, "Acme");
    expect(result).toContain("## Typography");
    expect(result).toContain("**Heading font:** Inter");
    expect(result).toContain("**Body font:** Roboto");
  });

  it("omits Typography section when no fonts are set", () => {
    const noFonts: BrandingGuidelines = { primaryAccent: "#ff0000", updatedAt: 0 };
    const result = brandingToContextDocContent(noFonts, "Client");
    expect(result).not.toContain("## Typography");
  });

  it("includes Tone & Voice section from toneKeywords", () => {
    const result = brandingToContextDocContent(fullGuidelines, "Acme");
    expect(result).toContain("## Tone & Voice");
    expect(result).toContain("Bold, Innovative, Human");
  });

  it("includes Visual Style when set", () => {
    const result = brandingToContextDocContent(fullGuidelines, "Acme");
    expect(result).toContain("## Visual Style");
    expect(result).toContain("Dark Mode");
  });

  it("produces a minimal doc when only updatedAt is provided", () => {
    const result = brandingToContextDocContent({ updatedAt: 0 }, "Empty Client");
    expect(result).toContain("# Branding Guidelines - Empty Client");
    expect(result).not.toContain("##");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildBrandVoiceSection
// ─────────────────────────────────────────────────────────────────────────────

describe("buildBrandVoiceSection", () => {
  it("always wraps output in BRAND_SYNC markers", () => {
    const result = buildBrandVoiceSection(fullGuidelines);
    expect(result).toContain("<!-- BRAND_SYNC_START -->");
    expect(result).toContain("<!-- BRAND_SYNC_END -->");
    expect(result.indexOf("<!-- BRAND_SYNC_START -->")).toBeLessThan(
      result.indexOf("<!-- BRAND_SYNC_END -->"),
    );
  });

  /**
   * This block is injected into a CLIENT-VISIBLE document, so the "edit it in
   * the guidelines UI instead" note is addressed to the wrong reader. It lives
   * in a comment, which every renderer drops, rather than as the italic line it
   * used to be — the same line the client read verbatim next to the sentinel.
   */
  it("keeps its own housekeeping note inside a comment, not on the page", () => {
    const result = buildBrandVoiceSection(fullGuidelines);
    const visible = result.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible).not.toMatch(/auto-synced from the Branding Guidelines UI/i);
    expect(visible).not.toContain("_");
    expect(result).toMatch(/<!--[^>]*overwritten on the next sync/i);
  });

  it("includes primary accent color", () => {
    const result = buildBrandVoiceSection(fullGuidelines);
    expect(result).toContain("**Primary Accent:** #ff0000");
  });

  it("includes visual style", () => {
    const result = buildBrandVoiceSection(fullGuidelines);
    expect(result).toContain("**Visual Style:** Dark Mode");
  });

  it("includes tone keywords joined by comma", () => {
    const result = buildBrandVoiceSection(fullGuidelines);
    expect(result).toContain("**Tone Keywords:** Bold, Innovative, Human");
  });

  it("omits lines for absent optional fields", () => {
    const sparse: BrandingGuidelines = { primaryAccent: "#123456", updatedAt: 0 };
    const result = buildBrandVoiceSection(sparse);
    expect(result).not.toContain("Visual Style");
    expect(result).not.toContain("Tone Keywords");
    expect(result).toContain("**Primary Accent:** #123456");
  });

  it("contains the auto-sync advisory note", () => {
    const result = buildBrandVoiceSection(fullGuidelines);
    expect(result).toContain("auto-synced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// injectBrandVoiceSection
// ─────────────────────────────────────────────────────────────────────────────

describe("injectBrandVoiceSection", () => {
  const newSection =
    "<!-- BRAND_SYNC_START -->\nnew brand voice content\n<!-- BRAND_SYNC_END -->";

  it("replaces an existing BRAND_SYNC block in place", () => {
    const content =
      "intro text\n" +
      "<!-- BRAND_SYNC_START -->\n" +
      "old brand voice content\n" +
      "<!-- BRAND_SYNC_END -->" +
      "\ntrailing text";
    const result = injectBrandVoiceSection(content, newSection);
    expect(result).toContain("new brand voice content");
    expect(result).not.toContain("old brand voice content");
    expect(result).toContain("intro text\n");
    expect(result).toContain("\ntrailing text");
  });

  it("preserves content before and after the replaced block", () => {
    const content =
      "BEFORE\n<!-- BRAND_SYNC_START -->\nold\n<!-- BRAND_SYNC_END -->AFTER";
    const result = injectBrandVoiceSection(content, newSection);
    expect(result.startsWith("BEFORE\n")).toBe(true);
    expect(result.endsWith("AFTER")).toBe(true);
  });

  /**
   * Below the title, not above it. The block opens with a `## ` heading, and a
   * `## ` above the `# ` title puts the title out of reach of
   * stripDocPreamble's title rule, which is anchored at the top of the
   * document. The title then fell into the first section's body and the client
   * read it there, hash mark and all.
   */
  const TITLED_DOC =
    "---\nmodule: brand-voice\n---\n\n# Brand Voice — Acme\n\n## Voice in one line\nWarm.";

  it("inserts after the document title, not above it", () => {
    const result = injectBrandVoiceSection(TITLED_DOC, newSection);
    expect(result.indexOf("# Brand Voice — Acme")).toBeLessThan(
      result.indexOf("<!-- BRAND_SYNC_START -->"),
    );
    expect(result.indexOf("<!-- BRAND_SYNC_END -->")).toBeLessThan(
      result.indexOf("## Voice in one line"),
    );
    expect(result).toContain("Warm.");
  });

  it("leaves the title where the preamble strip can still reach it", () => {
    const clean = stripDocPreamble(injectBrandVoiceSection(TITLED_DOC, newSection));
    expect(clean).not.toContain("Brand Voice — Acme");
    expect(clean).not.toMatch(/^#[ \t]/m); // no H1 left to render as body text
    expect(clean).toContain("Voice in one line");
  });

  it("inserts after YAML frontmatter when present (no existing block)", () => {
    const content = "---\ntitle: Brand Voice\nauthor: Karos\n---\nbody content here";
    const result = injectBrandVoiceSection(content, newSection);
    const frontmatterEnd = result.indexOf("---\n") + 4; // after the closing ---\n
    // The sync block should appear after the frontmatter
    const syncStart = result.indexOf("<!-- BRAND_SYNC_START -->");
    expect(syncStart).toBeGreaterThan(frontmatterEnd - 1);
    expect(result).toContain("new brand voice content");
    expect(result).toContain("body content here");
  });

  it("prepends section when there is no existing block or frontmatter", () => {
    const plain = "plain markdown content with no special markers";
    const result = injectBrandVoiceSection(plain, newSection);
    expect(result.startsWith("<!-- BRAND_SYNC_START -->")).toBe(true);
    expect(result).toContain("plain markdown content");
  });

  it("does not duplicate content when no prior block exists", () => {
    const plain = "existing content";
    const result = injectBrandVoiceSection(plain, newSection);
    const occurrences = (result.match(/existing content/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
