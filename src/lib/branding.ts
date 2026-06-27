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

export function brandingToContextDocContent(g: BrandingGuidelines, clientName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`# Branding Guidelines — ${clientName}`, `_Last updated: ${today}_`, ""];
  if (g.visualStyle) lines.push("## Visual Style", g.visualStyle, "");
  if (g.primaryColor || g.secondaryColor || g.uiBackground || g.uiText) {
    lines.push("## Color Palette");
    if (g.primaryColor) lines.push(`- **Brand Accent:** ${g.primaryColor}`);
    if (g.secondaryColor) lines.push(`- **Secondary:** ${g.secondaryColor}`);
    if (g.uiBackground) lines.push(`- **UI Background:** ${g.uiBackground}`);
    if (g.uiText) lines.push(`- **UI Text:** ${g.uiText}`);
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
  if (g.primaryColor) lines.push(`- **Brand Accent:** ${g.primaryColor}`);
  if (g.uiBackground) lines.push(`- **UI Background:** ${g.uiBackground}`);
  if (g.uiText) lines.push(`- **UI Text:** ${g.uiText}`);
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
   AI Branding Engine — Pure Claude Haiku generation (no web scraping)
   ──────────────────────────────────────────────────────────────────────── */

const BrandingAISchema = z.object({
  brandAccent: z
    .string()
    .describe(
      "Primary brand color as 6-digit lowercase hex. " +
        "SOURCE PRIORITY: (1) the brand's actual color from its website/logo if you know it, " +
        "(2) the company's known brand color, " +
        "(3) industry-standard accent only if brand is completely unknown. " +
        "Examples of real brand colors: Magenta #e91e8c for XO Digital, Crimson #ce2127 for ONE, " +
        "Electric blue #0057ff for Wix, Orange #ff6600 for Cloudflare.",
    ),
  uiBackground: z
    .string()
    .describe(
      "Canvas background color derived from the brand's actual website palette. " +
        "Dark-mode brands (agencies, SaaS, tech, luxury, digital-first): #09090b or #0a0a0a. " +
        "Light-mode brands (corporate, healthcare, e-commerce, retail): #ffffff or #f4f4f5. " +
        "Match what the actual website uses, not what you assume the industry uses.",
    ),
  uiText: z
    .string()
    .describe(
      "High-contrast readable text color paired with uiBackground. " +
        "#09090b for light canvases, #fafafa for dark canvases.",
    ),
  secondaryColor: z
    .string()
    .optional()
    .describe(
      "Secondary accent from the brand's actual palette as 6-digit lowercase hex. Omit if unsure.",
    ),
  fontHeading: z
    .string()
    .describe(
      "The actual heading font the brand uses on its website, if known. " +
        "Fallback by sector: Plus Jakarta Sans/Inter/Montserrat (tech/modern); " +
        "Playfair Display/Cormorant Garamond (luxury/editorial); Nunito/Lato (healthcare/community).",
    ),
  fontBody: z
    .string()
    .describe(
      "The actual body font the brand uses, if known. Fallback: Inter, Open Sans, or Source Sans 3.",
    ),
  visualStyle: z
    .enum(["Dark Mode", "High-Tech", "Luxury", "Vibrant", "Corporate", "Minimalist"])
    .describe("The most fitting visual archetype for this brand."),
  toneKeywords: z
    .array(z.string())
    .min(3)
    .max(5)
    .describe("3–5 single-word brand personality descriptors (e.g. Bold, Innovative, Human, Crafted)."),
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
    "## How to generate the brand profile",
    "",
    "STEP 1 — Website-first recall (highest priority):",
    domain
      ? `Recall everything you know about ${domain} from your training data. What are its actual brand colors? What fonts does it use? What is its visual style? Use this specific knowledge as your primary source.`
      : "No website provided — skip to Step 2.",
    "",
    "STEP 2 — Company name recall:",
    `If the website alone didn't surface clear visual details, recall what you know about "${name}" as a company or brand. Many brands are recognizable by name even without the domain.`,
    "",
    "STEP 3 — Industry inference (fallback only):",
    "ONLY if Steps 1 and 2 yield no specific knowledge about this brand (it is genuinely unknown or too regional/niche), then apply industry-standard visual aesthetics appropriate for the sector.",
    "",
    "## Hard rules",
    "- brandAccent must be the brand's real primary color when you recognize the brand. Never substitute a generic industry color for a known brand.",
    "- uiBackground reflects the brand's actual canvas: dark for dark-mode brands (#09090b/#0a0a0a), light for light-mode brands (#ffffff/#f4f4f5).",
    "- fontHeading/fontBody must be the actual fonts the brand uses if you know them, otherwise choose fonts that genuinely fit the sector.",
    "- The three-part color schema (brandAccent, uiBackground, uiText) must be contrast-safe and cohesive.",
    "- toneKeywords and brandVoice must reflect the specific brand's personality, not generic sector marketing language.",
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
  primaryColor?: string;
  secondaryColor?: string;
  visualStyle?: string;
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
    primaryColor: normalizeHex(object.brandAccent) ?? object.brandAccent,
    uiBackground: normalizeHex(object.uiBackground) ?? object.uiBackground,
    uiText: normalizeHex(object.uiText) ?? object.uiText,
    secondaryColor: object.secondaryColor
      ? (normalizeHex(object.secondaryColor) ?? object.secondaryColor)
      : undefined,
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
    primaryColor: fullGuidelines.primaryColor,
    secondaryColor: fullGuidelines.secondaryColor,
    visualStyle: fullGuidelines.visualStyle,
  };
}
