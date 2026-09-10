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

import type { BrandColor, BrandingGuidelines } from "@/lib/types";
import { stripDocPreamble } from "@/lib/doc-render";
import {
  normalizeHex,
  brandingToContextDocContent,
  buildBrandVoiceSection,
  injectBrandVoiceSection,
  classifyColorRole,
  resolveDominantColorsByRole,
  effectivePrimaryAccent,
  effectiveSecondaryAccent,
  effectiveNeutralDark,
  effectiveNeutralLight,
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

// ─────────────────────────────────────────────────────────────────────────────
// classifyColorRole / resolveDominantColorsByRole (SCRUM-394 / IGSTYLE-9)
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyColorRole", () => {
  it("classifies neutral role text", () => {
    expect(classifyColorRole("Page ground across the storefront")).toBe("neutral");
    expect(classifyColorRole("Warm cream page surface")).toBe("neutral");
    expect(classifyColorRole("Brand base — logo mark, headings, dark panels")).toBe("neutral");
    expect(classifyColorRole("Ink — all body copy and headings")).toBe("neutral");
    expect(classifyColorRole("Wordmark")).toBe("neutral");
    expect(classifyColorRole("Canvas background")).toBe("neutral");
  });

  it("classifies accent role text", () => {
    expect(classifyColorRole("Sale callouts, badges, CTA highlights")).toBe("accent");
    expect(classifyColorRole("Primary CTA and interactive accent")).toBe("accent");
    expect(classifyColorRole("Acai purple brand signature")).toBe("accent");
  });

  it("returns unclassified for absent or unrecognized role text", () => {
    expect(classifyColorRole(undefined)).toBe("unclassified");
    expect(classifyColorRole("")).toBe("unclassified");
    expect(classifyColorRole("Some other thing entirely")).toBe("unclassified");
  });

  it("is case-insensitive", () => {
    expect(classifyColorRole("PAGE GROUND")).toBe("neutral");
    expect(classifyColorRole("primary CTA")).toBe("accent");
  });
});

describe("resolveDominantColorsByRole — the four real clients from the IGSTYLE-9 sweep", () => {
  it("hankypanky: the most-dominant color is ground (neutral), the real accent is ranked lower", () => {
    const colors: BrandColor[] = [
      { hex: "#fefaf9", dominanceRank: 1, role: "Page ground across the storefront" },
      { hex: "#f15151", dominanceRank: 2, role: "Sale callouts, badges, CTA highlights" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    // Only one neutral-classified color, and it's a near-white cream — high
    // luminance, so it fills the LIGHT slot, never the dark one a "first
    // neutral found" heuristic might have guessed.
    expect(resolved).toMatchObject({ resolvedByRole: true, primaryAccent: "#f15151", brandNeutralLight: "#fefaf9" });
    expect(resolved.brandNeutralDark).toBeUndefined();
  });

  it("xodigital: the most-dominant color is brand base/headings (neutral), the real accent is the CTA color", () => {
    const colors: BrandColor[] = [
      { hex: "#0b2644", dominanceRank: 1, role: "Brand base — logo mark, headings, dark panels" },
      { hex: "#e6a47c", dominanceRank: 2, role: "Primary CTA and interactive accent" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    expect(resolved).toMatchObject({ resolvedByRole: true, primaryAccent: "#e6a47c", brandNeutralDark: "#0b2644" });
  });

  it("thepitchbydeel: the most-dominant color is a cream surface (neutral), the real accent is the purple signature", () => {
    const colors: BrandColor[] = [
      { hex: "#faf4ee", dominanceRank: 1, role: "Warm cream page surface" },
      { hex: "#5938b7", dominanceRank: 2, role: "Acai purple brand signature" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    expect(resolved).toMatchObject({ resolvedByRole: true, primaryAccent: "#5938b7" });
    // Only one neutral-classified color — luminance decides which field it
    // fills; a near-white cream is well above the midpoint, so it's the
    // light neutral, not the dark one a positional read would have produced.
    expect(resolved.brandNeutralLight).toBe("#faf4ee");
    expect(resolved.brandNeutralDark).toBeUndefined();
  });

  it("karoslabs: the most-dominant near-black is the neutral ground, the orange is the real accent", () => {
    const colors: BrandColor[] = [
      { hex: "#242429", dominanceRank: 1, role: "Ink — dark background and body copy" },
      { hex: "#ff6b2c", dominanceRank: 2, role: "Primary accent — buttons and highlights" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    expect(resolved).toMatchObject({ resolvedByRole: true, primaryAccent: "#ff6b2c", brandNeutralDark: "#242429" });
  });

  it("disambiguates two neutral-classified colors by measured luminance, not role text or position — even when a brand names both 'surface'", () => {
    const colors: BrandColor[] = [
      { hex: "#111111", dominanceRank: 1, role: "Dark surface" },
      { hex: "#f5f5f5", dominanceRank: 2, role: "Light surface" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    expect(resolved.brandNeutralDark).toBe("#111111");
    expect(resolved.brandNeutralLight).toBe("#f5f5f5");
  });

  it("disambiguates two neutrals by luminance even when the LIGHTER one is listed FIRST in dominance order", () => {
    const colors: BrandColor[] = [
      { hex: "#f5f5f5", dominanceRank: 1, role: "Surface" },
      { hex: "#111111", dominanceRank: 2, role: "Surface" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    expect(resolved.brandNeutralDark).toBe("#111111");
    expect(resolved.brandNeutralLight).toBe("#f5f5f5");
  });

  it("a record whose roles ALL classify as neutral yields NO accent — refuse to guess, never invent one", () => {
    const colors: BrandColor[] = [
      { hex: "#111111", dominanceRank: 1, role: "Ground" },
      { hex: "#eeeeee", dominanceRank: 2, role: "Surface" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    expect(resolved.resolvedByRole).toBe(true);
    expect(resolved.primaryAccent).toBeUndefined();
    expect(resolved.secondaryAccent).toBeUndefined();
  });

  it("keeps multiple accent-classified colors in their existing dominance order for primary/secondary", () => {
    const colors: BrandColor[] = [
      { hex: "#111111", dominanceRank: 1, role: "Ground" },
      { hex: "#aa0000", dominanceRank: 2, role: "Primary accent" },
      { hex: "#00aa00", dominanceRank: 3, role: "Secondary accent highlight" },
    ];
    const resolved = resolveDominantColorsByRole(colors);
    expect(resolved.primaryAccent).toBe("#aa0000");
    expect(resolved.secondaryAccent).toBe("#00aa00");
  });

  it("resolvedByRole is false when NO color's role text classifies — the caller must use the positional fallback", () => {
    const noRoles: BrandColor[] = [
      { hex: "#111111", dominanceRank: 1 },
      { hex: "#eeeeee", dominanceRank: 2 },
    ];
    expect(resolveDominantColorsByRole(noRoles)).toEqual({ resolvedByRole: false });

    const unrecognizedRoles: BrandColor[] = [
      { hex: "#111111", dominanceRank: 1, role: "Something unrelated" },
    ];
    expect(resolveDominantColorsByRole(unrecognizedRoles)).toEqual({ resolvedByRole: false });
  });

  it("never re-sorts the input array — a caller reading `colors` itself afterward still sees dominance order", () => {
    const colors: BrandColor[] = [
      { hex: "#f5f5f5", dominanceRank: 1, role: "Surface" },
      { hex: "#111111", dominanceRank: 2, role: "Surface" },
    ];
    const before = colors.map((c) => c.hex);
    resolveDominantColorsByRole(colors);
    expect(colors.map((c) => c.hex)).toEqual(before);
  });
});

describe("effective* accessors — role-based first, positional/legacy fallback second (SCRUM-394)", () => {
  it("effectivePrimaryAccent/effectiveSecondaryAccent prefer role classification over array position", () => {
    const g: BrandingGuidelines = {
      dominantColors: [
        { hex: "#fefaf9", dominanceRank: 1, role: "Page ground across the storefront" },
        { hex: "#f15151", dominanceRank: 2, role: "Sale callouts, badges, CTA highlights" },
      ],
      updatedAt: 0,
    };
    // A positional read would have said primaryAccent = "#fefaf9" (rank 1) —
    // the whole bug this ticket fixes.
    expect(effectivePrimaryAccent(g)).toBe("#f15151");
    expect(effectiveSecondaryAccent(g)).toBeUndefined();
  });

  it("effectiveNeutralDark/effectiveNeutralLight prefer role classification (by luminance) over array position", () => {
    const g: BrandingGuidelines = {
      dominantColors: [
        { hex: "#faf4ee", dominanceRank: 1, role: "Warm cream page surface" },
        { hex: "#5938b7", dominanceRank: 2, role: "Acai purple brand signature" },
      ],
      updatedAt: 0,
    };
    // A positional read would never populate brandNeutralDark/Light at all
    // here (only two colors, ranks 0/1 map to accent slots) — role-based
    // resolution correctly finds the one real neutral.
    expect(effectiveNeutralLight(g)).toBe("#faf4ee");
    expect(effectiveNeutralDark(g)).toBeUndefined();
  });

  it("falls back to exactly today's positional/legacy behavior when dominantColors carries no classifiable role text", () => {
    const g: BrandingGuidelines = {
      dominantColors: [
        { hex: "#111111", dominanceRank: 1 },
        { hex: "#222222", dominanceRank: 2 },
        { hex: "#333333", dominanceRank: 3 },
        { hex: "#444444", dominanceRank: 4 },
      ],
      updatedAt: 0,
    };
    expect(effectivePrimaryAccent(g)).toBe("#111111");
    expect(effectiveSecondaryAccent(g)).toBe("#222222");
    expect(effectiveNeutralDark(g)).toBe("#333333");
    expect(effectiveNeutralLight(g)).toBe("#444444");
  });

  it("falls back to legacy scalar fields when dominantColors is entirely absent — unchanged from before this ticket", () => {
    const g: BrandingGuidelines = {
      primaryAccent: "#ff0000",
      secondaryAccent: "#0000ff",
      brandNeutralDark: "#09090b",
      brandNeutralLight: "#fafafa",
      updatedAt: 0,
    };
    expect(effectivePrimaryAccent(g)).toBe("#ff0000");
    expect(effectiveSecondaryAccent(g)).toBe("#0000ff");
    expect(effectiveNeutralDark(g)).toBe("#09090b");
    expect(effectiveNeutralLight(g)).toBe("#fafafa");
  });
});
