import "server-only";

import { normalizeHex } from "@/lib/branding-hex";
import type { BrandColor } from "@/lib/types";

/**
 * The colours a site ACTUALLY declares, read from its own markup and
 * stylesheets by code rather than by a model.
 *
 * ## Why this exists
 *
 * `applyBrandingForClient` asks one model to browse the site and report what it
 * saw, then asks a second to turn that report into a palette. Neither step is
 * constrained to colours that exist. On karoslabs.com it produced
 * `primaryAccent: #6366f1` — Tailwind's `indigo-500`, a value that appears
 * nowhere in that site's HTML or CSS — alongside `#dc602c` for an orange the
 * site actually declares as `#ff6b2c`. Three of the four stored scalars were
 * invented; only `#242429` was real. A client reading their own brand
 * guidelines was told their brand is blue.
 *
 * A model is genuinely good at the judgment here — which colour is the brand's
 * signature, which is the page ground — and genuinely bad at transcribing hex
 * digits. So this module does the transcription and leaves the judgment alone:
 * it collects observed colours as ground truth for the prompt, and
 * `snapToObservedPalette` afterwards repairs any hex the model still invented,
 * keeping the role it assigned.
 *
 * CSS custom properties are collected WITH THEIR NAMES because the name is
 * usually the role, stated by the people who own the brand: karoslabs.com
 * declares `--accent: #ff6b2c` and `--background: #1a1a1a`, which is the whole
 * answer. Nothing here interprets them — that stays the model's job — but a
 * prompt that can quote `--accent` beats one guessing from a screenshot.
 */

/** One colour observed on the live site, with how it was found. */
export interface ObservedColor {
  /** 6-digit lowercase hex. */
  hex: string;
  /** How many times it appeared across the fetched documents. */
  count: number;
  /**
   * CSS custom properties that resolve to it in the site's DEFAULT scope
   * (`:root`, `html`, `body`, `.dark`) — the theme the site actually serves.
   */
  cssVars: string[];
  /**
   * Custom properties that resolve to it ONLY inside a theme-variant scope
   * (`.theme-cobalt`, `html.light .theme-signal`, …). karoslabs.com ships four
   * demo palettes for a theme switcher on its own landing page; pooled with the
   * real `:root` they outnumber it, and the extraction picked `#0b0b0d` — a
   * scene ground — as the brand's background over the real `#1a1a1a`.
   */
  themeVars: string[];
  /** Present in the site's own icon/logo SVG — the strongest statement of brand identity available here. */
  inLogo: boolean;
  /** Present in the served HTML itself (inline style, embedded SVG, theme-color meta). */
  inMarkup: boolean;
  /**
   * Share of the rendered screenshot this colour covers, 0–1, or `undefined`
   * when no screenshot was available.
   *
   * The difference between what a site declares and what it paints. `0` is the
   * strongest possible evidence against a colour — the site says it, and then
   * never uses it.
   */
  paintedShare?: number;
}

/**
 * Custom-property names that are component-library SLOTS, not brand statements.
 *
 * The distinction this file turns on. `--accent`, `--brand-primary` and
 * `--cta` are somebody naming a colour their brand acts with. `--primary`,
 * `--ring` and `--input` are slots in a scaffold (shadcn, MUI, Bootstrap):
 * frequently meaningful, and just as frequently left at whatever the template
 * shipped with. karoslabs.com declares `--primary: #2f6bff` and `--ring:
 * #2f6bff` in `:root` — a blue that a rendered-DOM sweep of the live site finds
 * painted on ZERO elements, and which appears in neither the mark nor the
 * markup. It is the sole reason that site's brand guidelines said "blue".
 *
 * A slot name is not evidence against a colour — plenty of brands really do put
 * their colour in `--primary`. It is only a reason to require corroboration
 * from some other source before treating it as the brand's.
 */
const SLOT_ONLY_NAMES = new Set([
  "--primary", "--secondary", "--ring", "--input", "--border", "--muted", "--card", "--popover",
  "--destructive", "--foreground", "--background", "--surface", "--color-white", "--color-black",
]);

/**
 * A colour the render disqualifies outright.
 *
 * Being absent from a screenshot is weaker evidence than it looks: a full-page
 * render still misses other routes, hover and focus states, and anything behind
 * an interaction. So "never painted" only DISQUALIFIES a colour that had no
 * standing to begin with — one named solely by component slots and corroborated
 * by neither the mark nor the markup.
 *
 * That is the difference between karoslabs.com's `--primary: #2f6bff` (a bare
 * slot, in nothing, painted nowhere — scaffolding) and deel.com's
 * `--color-core-cornbread: #ffcf25` (a name its owners chose, simply not on the
 * page that was rendered).
 */
export function isDisqualifiedByRender(c: ObservedColor): boolean {
  return c.paintedShare === 0 && isUncorroboratedSlotColor(c);
}

/** True when every name for this colour is a bare component slot. */
function slotNamedOnly(cssVars: readonly string[]): boolean {
  return cssVars.length > 0 && cssVars.every((n) => SLOT_ONLY_NAMES.has(n) || /^--(?:tw|swiper|mui)-/.test(n));
}

/**
 * A colour named only by component slots, corroborated by nothing else, is
 * probably scaffolding rather than brand. Kept in the list — it is really on
 * the site, and `snapToObservedPalette` still needs it as a repair target — but
 * presented to the model under a heading that says what it is.
 */
export function isUncorroboratedSlotColor(c: ObservedColor): boolean {
  return !c.inLogo && !c.inMarkup && c.cssVars.length > 0 && slotNamedOnly(c.cssVars);
}

/** How many stylesheets to follow. A site that needs more is not hiding its palette in the sixth. */
const MAX_STYLESHEETS = 4;
/** How many icon/logo SVGs to read. A site states its mark in the first one or two. */
const MAX_LOGOS = 2;
/** Per-document read cap. A stylesheet larger than this is a bundle; its first megabyte still holds the theme. */
const MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 15_000;

const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
const CUSTOM_PROP_RE = /(--[A-Za-z0-9_-]+)\s*:\s*(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\b/g;
const STYLESHEET_HREF_RE = /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi;
const HREF_RE = /href=["']([^"']+)["']/i;
/** One `selector { declarations }` rule. Inner blocks never nest, so at-rules fall out for free. */
const CSS_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
/** An icon or logo the page points at. Only SVG is followed — a PNG's colours are not readable here. */
const LOGO_HREF_RE = /(?:href|src|content)=["']([^"']*(?:logo|icon|mark|brand)[^"']*\.svg[^"']*)["']/gi;

/**
 * Selectors that carry the theme the site ACTUALLY serves.
 *
 * A whole-selector match, so `html.light .theme-cobalt` is correctly excluded
 * while `:root` and `.dark` are kept. Anything else is a variant scope: real
 * CSS, but a statement about some other theme, not about this brand.
 */
const DEFAULT_SCOPE_RE = /^\s*(?::root|html|body|\*|:host|\.dark|\[data-theme=["']?dark["']?\])\s*$/i;

function isDefaultScope(selectorList: string): boolean {
  return selectorList.split(",").some((s) => DEFAULT_SCOPE_RE.test(s));
}

/** Absolute URLs of SVG icons/logos the page references, most-specific first. */
function logoUrls(html: string, pageUrl: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(LOGO_HREF_RE)) {
    try {
      urls.push(new URL(match[1]!, pageUrl).toString());
    } catch {
      // A malformed href is skipped, not fatal.
    }
  }
  return [...new Set(urls)].slice(0, MAX_LOGOS);
}

/**
 * Colours with no brand meaning, dropped before ranking.
 *
 * Pure black and white and the transparent shorthand appear in every
 * stylesheet ever written (resets, shadows, Tailwind's `--tw-*` gradient
 * placeholders) and would otherwise dominate the frequency count and crowd out
 * the colours that identify the brand. Dropped from the RANKING only — a
 * palette that genuinely is black and white still reaches the model through the
 * custom properties, which are kept whatever their value.
 */
const IGNORED_HEXES = new Set(["#000000", "#ffffff", "#00000000", "#0000"]);

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!response.ok) return null;
    const text = await response.text();
    return text.slice(0, MAX_BYTES);
  } catch {
    // A site that blocks us, times out, or serves something unreadable is a
    // site we simply have no observations for — the caller then leaves the
    // model's palette alone rather than "repairing" it against nothing.
    return null;
  }
}

/** Absolute stylesheet URLs referenced by a page, in document order. */
function stylesheetUrls(html: string, pageUrl: string): string[] {
  const urls: string[] = [];
  for (const tag of html.match(STYLESHEET_HREF_RE) ?? []) {
    const href = HREF_RE.exec(tag)?.[1];
    if (!href) continue;
    try {
      urls.push(new URL(href, pageUrl).toString());
    } catch {
      // A malformed href is skipped, not fatal.
    }
  }
  return [...new Set(urls)].slice(0, MAX_STYLESHEETS);
}

/**
 * Read the palette a domain actually serves.
 *
 * Never throws and never rejects: an unreachable site yields an empty array,
 * which every caller treats as "no observations, change nothing". Branding is
 * a non-fatal side pipeline (`applyBrandingForClient`'s call site catches and
 * logs), and making it fatal here would trade a cosmetic gap for a failed run.
 */
export async function observeSitePalette(domain: string, fetchImpl: typeof fetch = fetch): Promise<ObservedColor[]> {
  const pageUrl = `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/`;
  const html = await fetchText(pageUrl, fetchImpl);
  if (html === null) return [];

  const [sheets, logos] = await Promise.all([
    Promise.all(stylesheetUrls(html, pageUrl).map((url) => fetchText(url, fetchImpl))),
    Promise.all(logoUrls(html, pageUrl).map((url) => fetchText(url, fetchImpl))),
  ]);
  const documents = [html, ...sheets.filter((s): s is string => s !== null)];

  const counts = new Map<string, number>();
  const vars = new Map<string, Set<string>>();
  const themeOnly = new Map<string, Set<string>>();
  const inLogo = new Set<string>();
  const inMarkup = new Set<string>();

  for (const match of html.matchAll(HEX_RE)) {
    const hex = normalizeHex(match[0]);
    if (hex) inMarkup.add(hex);
  }

  for (const svg of logos) {
    if (svg === null) continue;
    for (const match of svg.matchAll(HEX_RE)) {
      const hex = normalizeHex(match[0]);
      if (hex) inLogo.add(hex);
    }
  }

  for (const doc of documents) {
    for (const match of doc.matchAll(HEX_RE)) {
      const hex = normalizeHex(match[0]);
      if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
    // Rule-by-rule rather than document-wide, so each declaration is attributed
    // to the scope that made it. A `--background` in `.theme-cobalt` is not the
    // site's background.
    for (const rule of doc.matchAll(CSS_RULE_RE)) {
      const target = isDefaultScope(rule[1]!) ? vars : themeOnly;
      for (const match of rule[2]!.matchAll(CUSTOM_PROP_RE)) {
        const hex = normalizeHex(match[2]!);
        if (!hex) continue;
        const bucket = target.get(hex) ?? new Set<string>();
        bucket.add(match[1]!);
        target.set(hex, bucket);
        // A declared custom property is a deliberate statement about the brand,
        // so it also earns its colour a place in the ranking even when the
        // ignore-list would otherwise drop it.
        counts.set(hex, counts.get(hex) ?? 0);
      }
    }
  }

  // `themeVars` records only names that NEVER appear in a default scope —
  // otherwise every variant redeclaration would also be listed as theme-only.
  const rank = (c: ObservedColor) =>
    c.inLogo ? 0 : isUncorroboratedSlotColor(c) ? 3 : c.cssVars.length > 0 ? 1 : c.themeVars.length > 0 ? 4 : 2;

  return [...counts.entries()]
    .filter(([hex]) => !IGNORED_HEXES.has(hex) || vars.has(hex) || inLogo.has(hex))
    .map(([hex, count]) => ({
      hex,
      count,
      cssVars: [...(vars.get(hex) ?? [])].sort(),
      themeVars: [...(themeOnly.get(hex) ?? [])].filter((name) => !vars.get(hex)?.has(name)).sort(),
      inLogo: inLogo.has(hex),
      inMarkup: inMarkup.has(hex),
    }))
    // The mark first, then colours the served theme names, then merely frequent
    // ones, and last the variant-scope palettes — which are real CSS but are
    // statements about some other theme. Within a tier, frequency decides.
    .sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.hex.localeCompare(b.hex))
    .slice(0, 40);
}

/**
 * How close two colours must be for a painted pixel to count as "this declared
 * colour, rendered". Squared RGB distance; ~12 per channel.
 *
 * Not zero, because a colour laid over a translucent overlay, or through a
 * gradient stop, or antialiased at a border, lands a shade off the token that
 * produced it. Small enough that two colours a designer chose apart stay apart.
 */
const PAINT_MATCH_DISTANCE = 3 * 12 ** 2;

/**
 * Fold a rendered screenshot's measured colours into what the CSS declared.
 *
 * Answers the one question static analysis cannot: of the colours this site
 * says it has, which does it actually put on screen? Every declared colour gets
 * a `paintedShare`; a `0` there is what finally disqualifies karoslabs.com's
 * `--primary: #2f6bff`, and no rule about token names is needed to do it.
 *
 * Colours the render shows that the CSS never declared are appended too — a
 * brand whose identity lives in a hero image or a logo raster has no custom
 * property to be found by, and would otherwise be invisible to this pipeline.
 *
 * With no painted input this returns the palette untouched, `paintedShare`
 * unset, and every downstream reader treats "unknown" differently from "zero".
 */
export function mergePaintedPalette(
  observed: readonly ObservedColor[],
  painted: readonly { hex: string; share: number }[],
): ObservedColor[] {
  if (painted.length === 0) return [...observed];

  const claimed = new Set<string>();
  const withPaint = observed.map((color) => {
    let share = 0;
    for (const p of painted) {
      if (distance(color.hex, p.hex) <= PAINT_MATCH_DISTANCE) {
        share += p.share;
        claimed.add(p.hex);
      }
    }
    return { ...color, paintedShare: share };
  });

  // A painted colour that matched no declaration is real evidence with no name.
  // Ranked by area among itself, and kept behind everything the site named.
  const undeclared = painted
    .filter((p) => !claimed.has(p.hex) && !IGNORED_HEXES.has(p.hex))
    .map((p) => ({
      hex: p.hex,
      count: 0,
      cssVars: [] as string[],
      themeVars: [] as string[],
      inLogo: false,
      inMarkup: false,
      paintedShare: p.share,
    }));

  return [...withPaint, ...undeclared].slice(0, 48);
}

/** The prompt block naming what the site really declares. Empty string when nothing was observed. */
export function describeObservedPalette(observed: readonly ObservedColor[]): string {
  if (observed.length === 0) return "";
  const logo = observed.filter((c) => c.inLogo);
  const slotOnly = observed.filter((c) => !c.inLogo && isUncorroboratedSlotColor(c));
  const named = observed.filter((c) => !c.inLogo && !isUncorroboratedSlotColor(c) && c.cssVars.length > 0);
  const themed = observed.filter((c) => !c.inLogo && c.cssVars.length === 0 && c.themeVars.length > 0);
  const rest = observed
    .filter((c) => !c.inLogo && c.cssVars.length === 0 && c.themeVars.length === 0)
    .slice(0, 12);

  const lines = [
    "## Source C — Verified site palette (transcribed from the live CSS by code, not by a model)",
    "",
    "EVERY hex you return in `dominantColors` MUST be one of the values listed here, copied exactly.",
    "These were read directly out of the site's own markup and stylesheets. Do not adjust, round,",
    "or substitute a value you believe is close — a hex that is not in this list is wrong by definition.",
    "",
  ];
  if (logo.length > 0) {
    lines.push(
      "The site's own icon/logo mark uses these colours. A mark is the most deliberate colour decision",
      "a brand makes, so treat these as near-certain brand colours:",
      ...logo.map((c) => `  ${c.hex}${c.cssVars.length > 0 ? `  (also ${c.cssVars.join(", ")})` : ""}`),
      "",
    );
  }

  // When a render was available it OUTRANKS every other signal below, so it is
  // presented first and the rest of the sections are skipped. A colour's token
  // name is a claim about intent; the screenshot is a measurement of fact.
  const measured = observed.some((c) => c.paintedShare !== undefined);
  if (measured) {
    const painted = observed
      .filter((c) => (c.paintedShare ?? 0) > 0)
      .sort((a, b) => (b.paintedShare ?? 0) - (a.paintedShare ?? 0));
    const unpainted = observed.filter(isDisqualifiedByRender);
    // Declared, brand-named, and simply not on the page that was rendered —
    // below a route this never visited, or behind a hover state. Reported, but
    // never as evidence AGAINST the colour.
    const elsewhere = observed.filter(
      (c) => c.paintedShare === 0 && !isDisqualifiedByRender(c) && (c.cssVars.length > 0 || c.themeVars.length > 0),
    );

    lines.push(
      "A screenshot of the live page was rendered and its pixels counted. This is what a visitor",
      "actually SEES, and it outranks every declaration below — a colour's CSS name states an intention,",
      "this states what happened. Share of the rendered viewport:",
      ...painted
        .slice(0, 14)
        .map(
          (c) =>
            `  ${c.hex}  ${((c.paintedShare ?? 0) * 100).toFixed(2)}% of the page` +
            `${c.inLogo ? "  [in the logo mark]" : ""}${c.cssVars.length > 0 ? `  (${c.cssVars.join(", ")})` : ""}`,
        ),
      "",
      "Note that share of area does NOT equal importance: a well-run brand rations its accent, so the",
      "signature colour is often a fraction of a percent while the page ground is most of the screen.",
      "Use this to tell a real colour from an unused one, never to rank them.",
      "",
    );

    // Stated separately and explicitly, because area ranking buries it and the
    // mark does not contain it. On karoslabs.com this is the whole reason the
    // orange survives to reach the palette at all.
    const accents = accentCandidates(observed);
    if (accents.length > 0) {
      lines.push(
        "CANDIDATE SIGNATURE COLOURS — painted on the page, and chromatic rather than a shade of the",
        "ground or the ink. A brand's accent is rationed by design, so expect it to be a tiny share of",
        "the page and to be absent from the logo mark and the social avatar, which are usually just the",
        "neutrals. Do not omit the accent because it is small or because the mark lacks it; that is what",
        "being rationed looks like:",
        ...accents.map(
          (c) =>
            `  ${c.hex}${c.cssVars.length > 0 ? `  (${c.cssVars.join(", ")})` : ""}` +
            `${c.paintedShare !== undefined ? `  ${(c.paintedShare * 100).toFixed(2)}% of the page` : ""}`,
        ),
        "",
      );
    }

    if (unpainted.length > 0) {
      lines.push(
        "DECLARED BUT NEVER PAINTED — the stylesheet defines these and the rendered page uses them on",
        "nothing at all. In a scaffolded theme this is what a leftover template default looks like.",
        "They are NOT brand colours; do not return any of them, whatever their name suggests:",
        ...unpainted.slice(0, 10).map((c) => `  ${[...c.cssVars, ...c.themeVars].join(", ")}: ${c.hex}`),
        "",
      );
    }

    if (elsewhere.length > 0) {
      lines.push(
        "Declared with a name their owners chose, but not present in this particular render — further",
        "down another route, behind a hover state, or on a page this did not visit. A full design system",
        "always has more colours than any one page shows. This is NOT evidence against them: judge them",
        "on their names and on the attached images, exactly as you would without a screenshot:",
        ...elsewhere.slice(0, 12).map((c) => `  ${[...c.cssVars, ...c.themeVars].join(", ")}: ${c.hex}`),
        "",
      );
    }
    return lines.join("\n");
  }
  if (named.length > 0) {
    lines.push(
      "Declared CSS custom properties in the theme the site actually serves (`:root`/`.dark`) — the",
      "site's own names for its colours, usually the clearest statement of role available. Read the",
      "NAME as evidence of intent: `--accent`/`--brand-*` is the colour the brand ACTS with, whereas",
      "`--primary`/`--ring` are component-library slot names that are frequently left at a framework",
      "default the site never actually paints. Being declared is not on its own evidence that a colour",
      "is part of the brand — a slot-named colour that nothing else here corroborates is usually a",
      "leftover default, and must NOT be reported as a brand colour:",
      ...named.map((c) => `  ${c.cssVars.join(", ")}: ${c.hex}`),
      "",
    );
  }
  if (slotOnly.length > 0) {
    lines.push(
      "Declared ONLY under generic component-library slot names, and corroborated by nothing else —",
      "not the mark, not the page markup, no brand-meaning name. In a scaffolded theme these are",
      "usually template defaults the site never actually paints. Treat them as NOT part of the brand",
      "unless another source here independently supports them; never report one as an accent, and never",
      "add one just to reach a fourth colour:",
      ...slotOnly.slice(0, 8).map((c) => `  ${c.cssVars.join(", ")}: ${c.hex}`),
      "",
    );
  }
  if (themed.length > 0) {
    lines.push(
      "Declared ONLY inside alternate/demo theme scopes (a theme switcher, a preview, a dark/light",
      "variant of some other palette). These are real CSS but they describe a DIFFERENT theme, not this",
      "brand's identity. Do not report them as brand colours unless nothing above is usable:",
      ...themed.slice(0, 10).map((c) => `  ${c.themeVars.join(", ")}: ${c.hex}`),
      "",
    );
  }
  if (rest.length > 0) {
    lines.push("Other colours present, by frequency:", `  ${rest.map((c) => c.hex).join(", ")}`, "");
  }
  return lines.join("\n");
}

/**
 * HSL-style saturation and lightness, 0–1.
 *
 * Used to separate a brand's SIGNATURE colour from its substrate. A page ground
 * and its body ink are near-grey by construction; the colour a brand acts with
 * almost never is.
 */
function chroma(hex: string): { saturation: number; lightness: number } {
  const [r, g, b] = rgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1) || 1);
  return { saturation, lightness };
}

/** Below this saturation a colour is a neutral — a ground, a surface, or ink. */
const ACCENT_MIN_SATURATION = 0.25;
/** Pure black and pure white territory: never a signature colour, whatever their saturation computes to. */
const ACCENT_LIGHTNESS_RANGE = [0.12, 0.92] as const;

/**
 * Colours that could be the brand's signature, most likely first.
 *
 * THE POINT OF THIS FUNCTION. A well-run brand rations its accent. On
 * karoslabs.com the orange covers 0.16% of the rendered page, appears in
 * neither the logo mark nor the Instagram avatar (both of which are just the
 * charcoal and the cream), and is beaten on area by every shade of grey on the
 * screen. Rank by area and it finishes near the bottom; trust the mark and it
 * does not appear at all. It is still the colour the brand ACTS with, and any
 * palette that omits it is wrong.
 *
 * So a candidate accent is a colour that is painted at all, is chromatic rather
 * than a shade of the substrate, and is not effectively black or white.
 * Ordering rewards a brand-meaning CSS name first, then saturation — never
 * area, which is the axis that loses the accent.
 */
export function accentCandidates(observed: readonly ObservedColor[]): ObservedColor[] {
  return observed
    .filter((c) => {
      if (isDisqualifiedByRender(c)) return false;
      const { saturation, lightness } = chroma(c.hex);
      return (
        saturation >= ACCENT_MIN_SATURATION &&
        lightness >= ACCENT_LIGHTNESS_RANGE[0] &&
        lightness <= ACCENT_LIGHTNESS_RANGE[1]
      );
    })
    .sort((a, b) => {
      const named = (c: ObservedColor) => (c.cssVars.some((n) => /accent|brand|cta|highlight/i.test(n)) ? 0 : 1);
      return named(a) - named(b) || chroma(b.hex).saturation - chroma(a.hex).saturation;
    })
    .slice(0, 6);
}

function rgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function distance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/**
 * Replace any hex the site does not actually contain with the observed colour
 * closest to it, keeping the model's own `role` and `dominanceRank`.
 *
 * Repair rather than reject, and repair rather than re-rank. The model's
 * judgment about which colour is the accent and which is the ground is the part
 * it is good at and the part `resolveDominantColorsByRole` depends on; dropping
 * an entry would leave that reader with a hole, and reordering would overrule a
 * judgment this function is not qualified to make. What it does know is that a
 * colour absent from the site cannot be the brand's — so it keeps the intent
 * and fixes the value. `#dc602c` becomes the `#ff6b2c` the site really uses.
 *
 * No observations means no repair. An unreachable site must not cause a
 * confident rewrite of a palette that may have come from a logo file, which is
 * a source this function cannot see.
 */
export function snapToObservedPalette(colors: readonly BrandColor[], observed: readonly ObservedColor[]): BrandColor[] {
  if (observed.length === 0) return [...colors];
  const present = new Set(observed.map((c) => c.hex));

  return colors.map((color) => {
    const hex = normalizeHex(color.hex) ?? color.hex;
    if (present.has(hex)) return { ...color, hex };
    let nearest = observed[0]!.hex;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of observed) {
      const d = distance(hex, candidate.hex);
      if (d < best) {
        best = d;
        nearest = candidate.hex;
      }
    }
    return { ...color, hex: nearest };
  });
}
