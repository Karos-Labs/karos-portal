import "server-only";

import { generateObject, generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import { z } from "zod";
import {
  getClient,
  getClientContextDoc,
  updateClient,
  upsertClientContextDoc,
} from "@/lib/data";
import type { BrandColor, BrandingGuidelines, Client } from "@/lib/types";
import { logger, readWebSearchCount } from "@/services/logger";

/* ─────────────────────────────────────────────────────────────────────────
   Color helper
   ──────────────────────────────────────────────────────────────────────── */

/** Expand 3-digit hex to 6-digit, strip alpha from 8-digit. Returns null if invalid. */
export function normalizeHex(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (/^#[0-9a-f]{6}$/.test(h)) return h;
  if (/^#[0-9a-f]{8}$/.test(h)) return h.slice(0, 7);
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────
   Palette helpers — new + legacy compat
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Returns the effective dominant colors for a BrandingGuidelines record.
 * Prefers the new `dominantColors` array; synthesizes from legacy scalar
 * fields if the array is absent (backward compat for pre-migration docs).
 */
export function effectiveDominantColors(g: BrandingGuidelines): BrandColor[] {
  if (g.dominantColors?.length) return g.dominantColors;
  const colors: BrandColor[] = [];
  const add = (hex: string | undefined, rank: number) => {
    if (hex) colors.push({ hex, dominanceRank: rank });
  };
  add(g.primaryAccent ?? g.primaryColor, 1);
  add(g.secondaryAccent ?? g.secondaryColor, 2);
  add(g.brandNeutralDark ?? g.uiBackground, 3);
  add(g.brandNeutralLight ?? g.uiText, 4);
  return colors;
}

/** Returns the effective primary accent — new field first, legacy fallback. */
export function effectivePrimaryAccent(g: BrandingGuidelines): string | undefined {
  return g.dominantColors?.[0]?.hex ?? g.primaryAccent ?? g.primaryColor;
}

/** Returns the effective secondary accent — new field first, legacy fallback. */
export function effectiveSecondaryAccent(g: BrandingGuidelines): string | undefined {
  return g.dominantColors?.[1]?.hex ?? g.secondaryAccent ?? g.secondaryColor;
}

/** Returns the effective neutral dark — new field first, legacy fallbacks. */
export function effectiveNeutralDark(g: BrandingGuidelines): string | undefined {
  return g.dominantColors?.[2]?.hex ?? g.brandNeutralDark ?? g.uiBackground ?? g.uiText;
}

/** Returns the effective neutral light — new field first, legacy fallback. */
export function effectiveNeutralLight(g: BrandingGuidelines): string | undefined {
  return g.dominantColors?.[3]?.hex ?? g.brandNeutralLight ?? g.uiText ?? g.uiBackground;
}

/* ─────────────────────────────────────────────────────────────────────────
   Context-doc builders
   ──────────────────────────────────────────────────────────────────────── */

export function brandingToContextDocContent(g: BrandingGuidelines, clientName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`# Branding Guidelines — ${clientName}`, `_Last updated: ${today}_`, ""];
  if (g.visualStyle) lines.push("## Visual Style", g.visualStyle, "");

  if (g.dominantColors?.length) {
    lines.push("## Color Palette");
    g.dominantColors.forEach((c) => {
      const label = c.role ? `Color ${c.dominanceRank} — ${c.role}` : `Color ${c.dominanceRank}`;
      lines.push(`- **${label}:** ${c.hex}`);
    });
    lines.push("");
  } else {
    // Legacy format — preserve field names so existing parsers continue to work
    const pa = effectivePrimaryAccent(g);
    const sa = effectiveSecondaryAccent(g);
    const nd = g.brandNeutralDark ?? g.uiBackground;
    const nl = g.brandNeutralLight ?? g.uiText;
    if (pa || sa || nd || nl) {
      lines.push("## Color Palette");
      if (pa) lines.push(`- **Primary Accent:** ${pa}`);
      if (sa) lines.push(`- **Secondary Accent:** ${sa}`);
      if (nd) lines.push(`- **Neutral Dark:** ${nd}`);
      if (nl) lines.push(`- **Neutral Light:** ${nl}`);
      lines.push("");
    }
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

  if (g.dominantColors?.length) {
    g.dominantColors.forEach((c) => {
      const label = c.role ? `Color ${c.dominanceRank} (${c.role})` : `Color ${c.dominanceRank}`;
      lines.push(`- **${label}:** ${c.hex}`);
    });
  } else {
    // Legacy fallback
    const pa = effectivePrimaryAccent(g);
    const sa = effectiveSecondaryAccent(g);
    const nd = g.brandNeutralDark ?? g.uiBackground;
    const nl = g.brandNeutralLight ?? g.uiText;
    if (pa) lines.push(`- **Primary Accent:** ${pa}`);
    if (sa) lines.push(`- **Secondary Accent:** ${sa}`);
    if (nd) lines.push(`- **Neutral Dark:** ${nd}`);
    if (nl) lines.push(`- **Neutral Light:** ${nl}`);
  }

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
   Logo vision helpers
   ──────────────────────────────────────────────────────────────────────── */

type LogoContext =
  | { kind: "vision"; imageBytes: Buffer; mimeType: "image/png" | "image/jpeg" }
  | { kind: "svg"; colors: string[] }
  | null;

/** Extract unique hex color values from SVG XML source. */
function extractColorsFromSvg(svgText: string): string[] {
  const seen = new Set<string>();

  for (const m of svgText.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const n = normalizeHex(`#${m[1]}`);
    if (n && n !== "#000000" && n !== "#ffffff") seen.add(n);
  }

  for (const m of svgText.matchAll(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    const r = parseInt(m[1]).toString(16).padStart(2, "0");
    const g = parseInt(m[2]).toString(16).padStart(2, "0");
    const b = parseInt(m[3]).toString(16).padStart(2, "0");
    const n = normalizeHex(`#${r}${g}${b}`);
    if (n && n !== "#000000" && n !== "#ffffff") seen.add(n);
  }

  return [...seen].slice(0, 20);
}

/**
 * Fetch the logo at the given URL and return a typed context object:
 *   "vision" — PNG/JPEG bytes ready to pass to Claude as an image part
 *   "svg"    — extracted hex colors from the SVG XML source
 *   null     — fetch failed or unrecognised format (graceful no-op)
 */
async function prepareLogoContext(logoUrl: string): Promise<LogoContext> {
  try {
    const res = await fetch(logoUrl, {
      headers: { Accept: "image/png,image/jpeg,image/svg+xml,image/*" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const ct = (res.headers.get("content-type") ?? "").toLowerCase();

    if (ct.includes("svg")) {
      const text = await res.text();
      const colors = extractColorsFromSvg(text);
      return colors.length ? { kind: "svg", colors } : null;
    }

    if (ct.includes("png") || ct.includes("jpeg") || ct.includes("jpg")) {
      const mimeType: "image/png" | "image/jpeg" = ct.includes("png") ? "image/png" : "image/jpeg";
      const imageBytes = Buffer.from(await res.arrayBuffer());
      return { kind: "vision", imageBytes, mimeType };
    }

    return null;
  } catch (err) {
    console.warn("[branding] Logo fetch failed:", err);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Multi-tier site access & intelligence layer
   ──────────────────────────────────────────────────────────────────────── */

type SiteAccessState = "accessible" | "blocked" | "unknown";

const CHALLENGE_SIGNATURES = [
  "just a moment",
  "cf-browser-verification",
  "challenge-platform",
  "__cf_chl_opt",
  "ddos-guard",
  "verifying you are human",
  "enable javascript and cookies",
] as const;

/**
 * Lightweight HTTP probe — determines whether the site responds normally or is
 * shielded by a bot-protection layer (Cloudflare, DDoS-Guard, etc.).
 * Returns "unknown" on network errors (DNS failure, TLS mismatch, timeout).
 */
async function checkSiteAccess(url: string): Promise<SiteAccessState> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
      },
      signal: AbortSignal.timeout(6_000),
      redirect: "follow",
    });

    if (res.status === 403 || res.status === 401 || res.status === 429 || res.status >= 500) {
      return "blocked";
    }
    if (res.status !== 200) return "unknown";

    const body = await res.text();
    if (body.trim().length < 200) return "blocked";

    const lower = body.toLowerCase();
    if (CHALLENGE_SIGNATURES.some((sig) => lower.includes(sig))) return "blocked";

    return "accessible";
  } catch {
    return "unknown";
  }
}

const ANALYST_SYSTEM =
  "You are a brand design intelligence agent. Extract a complete visual identity profile — typography AND colors — " +
  "from a live website by reading its actual HTML and CSS. " +
  "TYPOGRAPHY (highest value): Find font-family on h1, h2, body, p. " +
  "Check <link> tags for fonts.googleapis.com URLs (font names are in the ?family= param). " +
  "Look for @font-face rules and CSS custom properties like --font-heading, --font-sans, --font-body. " +
  "COLORS BY FUNCTIONAL ROLE: Do not just list hex values — group by role: " +
  "nav/header background, hero/page background, primary CTA button background, link/interactive color, " +
  "brand CSS custom properties (--primary, --accent, --brand-*, --cta-*, --color-*). " +
  "METHODOLOGY: Fetch homepage → find stylesheet <link> tags → fetch main stylesheet. " +
  "Return a structured report using these exact labels: " +
  "HEADING_FONT: / BODY_FONT: / FONT_SOURCE: / NAV_BG: / HERO_BG: / CTA_BUTTON_BG: / CTA_BUTTON_TEXT: / BRAND_CSS_VARS: / NOTES: " +
  "Use 'not found' when a value is absent. Cite the source (CSS selector, property name, or URL) for each value.";

/**
 * Two-branch intelligence gathering using Claude's native tools:
 *   • accessible → webFetch pulls HTML/CSS from the live site
 *   • blocked    → webSearch finds brand guidelines / press kits / design systems
 *   • unknown    → returns null; caller falls back to training-data-only prompt
 */
async function gatherSiteIntelligence(
  domain: string,
  clientName: string,
  access: SiteAccessState,
  clientId: string,
): Promise<string | null> {
  if (access === "unknown") return null;

  try {
    if (access === "accessible") {
      const siteUrl = `https://${domain}`;
      const { text, usage, providerMetadata } = await generateText({
        model: anthropic(MODELS.HAIKU),
        stopWhen: stepCountIs(8),
        tools: {
          webFetch: anthropic.tools.webFetch_20250910({}),
        },
        system: ANALYST_SYSTEM,
        prompt:
          `Extract the complete visual identity profile for ${siteUrl}. ` +
          `Phase 1 — Fetch the homepage HTML. Look for: ` +
          `(a) <link rel="stylesheet"> href values (save these URLs for Phase 2), ` +
          `(b) <link> tags pointing to fonts.googleapis.com — copy the full URL, font names are in ?family= params, ` +
          `(c) Inline style hex colors on <nav>, <header>, <button>, and prominent <a> elements. ` +
          `Phase 2 — Fetch the main stylesheet URL. Scan for: ` +
          `font-family on :root, body, h1, h2; ` +
          `CSS custom properties: --primary-*, --brand-*, --color-*, --accent-*, --cta-*, --font-*; ` +
          `background-color on selectors matching .btn, .button, [class*="cta"], [class*="hero"], nav, header. ` +
          `Phase 3 — If a secondary stylesheet or Google Fonts CSS URL was found, fetch it to confirm font names. ` +
          `Phase 4 — Return your structured report using EXACTLY these labels (one per line): ` +
          `HEADING_FONT: <exact font-family string, or "not found"> ` +
          `BODY_FONT: <exact font-family string, or "not found"> ` +
          `FONT_SOURCE: <where found: google fonts URL / @font-face / CSS var / inline style> ` +
          `NAV_BG: <hex or "not found"> ` +
          `HERO_BG: <hex or "not found"> ` +
          `CTA_BUTTON_BG: <hex of primary call-to-action button background, or "not found"> ` +
          `CTA_BUTTON_TEXT: <hex of CTA button text/icon color, or "not found"> ` +
          `BRAND_CSS_VARS: <list of --var-name: #hex pairs, or "none"> ` +
          `NOTES: <any other brand-defining colors or patterns observed>`,
      });
      logger.logUsage({
        clientId, agentId: null, agentName: "Branding · Site Intelligence",
        modelName: MODELS.HAIKU, operation: "branding_extraction",
        inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
        webSearchCount: readWebSearchCount(providerMetadata),
      });
      return text?.trim() || null;
    }

    // blocked — use web search to find public brand identity assets
    const { text, usage, providerMetadata } = await generateText({
      model: anthropic(MODELS.HAIKU),
      stopWhen: stepCountIs(5),
      tools: {
        webSearch: anthropic.tools.webSearch_20250305({}),
      },
      system: ANALYST_SYSTEM,
      prompt:
        `Search for the brand visual identity of "${clientName}" (domain: ${domain}). ` +
        `Look for: brand guidelines, design system docs, press kits, Figma community files, ` +
        `Behance/Dribbble portfolios, or any official source listing their color palette. ` +
        `Report specific hex codes and font names if found.`,
    });
    logger.logUsage({
      clientId, agentId: null, agentName: "Branding · Site Intelligence",
      modelName: MODELS.HAIKU, operation: "branding_extraction",
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
      webSearchCount: readWebSearchCount(providerMetadata),
    });
    return text?.trim() || null;
  } catch (err) {
    console.warn(`[branding] Site intelligence gathering failed for ${domain}:`, err);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   AI Branding Schema — dominance-ranked palette, no role constraints
   ──────────────────────────────────────────────────────────────────────── */

const BrandColorSchema = z.object({
  hex: z
    .string()
    .describe(
      "6-digit lowercase hex color code extracted from the brand's visual identity, e.g. #e91e8c. " +
        "Normalize 3-digit shorthands (#abc → #aabbcc).",
    ),
  role: z
    .string()
    .optional()
    .describe(
      "Optional semantic role — only include when unambiguous, e.g. 'Logo fill', " +
        "'Primary CTA background', 'Nav bar'. Omit if unclear.",
    ),
});

const BrandingAISchema = z.object({
  dominantColors: z
    .array(BrandColorSchema)
    .min(1)
    .max(4)
    .describe(
      "1–4 brand colors strictly ordered by visual dominance (Color 1 = most prominent). " +
        "Color 1: The single most distinctive/signature color — the one that IS the brand (logo mark, primary CTA). " +
        "Color 2: The second most prominent — supporting accent, secondary button, hover state. " +
        "Color 3: Only if a genuine third brand color is confirmed — e.g. a CTA/button color from website CSS " +
        "that is distinctly different in hue from Colors 1–2, a tertiary accent, or a highlight bar. " +
        "Color 4: Only if a fourth distinct brand color exists in the identity system. " +
        "CRITICAL RULES: " +
        "(1) Never pad the array to reach 4 — if the brand uses 2 colors, return exactly 2. " +
        "(2) No dark/light constraints — Colors 3 and 4 are simply the 3rd and 4th most dominant, whatever they are. " +
        "(3) Never add generic #000000 or #ffffff unless they are the actual signature brand color. " +
        "(4) Never substitute #2563eb (generic tech blue) for a brand with a known distinctive color. " +
        "Examples: XO Digital → ['#e91e8c', '#1a1a2e']; Cloudflare → ['#f6821f', '#404040', '#fbad41']; " +
        "Stripe → ['#6772e5', '#32325d', '#24b47e']; Twilio → ['#f22f46', '#0d122b', '#e1f2fd'].",
    ),
  fontHeading: z
    .string()
    .describe(
      "The heading font this brand uses. " +
        "PRIORITY ORDER: (1) If HEADING_FONT appears in the website CSS intelligence and is not 'not found', " +
        "use that exact font-family string — this is CSS ground truth. " +
        "(2) If a Google Fonts URL was found, read the font name from its ?family= parameter. " +
        "(3) If neither is available, use training-data knowledge of this brand's documented typography. " +
        "(4) Last resort archetype fallbacks: Space Grotesk/Syne (High-Tech/Dark Mode); " +
        "Plus Jakarta Sans/Inter (tech Minimalist); Playfair Display/Cormorant Garamond (Luxury); " +
        "Nunito/Lato (healthcare/community Corporate).",
    ),
  fontBody: z
    .string()
    .describe(
      "The body font this brand uses. " +
        "PRIORITY ORDER: (1) BODY_FONT from website CSS intelligence if present and not 'not found'. " +
        "(2) Training-data knowledge of this brand's documented typography. " +
        "(3) Last resort fallback: Inter, Geist, Open Sans, or Source Sans 3 based on brand tone.",
    ),
  visualStyle: z
    .enum(["Dark Mode", "High-Tech", "Luxury", "Vibrant", "Corporate", "Minimalist"])
    .describe(
      "Most fitting visual archetype. Must align with the extracted palette: " +
        "Dark Mode → near-black background + vivid single accent; " +
        "High-Tech → high contrast + electric/neon accent + monospace elements; " +
        "Luxury → muted or deep neutrals + gold/silver/rich accent; " +
        "Vibrant → saturated multi-hue palette with strong personality; " +
        "Corporate → conservative neutrals + safe accent; " +
        "Minimalist → near-white/near-black with one restrained accent.",
    ),
  toneKeywords: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe(
      "3–5 single-word brand personality descriptors aligned with visualStyle. " +
        "High-Tech/Dark Mode → Disruptive, Precise, Innovative; " +
        "Luxury → Refined, Exclusive, Elevated; Vibrant → Energetic, Bold, Playful. " +
        "Never use generic descriptors like 'Professional' or 'Reliable' for dynamic brands.",
    ),
  brandVoice: z
    .string()
    .describe(
      "2–3 sentences describing how this brand communicates — tone, style, and copywriting guidance.",
    ),
  dos: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe(
      "3–5 concrete, actionable brand communication do's (e.g. 'Use data-backed claims to build credibility').",
    ),
  donts: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe("3–5 concrete brand communication don'ts (e.g. 'Avoid corporate jargon and buzzwords')."),
});

/* ─────────────────────────────────────────────────────────────────────────
   Prompt builders
   ──────────────────────────────────────────────────────────────────────── */

const MAX_NAME_LEN = 100;
const MAX_DESC_LEN = 400;
const MAX_INTEL_LEN = 3_000;

function buildBrandingPrompt(
  name: string,
  domain: string | null,
  industry?: string,
  description?: string,
  siteIntelligence?: string | null,
  logoContext?: LogoContext,
): string {
  const safeName = name.slice(0, MAX_NAME_LEN);
  const safeDesc = description?.slice(0, MAX_DESC_LEN);
  const safeIntel = siteIntelligence?.slice(0, MAX_INTEL_LEN);

  const lines: string[] = [
    "You are an expert brand strategist and visual designer with deep knowledge of global and regional brands.",
    "",
    "## Target brand",
    `Company name: ${safeName}`,
  ];
  if (domain) lines.push(`Website: ${domain}`);
  if (industry) lines.push(`Industry: ${industry}`);
  if (safeDesc) lines.push(`Description: ${safeDesc}`);

  // Logo — brand signature color seed
  if (logoContext?.kind === "vision") {
    lines.push(
      "",
      "## Source A — Logo (Brand Signature Colors)",
      "The official brand logo image is attached above.",
      "- Extract every distinct color visible in the logo mark and wordmark.",
      "- Identify the most visually dominant colors by pixel area and visual weight.",
      "- These logo colors are the core palette seed — anchor your dominantColors array with them.",
    );
  } else if (logoContext?.kind === "svg") {
    lines.push(
      "",
      "## Source A — Logo (Brand Signature Colors, SVG-extracted)",
      "Hex values extracted directly from the official SVG logo file:",
      logoContext.colors.join(", "),
      "These anchor the palette — use them ordered by visual prominence.",
    );
  }

  // Website CSS intelligence — always a required input, not optional supplement
  if (safeIntel) {
    if (logoContext) {
      lines.push(
        "",
        "## Source B — Website CSS Intelligence (Typography Truth + Functional Colors)",
        "Data extracted directly from the live website's CSS and HTML:",
        "",
        safeIntel,
        "",
        "TYPOGRAPHY RULE — STRICT: If HEADING_FONT or BODY_FONT above is not 'not found', " +
          "you MUST use those exact values for fontHeading/fontBody. " +
          "CSS-extracted font names are ground truth. Never override them with training-data assumptions.",
      );
    } else {
      lines.push(
        "",
        "## Website CSS Intelligence — PRIMARY SOURCE",
        "Use these values directly. Fall back to training data only for values explicitly marked 'not found':",
        "",
        safeIntel,
      );
    }
  }

  // Synthesis rules — designer-level curation
  if (logoContext) {
    lines.push(
      "",
      "## Color Synthesis — Act Like a Senior Brand Designer",
      "You have both the logo palette (Source A) and live website data (Source B). Combine them intelligently:",
      "1. Seed: Start with the logo colors — these are the brand's core visual identity.",
      "2. Extend: Check Source B for CTA_BUTTON_BG, link colors, or brand CSS vars. " +
        "Ask: Is this color GENUINELY DISTINCT from all logo colors? " +
        "(Distinct = different hue, not merely a lighter/darker tint of an existing logo color.)",
      "   → YES, clearly distinct functional color: include it as Color 3 or 4 with a role like 'CTA button' or 'Interactive'.",
      "   → NO, it's just a tint/shade of a logo color: use the logo version; do not add it.",
      "3. Result: A 2-color brand that genuinely uses only 2 colors returns exactly 2 entries. " +
        "Only reach Color 3–4 when the website confirms a real third/fourth brand color.",
      "Never pad to fill 4 slots. Never add #000000 or #ffffff unless they are a documented brand signature.",
    );
  } else if (!safeIntel) {
    lines.push(
      "",
      "## Extraction priority (no live assets available)",
      `STEP 1 — Training-data recall: Examine ${domain ?? `"${name}"`}'s known logo/mark. Extract its most distinctive hex.`,
      "STEP 2 — Primary website elements: Header nav fill, primary CTA button background.",
      `STEP 3 — Brand name recall: What are "${safeName}"'s documented brand colors?`,
      "STEP 4 — Industry inference: ONLY if steps 1–3 yield nothing specific.",
    );
  }

  lines.push(
    "",
    "## Palette rules (strictly enforced)",
    "- Order colors by visual dominance — Color 1 must be the most visually prominent.",
    "- No dark/light role constraints: Colors 3 and 4 are simply the 3rd/4th most dominant, regardless of lightness.",
    "- Never include a color just to fill a slot. A 2-color brand gets exactly 2 colors.",
    "- Never use generic placeholder colors (#2563eb, #22c55e) for brands with known distinctive palettes.",
    "- fontHeading/fontBody: use actual brand fonts if known; archetype fallback only if unknown.",
    "- visualStyle, toneKeywords, and brandVoice must be internally consistent — High-Tech must pair with Disruptive/Innovative tone.",
  );

  return lines.join("\n");
}

function buildGuidelinesMarkdown(obj: z.infer<typeof BrandingAISchema>): string {
  return [
    "## Brand Voice",
    obj.brandVoice,
    "",
    "## Do's",
    ...obj.dos.map((d) => `- ${d}`),
    "",
    "## Don'ts",
    ...obj.donts.map((d) => `- ${d}`),
  ].join("\n");
}

/* ─────────────────────────────────────────────────────────────────────────
   Core generator — multi-tier extraction pipeline
   ──────────────────────────────────────────────────────────────────────── */

export type BrandingGenResult = {
  source: "ai_generated";
  dominantColors?: BrandColor[];
  visualStyle?: string;
  /** @deprecated Read dominantColors[0].hex */
  primaryAccent?: string;
  /** @deprecated Read dominantColors[1].hex */
  secondaryAccent?: string;
  /** @deprecated Read dominantColors[2].hex */
  brandNeutralDark?: string;
  /** @deprecated Read dominantColors[3].hex */
  brandNeutralLight?: string;
  /** @deprecated Use primaryAccent */
  primaryColor?: string;
  /** @deprecated Use secondaryAccent */
  secondaryColor?: string;
};

/**
 * Generate a complete brand profile using a three-tier extraction pipeline:
 *
 * Tier 1 — Raw technical scrape: probe the site for accessibility.
 * Tier 2 — Intelligent extraction:
 *   • Accessible → Claude uses webFetch to pull CSS variables and logo colors directly.
 *   • Blocked     → Claude uses webSearch to find public brand guidelines / press kits.
 * Tier 3 — Training knowledge: generateObject with all gathered context.
 *
 * Writes the client record and both context docs. No auth — caller is responsible.
 */
export async function applyBrandingForClient(
  clientId: string,
  knownClient?: Client,
): Promise<BrandingGenResult> {
  const client = knownClient ?? (await getClient(clientId));
  if (!client) throw new Error(`Client not found: ${clientId}`);

  // ── Resolve domain ───────────────────────────────────────────────
  let domain: string | null = null;
  const rawUrl = client.website?.trim();
  if (rawUrl) {
    try {
      domain = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`).hostname;
    } catch {
      // Invalid URL — proceed without domain
    }
  }

  const logoUrl = client.logoUrl ?? client.brandingGuidelines?.logoUrl;

  // ── Tiers 1+2 (site intelligence) and logo fetch run in parallel ─
  const [siteIntelligence, logoContext] = await Promise.all([
    (async (): Promise<string | null> => {
      if (!domain) return null;
      const access = await checkSiteAccess(`https://${domain}`);
      console.info(`[branding] ${domain} — access: ${access}`);
      const intel = await gatherSiteIntelligence(domain, client.name, access, clientId);
      if (intel) {
        console.info(`[branding] ${domain} — site intelligence gathered (${intel.length} chars)`);
      }
      return intel;
    })(),
    logoUrl ? prepareLogoContext(logoUrl) : Promise.resolve<LogoContext>(null),
  ]);

  if (logoContext) {
    console.info(`[branding] Logo loaded — kind: ${logoContext.kind}`);
  }

  // ── Tier 3: Structured extraction via generateObject ────────────
  const promptText = buildBrandingPrompt(
    client.name,
    domain,
    client.industry,
    client.description,
    siteIntelligence,
    logoContext,
  );

  let object: z.infer<typeof BrandingAISchema>;

  if (logoContext?.kind === "vision") {
    // Vision mode: pass logo image as Claude image part alongside the text prompt
    const result = await generateObject({
      model: anthropic(MODELS.HAIKU),
      schema: BrandingAISchema,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: logoContext.imageBytes, mediaType: logoContext.mimeType },
            { type: "text", text: promptText },
          ],
        },
      ],
    });
    object = result.object;
    logger.logUsage({
      clientId, agentId: null, agentName: "Branding · Palette Extraction",
      modelName: MODELS.HAIKU, operation: "branding_extraction",
      inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0,
    });
  } else {
    // Text-only mode: SVG colors and/or site intelligence are embedded in the prompt text
    const result = await generateObject({
      model: anthropic(MODELS.HAIKU),
      schema: BrandingAISchema,
      prompt: promptText,
    });
    object = result.object;
    logger.logUsage({
      clientId, agentId: null, agentName: "Branding · Palette Extraction",
      modelName: MODELS.HAIKU, operation: "branding_extraction",
      inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0,
    });
  }

  // ── Normalize and assemble guidelines ───────────────────────────
  const dominantColors: BrandColor[] = object.dominantColors.map((c, i) => ({
    hex: normalizeHex(c.hex) ?? c.hex.toLowerCase(),
    dominanceRank: i + 1,
    role: c.role,
  }));

  const existing = client.brandingGuidelines;
  const now = Date.now();

  const fullGuidelines: BrandingGuidelines = {
    dominantColors,
    // Mirror into legacy scalar fields for callers that haven't migrated yet
    primaryAccent: dominantColors[0]?.hex,
    secondaryAccent: dominantColors[1]?.hex,
    brandNeutralDark: dominantColors[2]?.hex,
    brandNeutralLight: dominantColors[3]?.hex,
    fontHeading: object.fontHeading,
    fontBody: object.fontBody,
    visualStyle: object.visualStyle,
    toneKeywords: object.toneKeywords,
    guidelines: buildGuidelinesMarkdown(object),
    updatedAt: now,
  };

  // ── Context doc writes ───────────────────────────────────────────
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

  return {
    source: "ai_generated",
    dominantColors,
    visualStyle: fullGuidelines.visualStyle,
    // Legacy aliases — kept for callers still reading old field names
    primaryAccent: fullGuidelines.primaryAccent,
    secondaryAccent: fullGuidelines.secondaryAccent,
    brandNeutralDark: fullGuidelines.brandNeutralDark,
    brandNeutralLight: fullGuidelines.brandNeutralLight,
    primaryColor: fullGuidelines.primaryAccent,
    secondaryColor: fullGuidelines.secondaryAccent,
  };
}
