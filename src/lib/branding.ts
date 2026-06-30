import "server-only";

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import {
  getClient,
  getClientContextDoc,
  updateClient,
  upsertClientContextDoc,
} from "@/lib/data";
import type { BrandingGuidelines, Client } from "@/lib/types";

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
   Context-doc builders (used by saveBrandingGuidelinesAction too)
   ──────────────────────────────────────────────────────────────────────── */

/** Returns the effective primary accent — new field first, legacy fallback. */
export function effectivePrimaryAccent(g: BrandingGuidelines): string | undefined {
  return g.primaryAccent ?? g.primaryColor;
}

/** Returns the effective secondary accent — new field first, legacy fallback. */
export function effectiveSecondaryAccent(g: BrandingGuidelines): string | undefined {
  return g.secondaryAccent ?? g.secondaryColor;
}

/** Returns the effective neutral dark — new field first, legacy fallbacks. */
export function effectiveNeutralDark(g: BrandingGuidelines): string | undefined {
  return g.brandNeutralDark ?? g.uiBackground ?? g.uiText;
}

/** Returns the effective neutral light — new field first, legacy fallback. */
export function effectiveNeutralLight(g: BrandingGuidelines): string | undefined {
  return g.brandNeutralLight ?? g.uiText ?? g.uiBackground;
}

export function brandingToContextDocContent(g: BrandingGuidelines, clientName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`# Branding Guidelines — ${clientName}`, `_Last updated: ${today}_`, ""];
  if (g.visualStyle) lines.push("## Visual Style", g.visualStyle, "");
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
  const pa = effectivePrimaryAccent(g);
  const sa = effectiveSecondaryAccent(g);
  const nd = g.brandNeutralDark ?? g.uiBackground;
  const nl = g.brandNeutralLight ?? g.uiText;
  if (pa) lines.push(`- **Primary Accent:** ${pa}`);
  if (sa) lines.push(`- **Secondary Accent:** ${sa}`);
  if (nd) lines.push(`- **Neutral Dark:** ${nd}`);
  if (nl) lines.push(`- **Neutral Light:** ${nl}`);
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
   AI Branding Engine — Pure Claude Haiku generation (no web scraping)
   ──────────────────────────────────────────────────────────────────────── */

const BrandingAISchema = z.object({
  primaryAccent: z
    .string()
    .describe(
      "The brand's single most dominant accent color as a 6-digit lowercase hex. " +
        "EXTRACTION PRIORITY: (1) Logo SVG/image — the most saturated or unique color in the mark. " +
        "(2) Header navigation bar fill or primary CTA button background. " +
        "(3) The company's known brand color from training data. " +
        "(4) Industry-standard accent ONLY if the brand is completely unknown. " +
        "Never substitute a generic 'average tech blue' for a recognizable brand. " +
        "Examples: #e91e8c (XO Digital magenta), #ff6600 (Cloudflare orange), " +
        "#0057ff (Wix electric blue), #ce2127 (ONE crimson), #7c3aed (Twitch purple).",
    ),
  secondaryAccent: z
    .string()
    .describe(
      "The supporting contrast/action color used for hover states, secondary CTAs, or icon fills. " +
        "Must be visually distinct from primaryAccent. " +
        "Derive from: the brand's second most prominent palette color (e.g. a complementary or analogous hue), " +
        "or a tinted variant of the primary if the brand is monochromatic. " +
        "Return as 6-digit lowercase hex.",
    ),
  brandNeutralDark: z
    .string()
    .describe(
      "The foundational dark shade — the darkest neutral in the brand's palette. " +
        "For dark-mode / digital-first brands: near-black like #09090b, #0a0a0a, #111111. " +
        "For light-mode brands: the dark heading or body text color, e.g. #1a1a2e, #0d1117, #1e293b. " +
        "Never pick a color lighter than #333333 for this field. Return as 6-digit lowercase hex.",
    ),
  brandNeutralLight: z
    .string()
    .describe(
      "The foundational light shade — the lightest neutral in the brand's palette. " +
        "For light-mode brands: the canvas background, e.g. #ffffff, #f8fafc, #fafafa, #f4f4f5. " +
        "For dark-mode brands: the lightest text or surface color, e.g. #e2e8f0, #f1f5f9, #fafafa. " +
        "Never pick a color darker than #cccccc for this field. Return as 6-digit lowercase hex.",
    ),
  fontHeading: z
    .string()
    .describe(
      "The exact heading font the brand uses on its website, if known. " +
        "Inspect <h1>, <h2>, and nav brand mark for font-family. " +
        "Fallback by visual archetype: Space Grotesk / Syne (High-Tech, Dark Mode); " +
        "Plus Jakarta Sans / Inter (tech/modern Minimalist); " +
        "Playfair Display / Cormorant Garamond (Luxury/editorial); " +
        "Nunito / Lato (healthcare/community Corporate).",
    ),
  fontBody: z
    .string()
    .describe(
      "The exact body text font the brand uses, if known. " +
        "Fallback: Inter, Geist, Open Sans, or Source Sans 3 based on brand tone.",
    ),
  visualStyle: z
    .enum(["Dark Mode", "High-Tech", "Luxury", "Vibrant", "Corporate", "Minimalist"])
    .describe(
      "The most fitting visual archetype. Must align with the extracted palette: " +
        "Dark Mode → near-black neutrals + vivid accent; " +
        "High-Tech → high contrast + electric/neon accent; " +
        "Luxury → muted or deep neutrals + gold/silver/rich accent; " +
        "Vibrant → saturated multi-hue palette; " +
        "Corporate → conservative neutrals + safe accent; " +
        "Minimalist → near-white/near-black with single restrained accent.",
    ),
  toneKeywords: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe(
      "3–5 single-word brand personality descriptors. " +
        "Must align with visualStyle: High-Tech/Dark Mode → Disruptive, Precise, Innovative; " +
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

// Hard limits prevent token bloat and narrow prompt-injection surface.
// name: 100 chars — long enough for any real brand name.
// description: 400 chars — one meaningful paragraph.
const MAX_NAME_LEN = 100;
const MAX_DESC_LEN = 400;

function buildBrandingPrompt(
  name: string,
  domain: string | null,
  industry?: string,
  description?: string,
): string {
  const safeName = name.slice(0, MAX_NAME_LEN);
  const safeDesc = description?.slice(0, MAX_DESC_LEN);

  const lines: string[] = [
    "You are an expert brand strategist and visual designer with deep knowledge of global and regional brands.",
    "",
    "## Target brand",
    `Company name: ${safeName}`,
  ];
  if (domain) lines.push(`Website: ${domain}`);
  if (industry) lines.push(`Industry: ${industry}`);
  if (safeDesc) lines.push(`Description: ${safeDesc}`);

  lines.push(
    "",
    "## How to extract the brand profile",
    "",
    "STEP 1 — Logo & asset inspection (highest priority):",
    domain
      ? `Recall everything you know about ${domain} from training data. Examine the logo SVG/image first — extract the most saturated or unique hex from the mark. Then check header navigation and primary CTA buttons for accent colors.`
      : "No website provided — skip to Step 2.",
    "",
    "STEP 2 — Company name recall:",
    `If Step 1 didn't surface clear visual details, recall what you know about "${name}" as a brand. Many brands are instantly recognizable by name.`,
    "",
    "STEP 3 — Industry inference (last resort):",
    "ONLY if Steps 1 and 2 yield zero specific knowledge, apply industry-standard visual aesthetics for the sector.",
    "",
    "## Hard rules for the 4-color palette",
    "- primaryAccent: the single most distinctive color from the brand's logo or primary CTA. Never use a generic blue (#2563eb) for a brand that has its own signature color.",
    "- secondaryAccent: visually distinct from primaryAccent — a complementary hue, not a tint/shade of it.",
    "- brandNeutralDark: the darkest neutral in the palette (#333333 or darker). Must be near-black for dark-mode brands.",
    "- brandNeutralLight: the lightest neutral in the palette (#cccccc or lighter). Must be near-white for light-mode brands.",
    "- fontHeading/fontBody must be the actual fonts the brand uses if you know them; otherwise choose fonts that fit the visualStyle archetype.",
    "- visualStyle, toneKeywords, and brandVoice must be mathematically consistent — a High-Tech palette must pair with Disruptive/Innovative/Precise tone, not generic Corporate descriptors.",
    "- Do's and Don'ts must be specific and actionable for content creators working on this brand.",
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
   Core generator (no auth — call from actions.ts or intel pipeline)
   ──────────────────────────────────────────────────────────────────────── */

export type BrandingGenResult = {
  source: "ai_generated";
  primaryAccent?: string;
  secondaryAccent?: string;
  brandNeutralDark?: string;
  brandNeutralLight?: string;
  visualStyle?: string;
  /** @deprecated Use primaryAccent */
  primaryColor?: string;
  /** @deprecated Use secondaryAccent */
  secondaryColor?: string;
};

/**
 * Generate a complete brand profile using Claude Haiku's world knowledge.
 * Passes the domain name, client name, and industry directly — no web scraping.
 * Writes the client record and both context docs.
 *
 * No auth checks — the caller (server action or pipeline) is responsible for those.
 */
export async function applyBrandingForClient(
  clientId: string,
  knownClient?: Client,
): Promise<BrandingGenResult> {
  const client = knownClient ?? (await getClient(clientId));
  if (!client) throw new Error(`Client not found: ${clientId}`);

  let domain: string | null = null;
  const rawUrl = client.website?.trim();
  if (rawUrl) {
    try {
      domain = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`).hostname;
    } catch {
      // Invalid URL — proceed without domain
    }
  }

  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5-20251001"),
    schema: BrandingAISchema,
    prompt: buildBrandingPrompt(client.name, domain, client.industry, client.description),
  });

  const existing = client.brandingGuidelines;
  const now = Date.now();

  // Preserve only logoUrl — always manually uploaded, never generated.
  const fullGuidelines: BrandingGuidelines = {
    primaryAccent: normalizeHex(object.primaryAccent) ?? object.primaryAccent,
    secondaryAccent: normalizeHex(object.secondaryAccent) ?? object.secondaryAccent,
    brandNeutralDark: normalizeHex(object.brandNeutralDark) ?? object.brandNeutralDark,
    brandNeutralLight: normalizeHex(object.brandNeutralLight) ?? object.brandNeutralLight,
    fontHeading: object.fontHeading,
    fontBody: object.fontBody,
    visualStyle: object.visualStyle,
    toneKeywords: object.toneKeywords,
    guidelines: buildGuidelinesMarkdown(object),
    logoUrl: existing?.logoUrl,
    updatedAt: now,
  };

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
    primaryAccent: fullGuidelines.primaryAccent,
    secondaryAccent: fullGuidelines.secondaryAccent,
    brandNeutralDark: fullGuidelines.brandNeutralDark,
    brandNeutralLight: fullGuidelines.brandNeutralLight,
    visualStyle: fullGuidelines.visualStyle,
    // Legacy aliases for callers still reading old field names
    primaryColor: fullGuidelines.primaryAccent,
    secondaryColor: fullGuidelines.secondaryAccent,
  };
}
