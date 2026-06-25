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

/** Perceived luminance (0-255). */
function getLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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

/** Check whether body/root CSS or meta theme-color signals a dark background. */
function detectDarkBackground(html: string, styleBlocks: string): boolean {
  // color-scheme: dark declaration
  if (/color-scheme\s*:\s*dark/i.test(styleBlocks)) return true;
  // data-theme or class="dark" on html/body
  if (/<(?:html|body)[^>]+(?:data-theme=["']dark["']|class=["'][^"']*\bdark\b)/i.test(html)) return true;

  // Body/html/root background-color
  const bgPattern = /(?:body|html|:root)\s*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/gi;
  let m: RegExpExecArray | null;
  while ((m = bgPattern.exec(styleBlocks)) !== null) {
    const hex = normalizeHex(m[1]);
    if (hex && getLuminance(hex) < 28) return true;
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
   Scraper
   ──────────────────────────────────────────────────────────────────────── */

export type ScrapedBranding = Omit<BrandingGuidelines, "updatedAt">;

/**
 * Fetch a client's website and extract brand colors, fonts, and visual style.
 *
 * Signal priority (colors):
 *   1. <meta name="theme-color"> — explicit, authoritative
 *   2. CSS custom properties matching brand/primary/accent/main/hero/key names
 *   3. Inline style= background/background-color attributes
 *   4. Tailwind arbitrary-value bg-[#hex] classes in HTML
 *   5. Frequency-ranked hex values from <style> blocks (grays/neutrals filtered)
 *
 * Signal priority (fonts):
 *   1. Google Fonts <link> / @import
 *   2. @font-face declarations in <style> blocks
 *
 * Visual style: classified from color palette characteristics, dark-background
 * detection, and font category (serif / monospace / sans-serif).
 */
export async function scrapeWebsiteBranding(url: string): Promise<ScrapedBranding | null> {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(9000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KarosCMO/1.0; +https://karoslabs.com)" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // ── 1. <meta name="theme-color"> ───────────────────────────────────
    const themeColor =
      normalizeHex(
        html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i)?.[1] ??
        html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,8})["'][^>]+name=["']theme-color["']/i)?.[1] ??
        "",
      ) ?? undefined;

    // ── 2. Collect all <style> block content ───────────────────────────
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
      .map((m) => m[1])
      .join("\n");

    const hasDarkBg = detectDarkBackground(html, styleBlocks);

    // ── 3. CSS custom property colors (--primary-*, --brand-*, etc.) ───
    const cssVarPattern =
      /--(?:[\w-]*(?:primary|brand|accent|main|key|hero|highlight|theme|color)[\w-]*):\s*(#[0-9a-fA-F]{3,8})/gi;
    const cssVarColors: string[] = [];
    let m: RegExpExecArray | null;
    const cssVarCopy = new RegExp(cssVarPattern.source, cssVarPattern.flags);
    while ((m = cssVarCopy.exec(styleBlocks)) !== null) {
      const hex = normalizeHex(m[1]);
      if (hex && isUsableColor(hex) && !cssVarColors.includes(hex)) cssVarColors.push(hex);
    }

    // ── 4. Inline style background colors ─────────────────────────────
    const inlineStyleColors: string[] = [];
    const inlinePat = /style=["'][^"']*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/gi;
    const inlineCopy = new RegExp(inlinePat.source, inlinePat.flags);
    while ((m = inlineCopy.exec(html)) !== null) {
      const hex = normalizeHex(m[1]);
      if (hex && isUsableColor(hex) && !inlineStyleColors.includes(hex)) inlineStyleColors.push(hex);
    }

    // ── 5. Tailwind arbitrary bg-[#hex] values in the HTML ─────────────
    const tailwindColors: string[] = [];
    const twPat = /\bbg-\[#([0-9a-fA-F]{3,8})\]/gi;
    const twCopy = new RegExp(twPat.source, twPat.flags);
    while ((m = twCopy.exec(html)) !== null) {
      const hex = normalizeHex("#" + m[1]);
      if (hex && isUsableColor(hex) && !tailwindColors.includes(hex)) tailwindColors.push(hex);
    }

    // ── 6. Frequency-ranked hex colors from <style> blocks (fallback) ──
    const freqMap = new Map<string, number>();
    const hexScan = /#([0-9a-fA-F]{3,8})\b/g;
    while ((m = hexScan.exec(styleBlocks)) !== null) {
      const hex = normalizeHex("#" + m[1]);
      if (hex && isUsableColor(hex)) freqMap.set(hex, (freqMap.get(hex) ?? 0) + 1);
    }
    const freqColors = [...freqMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c)
      .filter((c) => !cssVarColors.includes(c) && !tailwindColors.includes(c));

    // ── 7. Google Fonts from <link> tags and @import rules ─────────────
    const gfMatches = [
      ...html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;>\s]+)/gi),
      ...styleBlocks.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&;)\s]+)/gi),
    ];
    const googleFonts = gfMatches
      .flatMap((match) =>
        decodeURIComponent(match[1])
          .split("|")
          .map((f) => f.split(":")[0].replace(/\+/g, " ").trim()),
      )
      .filter((f, i, a) => f && a.indexOf(f) === i);

    // ── 8. @font-face family names from <style> blocks ─────────────────
    const fontFacePattern = /@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"}{]+)/gi;
    const localFonts: string[] = [];
    while ((m = fontFacePattern.exec(styleBlocks)) !== null) {
      const family = m[1].trim().replace(/^['"]|['"]$/g, "");
      if (family && !localFonts.includes(family)) localFonts.push(family);
    }

    // ── 9. Assemble color pool: explicit signals beat frequency stats ───
    const colorPool = [
      themeColor,
      ...cssVarColors,
      ...tailwindColors,
      ...inlineStyleColors,
      ...freqColors,
    ].filter((c): c is string => !!c);

    const primaryColor = colorPool[0];
    const secondaryColor = colorPool.find((c) => c !== primaryColor);
    const allFonts = [...googleFonts, ...localFonts];

    if (!primaryColor && allFonts.length === 0) return null;

    const visualStyle = classifyVisualStyle(
      colorPool.filter(isUsableColor),
      allFonts,
      hasDarkBg,
      colorPool.filter(isUsableColor).length,
    );

    return {
      primaryColor: primaryColor ?? undefined,
      secondaryColor: secondaryColor ?? undefined,
      fontHeading: allFonts[0] ?? undefined,
      fontBody: (allFonts[1] ?? allFonts[0]) ?? undefined,
      visualStyle,
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
  source: "scraped" | "preset";
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
  if (client.website) scraped = await scrapeWebsiteBranding(client.website);

  const source: "scraped" | "preset" = scraped ? "scraped" : "preset";
  const generated = scraped ?? BRANDING_PRESETS[Math.floor(Math.random() * BRANDING_PRESETS.length)];

  // Preserve manually curated tone keywords, guidelines, and logo
  const existing = client.brandingGuidelines;
  const merged: Omit<BrandingGuidelines, "updatedAt"> = {
    ...generated,
    toneKeywords: existing?.toneKeywords?.length ? existing.toneKeywords : generated.toneKeywords,
    guidelines: existing?.guidelines ?? generated.guidelines,
    logoUrl: existing?.logoUrl ?? generated.logoUrl,
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
