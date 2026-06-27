import "server-only";

import {
  getClient,
  getClientContextDoc,
  updateClient,
  upsertClientContextDoc,
} from "@/lib/data";
import type { BrandingGuidelines, Client } from "@/lib/types";

/* ─────────────────────────────────────────────────────────────────────────
   Color helpers
   ──────────────────────────────────────────────────────────────────────── */

/** Expand 3-digit hex to 6-digit, strip alpha from 8-digit. Returns null if invalid. */
export function normalizeHex(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (/^#[0-9a-f]{6}$/.test(h)) return h;
  if (/^#[0-9a-f]{8}$/.test(h)) return h.slice(0, 7);
  return null;
}

/** Perceived luminance (0–255). */
function getLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Max-min channel spread — proxy for perceptual saturation. */
function getSaturation(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/**
 * Reject near-black, near-white, and neutral grays — these are not
 * meaningful brand colors when extracted by frequency analysis.
 */
export function isUsableColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return luminance > 12 && luminance < 235 && saturation > 25;
}

/* ─────────────────────────────────────────────────────────────────────────
   Visual style classifier
   ──────────────────────────────────────────────────────────────────────── */

const SERIF_RE = /Playfair|Garamond|Georgia|Cormorant|Lora|Baskerville|Merriweather|EB Garamond|Libre Baskerville/i;
const MONO_RE = /\bMono\b|Code|Consolas|Courier|Space Mono|Fira Code|JetBrains|Inconsolata/i;

function classifyVisualStyle(
  colorPool: string[],
  fonts: string[],
  hasDarkBg: boolean,
  usableColorCount: number,
): string {
  if (hasDarkBg) return "Dark Mode";
  if (fonts.some((f) => MONO_RE.test(f))) return "High-Tech";

  const dominant = colorPool[0];
  if (!dominant) {
    return fonts.some((f) => SERIF_RE.test(f)) ? "Luxury" : "Minimalist";
  }

  const r = parseInt(dominant.slice(1, 3), 16);
  const g = parseInt(dominant.slice(3, 5), 16);
  const b = parseInt(dominant.slice(5, 7), 16);
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const saturation = maxC - minC;

  const isBluePurple = b > r * 1.2 && b > g * 0.9 && saturation > 50;
  const isGold = r > 155 && g > 105 && b < 85 && saturation > 80;
  const isHighSat = saturation > 90;

  if (isGold && fonts.some((f) => SERIF_RE.test(f))) return "Luxury";
  if (usableColorCount >= 4 && isHighSat && !isBluePurple) return "Vibrant";
  if (isBluePurple) return "High-Tech";
  if (saturation < 40) return fonts.some((f) => SERIF_RE.test(f)) ? "Corporate" : "Minimalist";
  if (isHighSat && r > b && r > g) return "Vibrant";
  return "Corporate";
}

/** Check whether body/root CSS or canvas CSS variables signal a dark background. */
function detectDarkBackground(html: string, styleBlocks: string): boolean {
  // 1. Explicit dark-mode declarations
  if (/color-scheme\s*:\s*dark/i.test(styleBlocks)) return true;
  if (/<(?:html|body)[^>]+(?:data-theme=["']dark["']|class=["'][^"']*\bdark\b)/i.test(html)) return true;

  let m: RegExpExecArray | null;

  // 2. body/html/:root background(-color) set to a very dark hex
  const bgSelectorPat = /(?:body|html|:root)\s*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/gi;
  while ((m = bgSelectorPat.exec(styleBlocks)) !== null) {
    const hex = normalizeHex(m[1]);
    if (hex && getLuminance(hex) < 30) return true;
  }

  // 3. CSS variables named for background/canvas/surface pointing to dark hex
  //    Catches --background: #0A0A0A, --bg: #050505, --surface: #111, etc.
  const bgVarPat =
    /--(?:background|bg|canvas|surface|base|color-bg|color-background)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8})/gi;
  while ((m = bgVarPat.exec(styleBlocks)) !== null) {
    const hex = normalizeHex(m[1]);
    if (hex && getLuminance(hex) < 30) return true;
  }

  return false;
}

/* ─────────────────────────────────────────────────────────────────────────
   Context-doc builders (used by saveBrandingGuidelinesAction too)
   ──────────────────────────────────────────────────────────────────────── */

export function brandingToContextDocContent(g: BrandingGuidelines, clientName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`# Branding Guidelines — ${clientName}`, `_Last updated: ${today}_`, ""];
  if (g.visualStyle) lines.push(`## Visual Style`, `${g.visualStyle}`, "");
  if (g.primaryColor || g.secondaryColor) {
    lines.push("## Color Palette");
    if (g.primaryColor) lines.push(`- **Primary:** ${g.primaryColor}`);
    if (g.secondaryColor) lines.push(`- **Secondary/Accent:** ${g.secondaryColor}`);
    lines.push("");
  }
  if (g.fontHeading || g.fontBody) {
    lines.push("## Typography");
    if (g.fontHeading) lines.push(`- **Heading font:** ${g.fontHeading}`);
    if (g.fontBody) lines.push(`- **Body font:** ${g.fontBody}`);
    lines.push("");
  }
  if (g.toneKeywords?.length) {
    lines.push("## Tone & Voice", `Keywords: ${g.toneKeywords.join(", ")}`, "");
  }
  if (g.guidelines) lines.push("## Brand Guidelines", g.guidelines, "");
  return lines.join("\n");
}

export function buildBrandVoiceSection(g: BrandingGuidelines): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "<!-- BRAND_SYNC_START -->",
    `## Visual & Tone Reference (auto-synced from guidelines · ${today})`,
  ];
  if (g.visualStyle) lines.push(`- **Visual Style:** ${g.visualStyle}`);
  if (g.primaryColor) lines.push(`- **Primary Color:** ${g.primaryColor}`);
  if (g.secondaryColor) lines.push(`- **Secondary Color:** ${g.secondaryColor}`);
  if (g.fontHeading) lines.push(`- **Heading Font:** ${g.fontHeading}`);
  if (g.fontBody) lines.push(`- **Body Font:** ${g.fontBody}`);
  if (g.toneKeywords?.length) lines.push(`- **Tone Keywords:** ${g.toneKeywords.join(", ")}`);
  lines.push(
    "",
    "_This section is auto-synced when branding guidelines are updated. Edit the guidelines UI to change it._",
    "<!-- BRAND_SYNC_END -->",
  );
  return lines.join("\n");
}

export function injectBrandVoiceSection(content: string, section: string): string {
  const START = "<!-- BRAND_SYNC_START -->";
  const END = "<!-- BRAND_SYNC_END -->";
  const startIdx = content.indexOf(START);
  const endIdx = content.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1) {
    return content.slice(0, startIdx) + section + content.slice(endIdx + END.length);
  }
  const fmMatch = content.match(/^---[\s\S]*?---\n/);
  if (fmMatch) {
    const offset = fmMatch[0].length;
    return content.slice(0, offset) + "\n" + section + "\n\n" + content.slice(offset);
  }
  return section + "\n\n" + content;
}

/* ─────────────────────────────────────────────────────────────────────────
   Brand archetype presets (fallback when scraping yields nothing)
   ──────────────────────────────────────────────────────────────────────── */

export const BRANDING_PRESETS: Array<Omit<BrandingGuidelines, "updatedAt">> = [
  {
    primaryColor: "#1E293B",
    secondaryColor: "#6366F1",
    fontHeading: "Inter",
    fontBody: "Inter",
    visualStyle: "High-Tech",
    toneKeywords: ["Innovative", "Precise", "Scalable", "Data-driven"],
    guidelines:
      "## Brand Voice\nDirect and confident. Communicate with precision and remove all fluff.\n\n## Visual Identity\nClean layouts, generous whitespace, and indigo accents to signal interactivity and trust.\n\n## Do's and Don'ts\n- Do: Lead with data and specifics\n- Don't: Use buzzwords or vague claims",
  },
  {
    primaryColor: "#292524",
    secondaryColor: "#D97706",
    fontHeading: "Playfair Display",
    fontBody: "Georgia",
    visualStyle: "Luxury",
    toneKeywords: ["Authentic", "Sustainable", "Human", "Crafted"],
    guidelines:
      "## Brand Voice\nWarm and personal. Speak to people, not customers. Stories over statistics.\n\n## Visual Identity\nOrganic textures, amber accents, and serif typography that convey warmth and craftsmanship.\n\n## Do's and Don'ts\n- Do: Tell the story behind the product\n- Don't: Use corporate or overly technical jargon",
  },
  {
    primaryColor: "#09090B",
    secondaryColor: "#10B981",
    fontHeading: "Montserrat",
    fontBody: "Open Sans",
    visualStyle: "Dark Mode",
    toneKeywords: ["Bold", "Trustworthy", "Challenger", "Performance"],
    guidelines:
      "## Brand Voice\nAssertive and results-oriented. Challenge the status quo with data-backed confidence.\n\n## Visual Identity\nHigh contrast, emerald green for key actions, geometric sans-serif for authority and clarity.\n\n## Do's and Don'ts\n- Do: Use strong, active verbs and concrete metrics\n- Don't: Hedge or soften claims unnecessarily",
  },
];

/* ─────────────────────────────────────────────────────────────────────────
   Scraper — internal helpers + public API
   ──────────────────────────────────────────────────────────────────────── */

export type ScrapedBranding = Omit<BrandingGuidelines, "updatedAt">;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Strings that positively identify a WAF/bot-challenge response body.
// Cloudflare challenge pages include #a7f3d0 / teal variants in their own CSS —
// those colors must NEVER be treated as the target site's brand palette.
const WAF_MARKERS = [
  "__cf_chl",
  "cf-browser-verification",
  "cf-challenge",
  "challenge-error-title",
  "jschl-answer",
  "Checking your browser",
  "Just a moment...",
  "DDoS protection by",
  "Enable JavaScript and cookies to continue",
  "Please enable cookies",
  "Attention Required",
  "Access denied",
  "Your request has been blocked",
  "cf_clearance",
];

/** True when the HTML body is a bot/WAF challenge page, not the real site content. */
function _isWafPage(html: string): boolean {
  const sample = html.slice(0, 5000);
  return WAF_MARKERS.some((marker) => sample.includes(marker));
}

/**
 * Fetch a URL with a browser UA.
 * Returns null only on hard network/DNS failure (ENOTFOUND, timeout, etc.).
 * Always returns the body even on non-2xx so inference can read page text.
 * `blocked` is true when the response is a WAF challenge — CSS must not be extracted.
 */
async function _fetchPage(
  normalized: string,
): Promise<{ html: string; ok: boolean; blocked: boolean } | null> {
  try {
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(12000),
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache",
      },
    });
    const html = await res.text();
    const blocked = !res.ok || _isWafPage(html);
    console.log(
      `[branding:fetch] ${normalized} → HTTP ${res.status} | ${html.length} chars | blocked=${blocked}` +
        (blocked ? ` | sample: ${html.slice(0, 300).replace(/\s+/g, " ")}` : ""),
    );
    return { html, ok: res.ok, blocked };
  } catch (err) {
    console.log(`[branding:fetch] ${normalized} → network error: ${String(err)}`);
    return null;
  }
}

/**
 * Strip an HTML document down to its most informative text signals.
 * Used to prime the LLM inference step when CSS extraction is blocked.
 */
function _extractPageText(html: string): string {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
  const metaDesc =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i)?.[1]?.trim() ??
    html.match(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']description["']/i)?.[1]?.trim() ??
    "";
  const ogDesc =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,300})["']/i)?.[1]?.trim() ?? "";
  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((h) => h.length > 2 && h.length < 200)
    .slice(0, 8)
    .join(" · ");
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
  return [
    title && `Title: ${title}`,
    metaDesc && `Meta description: ${metaDesc}`,
    ogDesc && ogDesc !== metaDesc && `OG description: ${ogDesc}`,
    headings && `Headings: ${headings}`,
    bodyText && `Page text: ${bodyText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Run the full CSS token-extraction pipeline on an already-fetched HTML string.
 * Returns null when no meaningful brand tokens are found (WAF challenge page, sparse HTML).
 */
async function _extractBrandTokens(
  html: string,
  normalizedUrl: string,
): Promise<ScrapedBranding | null> {
  // Hard gate: challenge pages contain generic platform CSS (Cloudflare uses
  // teal/green tones like #a7f3d0) that are NOT brand colors of the target site.
  if (_isWafPage(html)) {
    console.log("[branding:extract] WAF page detected — skipping CSS extraction");
    return null;
  }

  // ── 1. <meta name="theme-color"> ─────────────────────────────────────────
  const themeColor =
    normalizeHex(
      html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,8})["'][^>]+name=["']theme-color["']/i)?.[1] ??
      "",
    ) ?? undefined;

  // ── 2. Inline <style> blocks + same-origin external stylesheets ──────────
  const inlineBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n");

  const baseOrigin = new URL(normalizedUrl).origin;
  const hrefRe1 = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi;
  const hrefRe2 = /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["']/gi;
  const rawHrefs: string[] = [];
  let lm: RegExpExecArray | null;
  while ((lm = hrefRe1.exec(html)) !== null) rawHrefs.push(lm[1]);
  while ((lm = hrefRe2.exec(html)) !== null) rawHrefs.push(lm[1]);
  const cssUrls = rawHrefs
    .map((href) => {
      try {
        const u = new URL(href, normalizedUrl);
        return u.origin === baseOrigin ? u.href : null;
      } catch { return null; }
    })
    .filter((u): u is string => !!u)
    .slice(0, 5);
  const externalCss = await Promise.all(
    cssUrls.map(async (cssUrl) => {
      try {
        const r = await fetch(cssUrl, {
          signal: AbortSignal.timeout(5000),
          headers: { "User-Agent": BROWSER_UA },
        });
        return r.ok ? await r.text() : "";
      } catch { return ""; }
    }),
  );
  const styleBlocks = [inlineBlocks, ...externalCss].join("\n");

  const hasDarkBg = detectDarkBackground(html, styleBlocks);

  let m: RegExpExecArray | null;

  // ── 3a. Tier-1 CSS vars: semantically named brand / accent vars ──────────
  const brandVarPat =
    /--(?:[\w-]*(?:primary|brand|accent|main|key|hero|highlight|theme|color|cta|focus|active|link)[\w-]*):\s*(#[0-9a-fA-F]{3,8})/gi;
  const brandVarColors: string[] = [];
  while ((m = brandVarPat.exec(styleBlocks)) !== null) {
    const hex = normalizeHex(m[1]);
    if (hex && isUsableColor(hex) && !brandVarColors.includes(hex)) brandVarColors.push(hex);
  }

  // ── 3b. Tier-2 CSS vars: any var pointing to a high-saturation hex ───────
  const allVarPat = /--[\w-]+\s*:\s*(#[0-9a-fA-F]{3,8})/gi;
  const highSatVarColors: string[] = [];
  const brandVarSet = new Set(brandVarColors);
  while ((m = allVarPat.exec(styleBlocks)) !== null) {
    const hex = normalizeHex(m[1]);
    if (hex && isUsableColor(hex) && !brandVarSet.has(hex) && getSaturation(hex) > 60) {
      if (!highSatVarColors.includes(hex)) highSatVarColors.push(hex);
    }
  }

  // ── 4. Inline style= background/background-color attributes ─────────────
  const inlineStyleColors: string[] = [];
  const inlinePat = /style=["'][^"']*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/gi;
  while ((m = inlinePat.exec(html)) !== null) {
    const hex = normalizeHex(m[1]);
    if (hex && isUsableColor(hex) && !inlineStyleColors.includes(hex)) inlineStyleColors.push(hex);
  }

  // ── 5. Tailwind arbitrary bg-[#hex] class values ─────────────────────────
  const tailwindColors: string[] = [];
  const twPat = /\bbg-\[#([0-9a-fA-F]{3,8})\]/gi;
  while ((m = twPat.exec(html)) !== null) {
    const hex = normalizeHex("#" + m[1]);
    if (hex && isUsableColor(hex) && !tailwindColors.includes(hex)) tailwindColors.push(hex);
  }

  // ── 6. Frequency-ranked hex scan across full CSS corpus ─────────────────
  const freqMap = new Map<string, number>();
  const hexScan = /#([0-9a-fA-F]{3,8})\b/g;
  while ((m = hexScan.exec(styleBlocks)) !== null) {
    const hex = normalizeHex("#" + m[1]);
    if (hex && isUsableColor(hex)) freqMap.set(hex, (freqMap.get(hex) ?? 0) + 1);
  }
  const knownSet = new Set([...brandVarColors, ...highSatVarColors, ...tailwindColors]);
  const freqColors = [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c)
    .filter((c) => !knownSet.has(c));

  // ── 7a. Google Fonts ──────────────────────────────────────────────────────
  const googleFonts = [
    ...html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;>\s]+)/gi),
    ...styleBlocks.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;)\s]+)/gi),
  ]
    .flatMap((match) =>
      decodeURIComponent(match[1])
        .split("|")
        .map((f) => f.split(":")[0].replace(/\+/g, " ").trim()),
    )
    .filter((f, i, a) => f && a.indexOf(f) === i);

  // ── 7b. Bunny Fonts ───────────────────────────────────────────────────────
  const bunnyFonts = [
    ...html.matchAll(/fonts\.bunny\.net\/css\?family=([^"'&;>\s]+)/gi),
    ...styleBlocks.matchAll(/fonts\.bunny\.net\/css\?family=([^"'&;)\s]+)/gi),
  ]
    .flatMap((match) =>
      decodeURIComponent(match[1])
        .split("|")
        .map((f) => f.split(":")[0].replace(/\+/g, " ").trim()),
    )
    .filter((f, i, a) => f && a.indexOf(f) === i);

  // ── 8. @font-face declarations ────────────────────────────────────────────
  const fontFacePat = /@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"}{]+)/gi;
  const localFonts: string[] = [];
  while ((m = fontFacePat.exec(styleBlocks)) !== null) {
    const family = m[1].trim().replace(/^['"]|['"]$/g, "");
    if (family && !localFonts.includes(family)) localFonts.push(family);
  }

  // ── 9. font-family from selector bodies: body, html, :root, h1, h2 ───────
  const fontSelectorPat =
    /(?:body|html|:root|h[1-2])\s*\{[^}]*font-family\s*:\s*['"]?([^;,'"}{]+)/gi;
  const selectorFonts: string[] = [];
  while ((m = fontSelectorPat.exec(styleBlocks)) !== null) {
    const first = m[1].split(",")[0].trim().replace(/^['"]|['"]$/g, "").trim();
    if (
      first.length > 1 &&
      !first.toLowerCase().startsWith("var(") &&
      !/^(inherit|initial|unset|revert|sans-serif|serif|monospace|cursive|fantasy|system-ui|-apple-system|BlinkMacSystemFont)$/i.test(first)
    ) {
      selectorFonts.push(first);
    }
  }

  // ── 10. CSS variable font declarations ────────────────────────────────────
  const fontVarPat =
    /--(?:font|typeface|heading|body|sans|serif|display|text)[\w-]*\s*:\s*['"]([^'"]+)['"]/gi;
  const varFonts: string[] = [];
  while ((m = fontVarPat.exec(styleBlocks)) !== null) {
    const raw = m[1].trim().split(",")[0].replace(/^['"]|['"]$/g, "").trim();
    if (raw.length > 1 && !raw.toLowerCase().startsWith("var(")) varFonts.push(raw);
  }

  // ── 11. Assemble pools ────────────────────────────────────────────────────
  const colorPool = [
    themeColor,
    ...brandVarColors,
    ...highSatVarColors,
    ...tailwindColors,
    ...inlineStyleColors,
    ...freqColors,
  ].filter((c): c is string => !!c);

  const allFonts = [...googleFonts, ...bunnyFonts, ...selectorFonts, ...varFonts, ...localFonts].filter(
    (f, i, a) => a.indexOf(f) === i,
  );

  if (!colorPool.length && allFonts.length === 0) return null;

  // ── 12. Select primary + secondary colors ─────────────────────────────────
  const primaryColor = colorPool[0];
  let secondaryColor: string | undefined;
  if (hasDarkBg && colorPool.length > 1) {
    secondaryColor = colorPool
      .filter((c) => c !== primaryColor)
      .sort((a, b) => getSaturation(b) - getSaturation(a))[0];
  } else {
    secondaryColor = colorPool.find((c) => c !== primaryColor);
  }

  const visualStyle = classifyVisualStyle(
    colorPool.filter(isUsableColor),
    allFonts,
    hasDarkBg,
    colorPool.filter(isUsableColor).length,
  );

  return {
    primaryColor: primaryColor ?? undefined,
    secondaryColor,
    fontHeading: allFonts[0] ?? undefined,
    fontBody: (allFonts[1] ?? allFonts[0]) ?? undefined,
    visualStyle,
  };
}

/**
 * Public API: fetch a website and extract brand tokens.
 * Returns null when the fetch fails or no meaningful tokens were found.
 */
export async function scrapeWebsiteBranding(url: string): Promise<ScrapedBranding | null> {
  let normalized: string;
  try {
    normalized = url.startsWith("http") ? url : `https://${url}`;
    new URL(normalized);
  } catch {
    return null;
  }
  const page = await _fetchPage(normalized);
  if (!page) return null;
  return _extractBrandTokens(page.html, normalized);
}

/* ─────────────────────────────────────────────────────────────────────────
   LLM inference fallback (when scraping is blocked or yields nothing)
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Ask Claude Haiku to infer a brand visual system from actual page content
 * plus client metadata. Always receives real page text when available — never
 * guesses from domain name alone.
 *
 * @param pageText  Plain-text extracted from the page via _extractPageText().
 *                  Pass null only when the site is completely unreachable.
 */
async function inferBrandingFromContext(
  client: Client,
  pageText: string | null,
): Promise<ScrapedBranding | null> {
  try {
    const { generateObject } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");
    const { z } = await import("zod");

    const InferredSchema = z.object({
      primaryColor: z.string().describe("Dominant brand color as 6-digit lowercase hex (e.g. #7c3aed)"),
      secondaryColor: z.string().optional().describe("Accent / secondary brand color as 6-digit lowercase hex"),
      fontHeading: z.string().optional().describe("Primary heading font name (e.g. Plus Jakarta Sans)"),
      fontBody: z.string().optional().describe("Body text font name (e.g. Inter)"),
      visualStyle: z
        .enum(["Dark Mode", "High-Tech", "Luxury", "Vibrant", "Corporate", "Minimalist"])
        .describe("Overall visual style archetype"),
      confidence: z
        .enum(["high", "medium", "low"])
        .describe("Confidence level based on available evidence"),
    });

    const parts: string[] = [];
    if (client.name) parts.push(`Company name: ${client.name}`);
    if (client.website) parts.push(`Website URL: ${client.website}`);
    if ((client as { industry?: string }).industry)
      parts.push(`Industry: ${(client as { industry?: string }).industry}`);
    if ((client as { description?: string }).description)
      parts.push(`Internal description: ${(client as { description?: string }).description}`);
    if (pageText) parts.push(`\n--- Scraped page content ---\n${pageText}\n--- End ---`);

    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5-20251001"),
      schema: InferredSchema,
      system: `You are a senior brand visual analyst. Infer the company's visual brand identity from the evidence provided.

PRIORITY ORDER — apply signals in this order:
1. Scraped page content (title, headings, body text) — most reliable
2. Industry field
3. Company name — least reliable, use only to break ties

HARD RULES:
- Read the page content carefully before deciding. Look for explicit visual cues: dark/light references, technology words, luxury signals, color names mentioned in copy, taglines about being bold/neon/digital.
- If the page content is a WAF/bot-challenge (Cloudflare, "Attention Required", "Access Denied", "Just a moment") — ignore it entirely and rely on industry + name only.
- Do NOT output "Sustainable", "Eco", or green-nature palettes unless the page/description explicitly mentions environmental work, sustainability, agriculture, or eco products.
- When signals are ambiguous, default to "High-Tech" with a dark canvas (#09090b) and an electric indigo/purple accent (#6366f1). This is the safest neutral-tech default and correct for the majority of digital-first companies.

Industry quick-reference (use when page content is unavailable or ambiguous):
- Digital agency / creative studio / marketing / branding → "Dark Mode"; vibrant neon accent (purple #7c3aed, magenta #d946ef, or cyan #06b6d4); geometric sans-serif (Plus Jakarta Sans, Inter, Space Grotesk, Geist)
- SaaS / AI / developer tools / software → "High-Tech"; dark slate + electric indigo/cyan; Inter or monospace-adjacent
- Luxury / fashion / hospitality / jewelry → "Luxury"; warm black or ivory; gold #d97706 or champagne; serif heading (Playfair Display, Cormorant)
- Finance / legal / healthcare / consulting / insurance → "Corporate"; navy/slate #1e3a5f; muted blue-grey; Inter or Open Sans
- E-commerce / consumer retail → "Vibrant"; bright energetic primary; modern sans-serif

Return hex values in 6-digit lowercase format only (#rrggbb). Font names must be real font family names.`,
      prompt: parts.join("\n"),
    });

    // Discard low-confidence guesses made with no page content — pure hallucination risk
    if (object.confidence === "low" && !pageText) return null;

    const primary = normalizeHex(object.primaryColor);
    if (!primary) return null;

    return {
      primaryColor: primary,
      secondaryColor: object.secondaryColor ? (normalizeHex(object.secondaryColor) ?? undefined) : undefined,
      fontHeading: object.fontHeading,
      fontBody: object.fontBody ?? object.fontHeading,
      visualStyle: object.visualStyle,
    };
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Guards
   ──────────────────────────────────────────────────────────────────────── */

/** True when the client has no meaningful branding data (colors and fonts both absent). */
export function isBrandingEmpty(client: Client): boolean {
  const g = client.brandingGuidelines;
  return !g || (!g.primaryColor && !g.secondaryColor && !g.fontHeading && !g.fontBody);
}

/* ─────────────────────────────────────────────────────────────────────────
   Core generator (no auth — call from actions.ts or intel pipeline)
   ──────────────────────────────────────────────────────────────────────── */

export type BrandingGenResult = {
  source: "scraped" | "inferred" | "preset";
  primaryColor?: string;
  secondaryColor?: string;
  visualStyle?: string;
};

/**
 * Scrape the client's website for brand tokens; fall back to a preset archetype
 * if scraping yields nothing. Writes the client record and both context docs.
 *
 * No auth checks — the caller (server action or pipeline) is responsible for those.
 */
export async function applyBrandingForClient(
  clientId: string,
  knownClient?: Client,
): Promise<BrandingGenResult> {
  const client = knownClient ?? (await getClient(clientId));
  if (!client) throw new Error(`Client not found: ${clientId}`);

  let scraped: ScrapedBranding | null = null;
  let inferred: ScrapedBranding | null = null;
  const websiteUrl = client.website?.trim();

  if (websiteUrl) {
    let normalized = "";
    try {
      normalized = websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`;
      new URL(normalized);
    } catch {
      normalized = "";
    }

    if (normalized) {
      // Fetch once — share the HTML between extraction and inference so nothing is discarded.
      const page = await _fetchPage(normalized);
      if (page) {
        if (!page.blocked) {
          // Real page: attempt CSS extraction.
          scraped = await _extractBrandTokens(page.html, normalized);
        }
        if (!scraped) {
          // WAF block or no extractable tokens — pass the page text to the LLM.
          // The system prompt tells it to ignore challenge-page content and rely on metadata.
          const pageText = _extractPageText(page.html);
          inferred = await inferBrandingFromContext(client, pageText || null);
        }
      } else {
        // Hard network failure (DNS/timeout) — infer from client metadata only.
        inferred = await inferBrandingFromContext(client, null);
      }
    }
  }

  const source: "scraped" | "inferred" | "preset" = scraped
    ? "scraped"
    : inferred
      ? "inferred"
      : "preset";

  // When a website was provided but both scraping and inference failed,
  // use the High-Tech preset (index 0) — not a random one that could land
  // on the Luxury/Sustainable archetype which is wrong for digital agencies.
  const generated =
    scraped ??
    inferred ??
    (websiteUrl ? BRANDING_PRESETS[0] : BRANDING_PRESETS[Math.floor(Math.random() * BRANDING_PRESETS.length)]);

  // Destructive overwrite of all auto-generated fields so stale data from a
  // previous run (e.g. old preset guidelines) never bleeds into a fresh scrape.
  // logoUrl is the only field preserved — it is always manually uploaded, never generated.
  const existing = client.brandingGuidelines;
  const merged: Omit<BrandingGuidelines, "updatedAt"> = {
    ...generated,
    logoUrl: existing?.logoUrl,
  };

  const fullGuidelines: BrandingGuidelines = { ...merged, updatedAt: Date.now() };
  const now = Date.now();

  const [brandingDoc, voiceDoc] = await Promise.all([
    getClientContextDoc(clientId, "branding-guidelines"),
    getClientContextDoc(clientId, "brand-voice"),
  ]);

  await Promise.all([
    updateClient(clientId, { brandingGuidelines: fullGuidelines }),
    upsertClientContextDoc({
      clientId,
      docType: "branding-guidelines",
      tier: brandingDoc?.tier ?? "internal",
      content: brandingToContextDocContent(fullGuidelines, client.name),
      version: (brandingDoc?.version ?? 0) + 1,
      sources: brandingDoc?.sources,
      createdAt: brandingDoc?.createdAt ?? now,
      updatedAt: now,
    }),
    voiceDoc
      ? upsertClientContextDoc({
          clientId,
          docType: "brand-voice",
          tier: voiceDoc.tier,
          content: injectBrandVoiceSection(voiceDoc.content, buildBrandVoiceSection(fullGuidelines)),
          version: voiceDoc.version + 1,
          sources: voiceDoc.sources,
          createdAt: voiceDoc.createdAt,
          updatedAt: now,
        })
      : Promise.resolve(),
  ]);

  return { source, primaryColor: fullGuidelines.primaryColor, secondaryColor: fullGuidelines.secondaryColor, visualStyle: fullGuidelines.visualStyle };
}
