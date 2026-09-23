/**
 * READING A BRAND'S REAL FONTS OUT OF ITS CSS, DETERMINISTICALLY.
 *
 * The branding extractor asks a model to fetch a site and report
 * `HEADING_FONT` / `BODY_FONT`. For karoslabs.com it reported **Space Grotesk**
 * and **Inter**. The site actually serves **Spectral** and **Hanken Grotesk**.
 * The colours from the same pass were correct.
 *
 * The two wrong answers are the tell: "Inter" and "Space Grotesk" are the most
 * common modern-tech-startup fonts there are. The model did not misread the
 * CSS — it could not read it at all, so it produced the most plausible names it
 * knew. That is what a model does when asked a question the input cannot
 * answer, and no amount of additional prompt instruction changes it.
 *
 * ## Why the CSS could not be read
 *
 * The name is TWO variable hops behind anything the HTML shows:
 *
 *   HTML   font-family: var(--font-serif)
 *   CSS    --font-serif: var(--font-spectral), Georgia, "Times New Roman", serif
 *   CSS    --font-spectral: "Spectral", "Spectral Fallback"
 *
 * The extractor's prompt names `--font-heading`, `--font-sans` and
 * `--font-body`; this site uses none of those. Any framework that ships fonts
 * through `next/font`, Tailwind theme variables or a design-token layer looks
 * like this, so it is the normal case, not an exotic one.
 *
 * ## The rule
 *
 * Resolving `var()` chains is a pure text transformation with one right
 * answer. It is not a judgment, so it does not belong to a model — the same
 * reason the numbers gate stopped asking one to decide whether a figure was
 * sourced. This resolves the chain in code and hands the extractor ground
 * truth.
 */

/** A font pair read from a site's own stylesheets, with how it was found. */
export interface ResolvedBrandFonts {
  /** The family used for headings, if one could be resolved. */
  fontHeading?: string;
  /** The family used for body copy, if one could be resolved. */
  fontBody?: string;
  /** Which declaration each came from, for the record and for a human checking the claim. */
  source?: string;
}

/**
 * CSS comments, removed before anything reads a selector.
 *
 * Not tidiness. The rule scanner splits on braces, so the text between the
 * previous `}` and the next `{` is taken as the selector — and on the live site
 * that text was a comment, which then went into `source` as if it were one. A
 * comment saying "keep the serif on h1" would have SET the heading font. The
 * one thing this cannot see through is a comment sequence inside a quoted
 * value; no stylesheet in evidence has one, and a wrong font name is the cost.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** How many `var()` hops to follow before giving up. The deepest real chain seen is two; the cap exists for cycles, not for depth. */
const MAX_VAR_HOPS = 8;

/**
 * Every `--name: value` declaration in the CSS, last definition winning.
 *
 * Last, not first, because that is the cascade: a later rule overrides an
 * earlier one, and a theme file that redefines `--font-sans` under a media
 * query or a `[data-theme]` selector means it.
 */
function customProperties(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/**
 * Follows `var(--x)` until a literal font name appears.
 *
 * `var(--a, fallback)` keeps the fallback only if `--a` is undefined, which is
 * what the browser does. A cycle or an unresolvable name returns whatever text
 * it reached, so the caller can still see something rather than nothing.
 */
function resolveVars(value: string, props: Map<string, string>): string {
  let current = value;
  for (let hop = 0; hop < MAX_VAR_HOPS; hop += 1) {
    const match = /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/.exec(current);
    if (!match) return current;
    const defined = props.get(match[1]!);
    const replacement = defined ?? match[2]?.trim() ?? "";
    const next = current.slice(0, match.index) + replacement + current.slice(match.index + match[0].length);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * The first real family in a `font-family` list.
 *
 * Skips the generic keywords and the `*-Fallback` families frameworks emit
 * beside the real one (`next/font` writes `"Spectral", "Spectral Fallback"`),
 * because a fallback is by definition not the brand's font. Returns undefined
 * when the list holds nothing but generics — an honest "could not tell",
 * which is the whole point of this file.
 */
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "inherit", "initial", "unset", "revert"]);

/**
 * `__Plus_Jakarta_Sans_b6296e` back to `Plus Jakarta Sans`.
 *
 * `next/font` does not write the family the designer chose; it writes a
 * generated, content-hashed name and only that. Storing it verbatim gives a
 * brand kit a typeface nobody can buy, install or name in a brief — which is
 * worse than the guess it replaced, because it LOOKS measured. Found by running
 * the resolver against all eight live client sites; the karoslabs fixture that
 * drove this file does not use the hashed form.
 */
function demangleFrameworkFamily(name: string): string {
  const m = /^__(.+?)_[0-9a-z]{4,}$/i.exec(name);
  return m ? m[1]!.replace(/_/g, " ") : name;
}

export function firstConcreteFamily(fontFamily: string): string | undefined {
  for (const raw of fontFamily.split(",")) {
    // `!important` belongs to the declaration, not to the family. Without this
    // a real site yielded the family "inherit!important", which then passed the
    // generic-keyword filter because it is not the word `inherit`.
    const name = demangleFrameworkFamily(
      raw.replace(/!\s*important/gi, "").trim().replace(/^["']|["']$/g, "").trim(),
    );
    if (name.length === 0) continue;
    if (GENERIC.has(name.toLowerCase())) continue;
    // Only as a SUFFIX. `next/font` emits the real family beside a generated
    // twin — `"Spectral", "Spectral Fallback"`, or `__Spectral_Fallback_ab12`
    // — and both end on the word. Matching it anywhere would drop a real
    // typeface called "Fallback Sans", which is a font nobody should lose to
    // a filter written for one framework's naming habit.
    if (/(^|[\s_-])fallback$/i.test(name)) continue;
    // A leftover `var(...)` means the chain never resolved; not a family.
    if (name.startsWith("var(") || name.startsWith("--")) continue;
    // `-apple-system`, `BlinkMacSystemFont` and friends are system stacks.
    if (/^-?(apple-system|BlinkMacSystemFont|Segoe UI|Roboto|Helvetica Neue|Arial|Noto Sans)$/i.test(name)) continue;
    return name;
  }
  return undefined;
}

/** A selector that mentions the role somewhere — the loose reading. */
const HEADING_SELECTOR = /(^|[\s,>+~])(h1|h2|h3)\b|\b(heading|display|title)\b/i;
const BODY_SELECTOR = /(^|[\s,>+~])(body|html|p)\b|:root\b|\b(body-?text|prose)\b/i;

/**
 * A selector that GOVERNS the role rather than merely mentioning it: every one
 * of its comma-separated parts is the bare element.
 *
 * The distinction is load-bearing, and a live site is what proved it. Sitti's
 * stylesheet sets `font-family: Gaegu` — a handwriting face — on a selector
 * ending in `p`, later in the file than its own `body` rule. Taking simply the
 * last rule that MENTIONS body copy made a decorative flourish the brand's body
 * typeface. A bare `body {}` outranks any compound selector however late it
 * comes, because that is the rule a reader means when they ask what a site's
 * body font is.
 */
const HEADING_GOVERNS = /^h[1-3]$/i;
const BODY_GOVERNS = /^(body|html|:root|:host|\*)$/i;

/**
 * At-rules whose `font-family` names a font being DEFINED, not one being used.
 *
 * `@font-face { font-family: Gaegu; src: url(…) }` says the browser may load
 * Gaegu — nothing about where it is applied. Sitti's bundle declares two dozen
 * such faces; before this, the first one won and a handwriting face became the
 * brand's body typeface. A site that loads a font does not thereby use it, and
 * the whole point of this file is to report what a reader actually sees.
 */
const DEFINING_AT_RULE = /@(font-face|keyframes|counter-style|font-feature-values|font-palette-values)/i;

function governs(selector: string, part: RegExp): boolean {
  const parts = selector.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length > 0 && parts.every((p) => part.test(p));
}

/** Variable names a framework conventionally uses for each role, when no selector says so. */
const HEADING_VARS = ["--font-heading", "--font-display", "--font-serif", "--font-title"];
const BODY_VARS = ["--font-body", "--font-sans", "--font-base", "--font-text"];

/**
 * Reads the heading and body families a site actually serves.
 *
 * Two passes, in order of authority:
 *
 *  1. `font-family` declarations attached to real selectors, which is what the
 *     browser applies. A rule whose selector mentions `h1`/`h2`/`h3` sets the
 *     heading; one on `body`/`html`/`:root` sets body copy.
 *  2. The conventional role VARIABLES, for a site whose selectors all point at
 *     a token layer (`--font-heading`, `--font-sans`, …). Second because a
 *     variable can be defined and never used.
 *
 * `css` should be every stylesheet fetched, concatenated, plus any inline
 * `<style>` content — the cascade does not care which file a rule came from,
 * and neither does this.
 */
export function resolveBrandFonts(source: string): ResolvedBrandFonts {
  const css = stripComments(source);
  const props = customProperties(css);
  const sources: string[] = [];

  // Pass 1 — rules, in document order. Within a tier the later rule wins, which
  // is the cascade; across tiers the governing selector wins, which is what the
  // cascade does anyway for an element the compound selector never matches.
  const found: Record<"heading" | "body", { governing?: [string, string]; loose?: [string, string] }> = {
    heading: {},
    body: {},
  };
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim();
    if (DEFINING_AT_RULE.test(selector)) continue;
    const declarations = rule[2]!;
    const decl = /(?:^|[;{\s])font-family\s*:\s*([^;}]+)/i.exec(declarations);
    if (!decl) continue;
    const family = firstConcreteFamily(resolveVars(decl[1]!, props));
    if (!family) continue;

    const hit = (role: "heading" | "body", governing: boolean) => {
      found[role][governing ? "governing" : "loose"] = [family, selector.slice(0, 60)];
    };
    if (governs(selector, HEADING_GOVERNS)) hit("heading", true);
    else if (governs(selector, BODY_GOVERNS)) hit("body", true);
    else if (HEADING_SELECTOR.test(selector)) hit("heading", false);
    else if (BODY_SELECTOR.test(selector)) hit("body", false);
  }

  let heading: string | undefined;
  let body: string | undefined;
  for (const role of ["heading", "body"] as const) {
    const pick = found[role].governing ?? found[role].loose;
    if (!pick) continue;
    if (role === "heading") heading = pick[0];
    else body = pick[0];
    sources.push(`${role}: font-family on \`${pick[1]}\``);
  }

  // Pass 2 — the conventional role variables, for whichever role is still open.
  if (heading === undefined) {
    for (const name of HEADING_VARS) {
      const raw = props.get(name);
      if (raw === undefined) continue;
      const family = firstConcreteFamily(resolveVars(raw, props));
      if (family) {
        heading = family;
        sources.push(`heading: \`${name}\``);
        break;
      }
    }
  }
  if (body === undefined) {
    for (const name of BODY_VARS) {
      const raw = props.get(name);
      if (raw === undefined) continue;
      const family = firstConcreteFamily(resolveVars(raw, props));
      if (family) {
        body = family;
        sources.push(`body: \`${name}\``);
        break;
      }
    }
  }

  return {
    ...(heading !== undefined ? { fontHeading: heading } : {}),
    ...(body !== undefined ? { fontBody: body } : {}),
    ...(sources.length > 0 ? { source: sources.join("; ") } : {}),
  };
}
