import { describe, expect, it } from "vitest";
import { firstConcreteFamily, resolveBrandFonts } from "@/lib/brand-fonts";

/**
 * The bug this exists for, with the real numbers.
 *
 * The branding extractor stored these for karoslabs:
 *
 *     fontHeading: "Space Grotesk"      fontBody: "Inter"
 *
 * karoslabs.com serves:
 *
 *     headings: Spectral                body: Hanken Grotesk
 *
 * The colours from the same extraction pass were correct (`#ff6b2c`), so the
 * fetch worked — the model simply could not resolve the font and answered with
 * the two most common modern-tech-startup fonts there are. Asking it more
 * firmly would produce the same guess with more words; the chain has one right
 * answer and belongs in code.
 */

/**
 * The real shape, taken verbatim from karoslabs.com's compiled stylesheet on
 * 2026-09-23. `next/font` emits the `"X", "X Fallback"` pair, and the roles
 * point at a token layer rather than at the family — which is why the name is
 * two hops away from anything the HTML shows.
 */
const KAROSLABS_CSS = `
:root{--font-hanken:"Hanken Grotesk", "Hanken Grotesk Fallback";--font-spectral:"Spectral", "Spectral Fallback";--font-dm-mono:"DM Mono","DM Mono Fallback"}
@layer theme{:root{--font-sans:var(--font-hanken), system-ui, -apple-system, sans-serif;--font-serif:var(--font-spectral), Georgia, "Times New Roman", serif;--font-mono:var(--font-dm-mono), ui-monospace, monospace;--font-label:var(--font-hanken), system-ui, -apple-system, sans-serif}}
body{font-family: var(--font-hanken), system-ui, -apple-system, sans-serif}
h1,h2,h3{font-family: var(--font-serif)}
`;

describe("resolveBrandFonts — the karoslabs case", () => {
  it("reads Spectral and Hanken Grotesk, where the extractor said Space Grotesk and Inter", () => {
    const fonts = resolveBrandFonts(KAROSLABS_CSS);
    expect(fonts.fontHeading).toBe("Spectral");
    expect(fonts.fontBody).toBe("Hanken Grotesk");
  });

  it("says where it read them, so the claim can be checked", () => {
    expect(resolveBrandFonts(KAROSLABS_CSS).source).toMatch(/font-family on/);
  });

  it("follows a two-hop chain, which is the whole defect", () => {
    // --font-serif → var(--font-spectral) → "Spectral". One hop is not enough.
    const css = `:root{--a:"Real Font";--b:var(--a)}h1{font-family:var(--b)}`;
    expect(resolveBrandFonts(css).fontHeading).toBe("Real Font");
  });

  it("takes the LAST definition of a variable, the way the cascade does", () => {
    const css = `:root{--font-sans:"First"}@media(min-width:0){:root{--font-sans:"Second"}}body{font-family:var(--font-sans)}`;
    expect(resolveBrandFonts(css).fontBody).toBe("Second");
  });

  it("uses a var() fallback only when the variable is undefined", () => {
    expect(resolveBrandFonts(`body{font-family:var(--missing, "Fallback Font")}`).fontBody).toBe("Fallback Font");
    expect(resolveBrandFonts(`:root{--x:"Defined"}body{font-family:var(--x, "Fallback Font")}`).fontBody).toBe("Defined");
  });

  it("does not hang on a cycle", () => {
    const css = `:root{--a:var(--b);--b:var(--a)}h1{font-family:var(--a)}`;
    expect(() => resolveBrandFonts(css)).not.toThrow();
    expect(resolveBrandFonts(css).fontHeading).toBeUndefined();
  });

  it("falls back to the role variables when no selector names them", () => {
    // A site whose components all reference tokens and never set font-family
    // on h1/body directly.
    const css = `:root{--font-heading:"Playfair Display";--font-body:"Source Sans 3"}`;
    const fonts = resolveBrandFonts(css);
    expect(fonts.fontHeading).toBe("Playfair Display");
    expect(fonts.fontBody).toBe("Source Sans 3");
    expect(fonts.source).toMatch(/--font-heading/);
  });

  it("does not read a selector out of a CSS comment", () => {
    // Found by running this against the live stylesheet: `source` came back
    // naming "/* Ember: clean sans body per the reference; keep the serif" as a
    // selector. Harmless there, but the scanner splits on braces, so a comment
    // that mentions h1 would have set the heading font from the rule after it.
    const css = `/* keep the serif on h1 for now */ body{font-family:"Real Body"}`;
    const fonts = resolveBrandFonts(css);
    expect(fonts.fontHeading).toBeUndefined();
    expect(fonts.fontBody).toBe("Real Body");
    expect(fonts.source).not.toContain("keep the serif");
  });

  it("returns nothing rather than guessing when the CSS says nothing", () => {
    // The behaviour that makes this worth having. "Could not tell" is a real
    // answer; "Inter" is what you get instead when something has to answer.
    expect(resolveBrandFonts(`body{color:#111}`)).toEqual({});
    expect(resolveBrandFonts(``)).toEqual({});
  });
});

/**
 * WHAT THE FIXTURE COULD NOT TELL ME.
 *
 * The karoslabs stylesheet above made this file pass on the first run. Pointing
 * it at all eight live client sites broke it four different ways in one go —
 * each of these is a real site, and each would have written a wrong font into a
 * brand kit. The fixture is the specification; the live run is the test.
 */
describe("resolveBrandFonts — found by running it against live sites", () => {
  it("ignores @font-face, which names a font LOADED and not one used", () => {
    // The exact shape that produced the bug, and it takes markup to reproduce:
    // the caller passed page + stylesheets concatenated, the rule scanner splits
    // on braces, so everything since the last brace is read as the selector —
    // any page whose prose contains the word "body" reads as a body selector.
    // sitti.app declares two
    // dozen faces before applying anything, so a LOADED font became the brand's
    // body typeface. `observeSiteFonts` no longer passes markup; this keeps the
    // resolver safe for any caller that does.
    const markup = `<p>Every body of work starts somewhere.</p>`;
    const css = `@font-face{font-family:"Loaded Only";src:url(x.woff2)}h1{font-family:"Actually Used"}`;
    const fonts = resolveBrandFonts(markup + "\n" + css);
    expect(fonts.fontBody).toBeUndefined();
    expect(fonts.fontHeading).toBe("Actually Used");
  });

  it("un-mangles next/font's hashed family", () => {
    // xodigital.com.br serves `__Plus_Jakarta_Sans_b6296e`. Stored verbatim that
    // is a typeface nobody can name in a brief, buy or install — worse than the
    // guess it replaced, because it looks measured.
    const css = `h1{font-family:__Plus_Jakarta_Sans_b6296e, __Plus_Jakarta_Sans_Fallback_b6296e}`;
    expect(resolveBrandFonts(css).fontHeading).toBe("Plus Jakarta Sans");
  });

  it("does not take !important for part of the font's name", () => {
    // deel.com yielded the family "inherit!important", which slipped past the
    // generic-keyword filter because it is not the word `inherit`.
    const css = `h1{font-family:inherit!important}h2{font-family:"Bagoss Condensed"}`;
    expect(resolveBrandFonts(css).fontHeading).toBe("Bagoss Condensed");
  });

  it("prefers a rule that GOVERNS the role over one that merely mentions it", () => {
    // A decorative `p` rule later in the file must not outrank `body`.
    const css = `body{font-family:"Real Body"}.testimonial p{font-family:"Handwriting"}`;
    expect(resolveBrandFonts(css).fontBody).toBe("Real Body");
    // …and with no governing rule at all, the loose one is still better than
    // nothing: a site that only ever styles `.prose p` has said something.
    expect(resolveBrandFonts(`.testimonial p{font-family:"Handwriting"}`).fontBody).toBe("Handwriting");
  });

  it("still lets a later governing rule win over an earlier one", () => {
    // Tier order must not cost us the cascade inside a tier.
    expect(resolveBrandFonts(`body{font-family:"First"}html{font-family:"Second"}`).fontBody).toBe("Second");
  });
});

describe("firstConcreteFamily", () => {
  it("skips the framework's own fallback twin", () => {
    // `next/font` writes the real family beside a generated fallback.
    expect(firstConcreteFamily(`"Spectral", "Spectral Fallback"`)).toBe("Spectral");
  });

  it("skips generic keywords and system stacks", () => {
    expect(firstConcreteFamily(`system-ui, -apple-system, sans-serif`)).toBeUndefined();
    expect(firstConcreteFamily(`ui-monospace, monospace`)).toBeUndefined();
  });

  it("does not report an unresolved variable as a font name", () => {
    // The failure mode that would have looked like success: storing
    // "var(--font-serif)" as the brand's typeface.
    expect(firstConcreteFamily(`var(--font-serif)`)).toBeUndefined();
  });

  it("keeps a real family that sits after a system stack", () => {
    expect(firstConcreteFamily(`-apple-system, "Real Brand Font", sans-serif`)).toBe("Real Brand Font");
  });
});
