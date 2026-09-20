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

/**
 * Colours that belong to a THIRD PARTY whose widget, embed or mock-up happens
 * to sit on the client's page.
 *
 * xodigital.com.br renders a WhatsApp conversation mock-up in its hero. The
 * mock-up brings WhatsApp's whole palette with it — `#25d366`, `#075e54`,
 * `#128c7e`, `#00a884`, `#06cf9c`, `#d9fdd3` — plus Instagram's `#0095f6` from
 * the social row. Those hexes are really in that site's CSS, they really get
 * painted, and they are more saturated than
 * the brand's own peach, so `accentCandidates` ranked all six of its slots
 * WhatsApp green and the extraction returned `#06cf9c` as XO Digital's primary
 * accent and `#0095f6` as its secondary. Both are somebody else's brand.
 *
 * Only unmistakable, published vendor values are listed, and only ones no
 * designer would land on by accident. Reds and pure primaries are deliberately
 * absent: YouTube's `#ff0000` and Pinterest's `#e60023` are values a real brand
 * picks on purpose, and a list that stole them would cost more than it saved.
 */
const THIRD_PARTY_BRAND_HEXES = new Map<string, string>([
  ["#25d366", "WhatsApp"], ["#128c7e", "WhatsApp"], ["#075e54", "WhatsApp"], ["#00a884", "WhatsApp"],
  ["#06cf9c", "WhatsApp"], ["#008f72", "WhatsApp"], ["#d9fdd3", "WhatsApp"], ["#dcf8c6", "WhatsApp"],
  ["#e5ddd5", "WhatsApp"], ["#ece5dd", "WhatsApp"], ["#53bdeb", "WhatsApp"], ["#34b7f1", "WhatsApp"],
  ["#1877f2", "Facebook"], ["#0866ff", "Facebook"], ["#4267b2", "Facebook"],
  ["#0095f6", "Instagram"], ["#e1306c", "Instagram"], ["#c13584", "Instagram"], ["#833ab4", "Instagram"],
  ["#1da1f2", "X/Twitter"], ["#1d9bf0", "X/Twitter"],
  ["#0a66c2", "LinkedIn"], ["#0077b5", "LinkedIn"],
  ["#fe2c55", "TikTok"], ["#69c9d0", "TikTok"], ["#ee1d52", "TikTok"],
  ["#0088cc", "Telegram"], ["#229ed9", "Telegram"],
  ["#4285f4", "Google"], ["#34a853", "Google"], ["#fbbc05", "Google"], ["#ea4335", "Google"],
  ["#635bff", "Stripe"], ["#003087", "PayPal"], ["#009cde", "PayPal"], ["#0070ba", "PayPal"],
  ["#5865f2", "Discord"], ["#ff4500", "Reddit"], ["#1db954", "Spotify"],
]);

/**
 * A CSS framework's STOCK palette value, shipped with the tool rather than
 * chosen by anybody.
 *
 * The same argument this module already makes about `--primary: #2f6bff`,
 * generalised. xodigital.com.br paints `#22c55e` on a status badge, through
 * `.from-green-500{--tw-gradient-from:#22c55e}` — Tailwind's default green,
 * arrived at by typing a class name. It is chromatic, it is painted, and no
 * rule about token names can tell it from a brand's own accent, so it was
 * offered as a candidate signature colour and returned as that client's
 * primary accent on one run in two. `#6366f1` — Tailwind `indigo-500`, the
 * invented hex this whole pipeline was built to stop — is in this table too.
 *
 * Only the 400/500/600 shades are listed: the band a site reaches for when it
 * wants a visible accent, and the only band that competes with a real one. A
 * value absent here is not thereby a brand colour, and one present here still
 * is one if the mark or a brand-meaning token name says so.
 */
const FRAMEWORK_DEFAULT_HEXES = new Map<string, string>([
  ["#94a3b8", "Tailwind slate-400"], ["#64748b", "Tailwind slate-500"], ["#475569", "Tailwind slate-600"],
  ["#9ca3af", "Tailwind gray-400"], ["#6b7280", "Tailwind gray-500"], ["#4b5563", "Tailwind gray-600"],
  ["#a1a1aa", "Tailwind zinc-400"], ["#71717a", "Tailwind zinc-500"], ["#52525b", "Tailwind zinc-600"],
  ["#a3a3a3", "Tailwind neutral-400"], ["#737373", "Tailwind neutral-500"], ["#525252", "Tailwind neutral-600"],
  ["#a8a29e", "Tailwind stone-400"], ["#78716c", "Tailwind stone-500"], ["#57534e", "Tailwind stone-600"],
  ["#f87171", "Tailwind red-400"], ["#ef4444", "Tailwind red-500"], ["#dc2626", "Tailwind red-600"],
  ["#fb923c", "Tailwind orange-400"], ["#f97316", "Tailwind orange-500"], ["#ea580c", "Tailwind orange-600"],
  ["#fbbf24", "Tailwind amber-400"], ["#f59e0b", "Tailwind amber-500"], ["#d97706", "Tailwind amber-600"],
  ["#facc15", "Tailwind yellow-400"], ["#eab308", "Tailwind yellow-500"], ["#ca8a04", "Tailwind yellow-600"],
  ["#a3e635", "Tailwind lime-400"], ["#84cc16", "Tailwind lime-500"], ["#65a30d", "Tailwind lime-600"],
  ["#4ade80", "Tailwind green-400"], ["#22c55e", "Tailwind green-500"], ["#16a34a", "Tailwind green-600"],
  ["#34d399", "Tailwind emerald-400"], ["#10b981", "Tailwind emerald-500"], ["#059669", "Tailwind emerald-600"],
  ["#2dd4bf", "Tailwind teal-400"], ["#14b8a6", "Tailwind teal-500"], ["#0d9488", "Tailwind teal-600"],
  ["#22d3ee", "Tailwind cyan-400"], ["#06b6d4", "Tailwind cyan-500"], ["#0891b2", "Tailwind cyan-600"],
  ["#38bdf8", "Tailwind sky-400"], ["#0ea5e9", "Tailwind sky-500"], ["#0284c7", "Tailwind sky-600"],
  ["#60a5fa", "Tailwind blue-400"], ["#3b82f6", "Tailwind blue-500"], ["#2563eb", "Tailwind blue-600"],
  ["#818cf8", "Tailwind indigo-400"], ["#6366f1", "Tailwind indigo-500"], ["#4f46e5", "Tailwind indigo-600"],
  ["#a78bfa", "Tailwind violet-400"], ["#8b5cf6", "Tailwind violet-500"], ["#7c3aed", "Tailwind violet-600"],
  ["#c084fc", "Tailwind purple-400"], ["#a855f7", "Tailwind purple-500"], ["#9333ea", "Tailwind purple-600"],
  ["#e879f9", "Tailwind fuchsia-400"], ["#d946ef", "Tailwind fuchsia-500"], ["#c026d3", "Tailwind fuchsia-600"],
  ["#f472b6", "Tailwind pink-400"], ["#ec4899", "Tailwind pink-500"], ["#db2777", "Tailwind pink-600"],
  ["#fb7185", "Tailwind rose-400"], ["#f43f5e", "Tailwind rose-500"], ["#e11d48", "Tailwind rose-600"],
]);

/** A brand-meaning custom-property name — somebody naming a colour their own. */
const BRAND_MEANING_NAME_RE = /accent|brand|cta|highlight/i;

/**
 * True when this colour is a third party's, borrowed by an embed on the page.
 *
 * The client's OWN evidence always wins: a colour in the site's icon/logo mark,
 * or one the site names `--accent`/`--brand-*`/`--cta-*`, is this brand's even
 * if a vendor also uses that value. A denylist must never be able to delete a
 * brand's real colour, only to demote one nothing else vouches for.
 */
export function isThirdPartyVendorColor(c: ObservedColor): boolean {
  return THIRD_PARTY_BRAND_HEXES.has(c.hex) && !vouchedForByTheBrand(c);
}

/** True when this colour is a framework's stock palette value and nothing else. */
export function isFrameworkDefaultColor(c: ObservedColor): boolean {
  return FRAMEWORK_DEFAULT_HEXES.has(c.hex) && !vouchedForByTheBrand(c);
}

/** Either kind of borrowed colour: somebody else's brand, or a framework default. */
export function isBorrowedColor(c: ObservedColor): boolean {
  return isThirdPartyVendorColor(c) || isFrameworkDefaultColor(c);
}

/** Where a borrowed colour came from, for the prompt to name. */
export function borrowedColorSource(hex: string): string | undefined {
  return THIRD_PARTY_BRAND_HEXES.get(hex) ?? FRAMEWORK_DEFAULT_HEXES.get(hex);
}

/**
 * The client's own evidence, which always overrides a lookup table: a colour in
 * the site's icon/logo mark, or one the site names `--accent`/`--brand-*`,
 * belongs to this brand even when a vendor or a framework also ships that
 * value. A table must never be able to delete a brand's real colour.
 */
function vouchedForByTheBrand(c: ObservedColor): boolean {
  return c.inLogo || c.cssVars.some((name) => BRAND_MEANING_NAME_RE.test(name));
}

/** How many stylesheets to follow. A site that needs more is not hiding its palette in the sixth. */
const MAX_STYLESHEETS = 4;
/** How many icon/logo SVGs to read. A site states its mark in the first one or two. */
const MAX_LOGOS = 2;
/**
 * How many colours the whole pipeline carries. Declared colours are capped at
 * `MAX_DECLARED_COLORS`; measured-but-undeclared ones fill the rest.
 */
const MAX_OBSERVED_COLORS = 64;
/** How many DECLARED colours reach the prompt. A site states its palette well inside forty hexes. */
const MAX_DECLARED_COLORS = 40;
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
 * The exact page the branding pipeline must read, from whatever the client
 * recorded as their website.
 *
 * KEEPS THE PATH, which is the whole point. "Pitch by Deel" records
 * `https://www.deel.com/the-pitch-by-deel/`; every branding signal used to be
 * taken from `new URL(...).hostname`, so the palette, the site intelligence and
 * the screenshot all described deel.com's corporate homepage instead. That is
 * where `--color-core-cornbread` — Deel's yellow, the third most frequent hex
 * on the corporate site and absent from the sub-brand's page — entered a
 * sub-brand's palette as a dominant colour.
 *
 * Query and hash are dropped: a tracking parameter is not a different page, and
 * keeping it would defeat any caching downstream. A bare hostname still works,
 * so every existing caller keeps its old behaviour.
 */
export function brandPageUrl(site: string): string {
  const trimmed = site.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not parseable as a URL — fall back to the old hostname-ish handling
    // rather than failing a pipeline that is allowed to observe nothing.
    return `https://${trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}/`;
  }
}

/**
 * Read the palette a domain actually serves.
 *
 * Never throws and never rejects: an unreachable site yields an empty array,
 * which every caller treats as "no observations, change nothing". Branding is
 * a non-fatal side pipeline (`applyBrandingForClient`'s call site catches and
 * logs), and making it fatal here would trade a cosmetic gap for a failed run.
 */
export async function observeSitePalette(site: string, fetchImpl: typeof fetch = fetch): Promise<ObservedColor[]> {
  const pageUrl = brandPageUrl(site);
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
    .slice(0, MAX_DECLARED_COLORS);
}

/**
 * How close two colours must be for a painted pixel to count as "this declared
 * colour, rendered". Squared RGB distance; ~20 per channel.
 *
 * Not zero, because a colour laid over a translucent overlay, or through a
 * gradient stop, or antialiased at a border, lands a shade off the token that
 * produced it. Small enough that two colours a designer chose apart stay apart.
 *
 * Was ~12, which is narrower than the measurement itself: `paletteFromPng`
 * buckets to 16 levels per channel, so a reported hex is already up to ~8.5 off
 * the pixel that voted for it, before any overlay. xodigital.com.br declares
 * its peach as `#e6a47c` and paints it as `#d99770` — 12.7 per channel, just
 * outside the old window — so the site's one real accent was scored "declared,
 * never painted" while the same pixels were also appended as a nameless
 * `#d99770`. One colour, counted twice, and vouched for neither time.
 */
const PAINT_MATCH_DISTANCE = 3 * 20 ** 2;

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

  // Each measured colour is assigned to ONE declared colour: the nearest inside
  // the window. Adding a painted colour to every declaration within range makes
  // the share column meaningless exactly where a palette is decided — on
  // xodigital.com.br, whose render is 49% white, `#f0f2f5`, `#f3f4f6`,
  // `#e1f2fb`, `#f7f4f0`, `#f9fafb` and `#ffffff` each reported ~53% of the
  // page, because each of them is within the window of the same white pixels
  // and of each other. The extraction then picked the off-white that happened
  // to sort first and left the actual white out. A pixel is one colour; it
  // votes once.
  const claimed = new Set<string>();
  const shares = new Map<number, number>();
  for (const p of painted) {
    let nearest = -1;
    let best = Number.POSITIVE_INFINITY;
    for (const [i, color] of observed.entries()) {
      const d = distance(color.hex, p.hex);
      // `<` keeps the earlier entry on a tie, and `observed` arrives in
      // evidence order (mark, then named, then merely frequent), so a tie goes
      // to the better-vouched-for colour.
      if (d <= PAINT_MATCH_DISTANCE && d < best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest >= 0) {
      shares.set(nearest, (shares.get(nearest) ?? 0) + p.share);
      claimed.add(p.hex);
    }
  }
  const withPaint = observed.map((color, i) => ({ ...color, paintedShare: shares.get(i) ?? 0 }));

  // A painted colour that matched no declaration is real evidence with no name.
  // Ranked by area among itself, and kept behind everything the site named.
  //
  // `IGNORED_HEXES` is NOT applied here, and that is the point. It exists to
  // stop resets and shadows dominating a FREQUENCY count of stylesheet text —
  // a fair rule about declarations, and a wrong one about pixels. Filtering it
  // here meant that white, which covers 49% of xodigital.com.br's rendered page
  // and 3% of deel.com/the-pitch-by-deel's, could not reach the model at all
  // unless the site happened to also declare it in a custom property, while
  // Source C simultaneously told the model every hex it returns must come from
  // this list. A page's ground is part of its brand; measuring it at half the
  // screen and then discarding it was the reason two clients' palettes had no
  // white in them.
  const undeclared = painted
    .filter((p) => !claimed.has(p.hex))
    .map((p) => ({
      hex: p.hex,
      count: 0,
      cssVars: [] as string[],
      themeVars: [] as string[],
      inLogo: false,
      inMarkup: false,
      paintedShare: p.share,
    }));

  // Declared colours are never cut by a longer measured list: `withPaint` is
  // kept whole and the undeclared ones fill what is left of the budget, largest
  // area first. A plain `.slice()` over the concatenation used to spend the cap
  // on whichever declarations happened to sort first and drop measured colours
  // that cover half the screen.
  const room = Math.max(0, MAX_OBSERVED_COLORS - withPaint.length);
  const kept = [...undeclared].sort((a, b) => b.paintedShare - a.paintedShare).slice(0, room);
  return [...withPaint, ...kept];
}

/** The prompt block naming what the site really declares. Empty string when nothing was observed. */
export function describeObservedPalette(observed: readonly ObservedColor[]): string {
  if (observed.length === 0) return "";
  const logo = observed.filter((c) => c.inLogo);
  const slotOnly = observed.filter((c) => !c.inLogo && isUncorroboratedSlotColor(c));
  const named = observed.filter((c) => !c.inLogo && !isUncorroboratedSlotColor(c) && c.cssVars.length > 0);
  const themed = observed.filter((c) => !c.inLogo && c.cssVars.length === 0 && c.themeVars.length > 0);
  const rest = observed
    .filter((c) => !c.inLogo && c.cssVars.length === 0 && c.themeVars.length === 0 && !isBorrowedColor(c))
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
      "The colour a page is MOSTLY MADE OF is one of that brand's colours, and that includes white,",
      "off-white and near-black. If a neutral above covers a large share of the render, report it, with",
      "a ground/surface/ink role — a palette for a site that is half white and has no white in it is",
      "wrong, however unremarkable white feels. Omit a neutral only when the render shows it is not",
      "actually there.",
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
        "being rationed looks like. They are listed painted-first: one reading 0.00% of the page is",
        "declared by the stylesheet and shown nowhere on it, so prefer any candidate above it:",
        ...accents.map(
          (c) =>
            `  ${c.hex}${c.cssVars.length > 0 ? `  (${c.cssVars.join(", ")})` : ""}` +
            `${c.paintedShare !== undefined ? `  ${(c.paintedShare * 100).toFixed(2)}% of the page` : ""}`,
        ),
        "",
      );
    }

    const borrowed = observed.filter(isBorrowedColor);
    if (borrowed.length > 0) {
      lines.push(
        "SOMEBODY ELSE'S COLOURS — each of these exact values belongs to a third party whose widget,",
        "share button or screenshot mock-up sits on this page, or is a CSS framework's stock palette",
        "shade, arrived at by typing a class name. They are really in the CSS and really on the screen,",
        "and nobody chose them for this brand. Never report one as a brand colour:",
        ...borrowed.slice(0, 12).map((c) => `  ${c.hex}  (${borrowedColorSource(c.hex) ?? "not this brand's"})`),
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
  const borrowed = observed.filter(isBorrowedColor);
  if (borrowed.length > 0) {
    lines.push(
      "SOMEBODY ELSE'S COLOURS — each of these exact values belongs to a third party whose widget,",
      "share button or screenshot mock-up sits on this page, or is a CSS framework's stock palette",
      "shade, arrived at by typing a class name. They are really in the CSS, and nobody chose them for",
      "this brand. Never report one as a brand colour:",
      ...borrowed.slice(0, 12).map((c) => `  ${c.hex}  (${borrowedColorSource(c.hex) ?? "not this brand's"})`),
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
 * than a shade of the substrate, is not effectively black or white, and is not
 * a third party's (see `isThirdPartyVendorColor` — this list was six WhatsApp
 * greens for a fintech whose accent is a peach).
 *
 * ORDERING, in two parts, and the order of the two parts is the fix.
 *
 * When a render exists, a colour the page actually PAINTS comes before one it
 * merely declares. Ranking by a brand-meaning name first is what put Deel's
 * `--color-surface-brand-yellow-03` at the head of this list for a sub-brand
 * page that paints no yellow at all: on a full design system, "brand" and
 * "accent" appear in half the token names, so the name test stops separating
 * anything. Within a group the brand-meaning name still leads, then area, then
 * saturation.
 *
 * Area is safe HERE, and only here: the grounds and the inks are already gone,
 * filtered out by the saturation and lightness tests above, so this ranks the
 * page's chromatic colours against each other rather than an accent against a
 * ground, which is the comparison area always loses. Saturation alone put
 * Tailwind's stock `#22c55e`, worn by one status pill on xodigital.com.br,
 * above that site's own peach.
 *
 * With no render (`paintedShare` undefined everywhere) nothing changes: every
 * colour lands in the same group and the old name-then-saturation order stands.
 */
export function accentCandidates(observed: readonly ObservedColor[]): ObservedColor[] {
  return observed
    .filter((c) => {
      if (isDisqualifiedByRender(c) || isBorrowedColor(c)) return false;
      const { saturation, lightness } = chroma(c.hex);
      return (
        saturation >= ACCENT_MIN_SATURATION &&
        lightness >= ACCENT_LIGHTNESS_RANGE[0] &&
        lightness <= ACCENT_LIGHTNESS_RANGE[1]
      );
    })
    .sort((a, b) => {
      // 0 = the render shows it, 1 = declared only (or nothing was rendered).
      const shown = (c: ObservedColor) => ((c.paintedShare ?? 0) > 0 ? 0 : 1);
      const named = (c: ObservedColor) => (c.cssVars.some((n) => BRAND_MEANING_NAME_RE.test(n)) ? 0 : 1);
      return (
        shown(a) - shown(b) ||
        named(a) - named(b) ||
        (b.paintedShare ?? 0) - (a.paintedShare ?? 0) ||
        chroma(b.hex).saturation - chroma(a.hex).saturation
      );
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
