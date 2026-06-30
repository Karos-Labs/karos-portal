import "server-only";

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { Client, ContextDocType } from "@/lib/types";
import { getClient, getSystemAgent, replaceClientContextDocs, listClientCompetitors, listTranscripts } from "@/lib/data";
import { INTEL_AGENT_ID } from "@/lib/intel-report";
import {
  RESEARCH_ENGINE_RULES,
  METRICS_RULES,
  TEMPLATES,
} from "@/lib/onboard-templates";
import { condenseDocs } from "@/lib/condense-pipeline";

/* ── Helpers ──────────────────────────────────────────────────────── */

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function clientContext(client: Client): string {
  const parts = [
    `Company: ${client.name}`,
    client.website ? `Website: ${client.website}` : "",
    client.industry ? `Industry: ${client.industry}` : "",
    client.description ? `Description: ${client.description}` : "",
  ];

  // Include structured branding data so the AI never contradicts manually set values.
  const g = client.brandingGuidelines;
  const pa = g?.primaryAccent ?? g?.primaryColor;
  const sa = g?.secondaryAccent ?? g?.secondaryColor;
  if (g && (pa || g.fontHeading || g.toneKeywords?.length)) {
    parts.push("", "Existing Branding (treat as ground truth — do not contradict or omit):");
    if (pa) parts.push(`  Primary Accent: ${pa}`);
    if (sa) parts.push(`  Secondary Accent: ${sa}`);
    if (g.brandNeutralDark ?? g.uiBackground) parts.push(`  Neutral Dark: ${g.brandNeutralDark ?? g.uiBackground}`);
    if (g.brandNeutralLight ?? g.uiText) parts.push(`  Neutral Light: ${g.brandNeutralLight ?? g.uiText}`);
    if (g.fontHeading) parts.push(`  Heading Font: ${g.fontHeading}`);
    if (g.fontBody) parts.push(`  Body Font: ${g.fontBody}`);
    if (g.toneKeywords?.length) parts.push(`  Tone Keywords: ${g.toneKeywords.join(", ")}`);
  }

  return parts.filter(Boolean).join("\n");
}

function coreRules(additionalInstructions: string): string {
  const parts = [RESEARCH_ENGINE_RULES, "", METRICS_RULES];
  if (additionalInstructions.trim()) {
    parts.push("", "## ADDITIONAL RESEARCH INSTRUCTIONS (from agent config)", additionalInstructions.trim());
  }
  return parts.join("\n");
}

/** Fill the frontmatter placeholders in a template. */
function fillFrontmatter(template: string, client: Client, docType: ContextDocType, tier: string): string {
  const today = todayISO();
  return template
    .replace(/<slug>/g, client.id)
    .replace(/<Client>/g, client.name)
    .replace(/<YYYY-MM-DD>/g, today)
    .replace(/status: original/, tier === "client" ? "status: published" : "status: original");
}

function buildMeetingSignals(
  transcripts: Array<{ title: string; meetingDate?: number; createdAt: number; summary?: string; actionItems?: string[]; keywords?: string[] }>,
): string {
  const recent = transcripts.slice(0, 10);
  if (!recent.length) return "";
  const lines = ["## Client Meeting Signals (recent conversations)", ""];
  for (const t of recent) {
    const date = new Date(t.meetingDate ?? t.createdAt).toISOString().slice(0, 10);
    lines.push(`### ${t.title} (${date})`);
    if (t.summary) lines.push(t.summary);
    if (t.actionItems?.length) lines.push("Action items: " + t.actionItems.join("; "));
    if (t.keywords?.length) lines.push("Topics: " + t.keywords.join(", "));
    lines.push("");
  }
  return lines.join("\n");
}

/* ── Phase 1: Research agents (parallel) ─────────────────────────── */

async function researchSocial(client: Client, rules: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: `${rules}\n\nYou are a social media research analyst.`,
    messages: [
      {
        role: "user",
        content: `Research the social media presence of ${client.name} (${client.website ?? "no website"}).

Find their accounts on Instagram, TikTok, LinkedIn, and X/Twitter.

For each platform where you find them:
- Handle / URL
- Approximate follower count — IMPORTANT: if you cannot source this from a live measurement, write "data unavailable (training knowledge only — live Apify scrape required)"
- Posting cadence (posts per week) — observed or "data unavailable"
- Content formats used (photos, carousels, reels, etc.)
- Engagement quality (qualitative observation from available posts)

Also identify their top 5-8 competitors' social handles.

Return structured markdown. Follow the no-guessed-numbers rule strictly.`,
      },
    ],
    maxOutputTokens: 1500,
  });
  return text;
}

async function researchContent(client: Client, rules: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: `${rules}\n\nYou are a brand messaging and content analyst.`,
    messages: [
      {
        role: "user",
        content: `Analyze the brand messaging and content strategy of ${client.name} (${client.website ?? "no website"}).

Based on their website and any observable public content, analyze:
1. Core value proposition — what do they lead with?
2. Tone and voice — how formal, how warm, what personality?
3. Primary CTAs — what actions do they ask for? (quote verbatim where possible)
4. Content themes — what topics/ideas recur across their communications?
5. Writing style — sentence length, vocabulary, use of jargon
6. What they do NOT say (gaps, avoided topics)

For each observation, note what specific evidence you based it on (website section, page URL, observed post).
Do not guess follower counts or engagement metrics — those belong in the social research.

Return detailed markdown.`,
      },
    ],
    maxOutputTokens: 1500,
  });
  return text;
}

async function researchCompetitive(
  client: Client,
  rules: string,
  trackedCompetitors: { company: string; url?: string }[] = [],
): Promise<string> {
  const trackedBlock = trackedCompetitors.length
    ? `\n\nIMPORTANT: The following competitors have been manually flagged by the client's team and MUST be included in your analysis regardless of prominence:\n${trackedCompetitors.map((c) => `- ${c.company}${c.url ? ` (${c.url})` : ""}`).join("\n")}`
    : "";

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: `${rules}\n\nYou are a competitive intelligence analyst.`,
    messages: [
      {
        role: "user",
        content: `Research the competitive landscape for ${client.name} (${client.website ?? "no website"}) in the ${client.industry ?? "their"} industry.${trackedBlock}

Identify 6-10 real, named competitors (direct, secondary, and indirect).

For each competitor provide:
- Company name and website URL
- Category: direct / secondary / indirect
- Their positioning (how they describe themselves — quote their tagline or hero copy if available)
- 2-3 key strengths (evidence-backed — what you specifically observed)
- 2-3 key weaknesses (gaps you observed, not scores)
- Pricing: ONLY state pricing that is published on their website. If not published, write "not published". No estimates.
- Approximate size/stage if publicly known (funding announcements, press, their own claims)

Do not score competitors numerically. Do not estimate prices or revenue.

Return structured markdown.`,
      },
    ],
    maxOutputTokens: 2000,
  });
  return text;
}

async function researchStrategy(client: Client, rules: string, meetingSignals = ""): Promise<string> {
  const signalsBlock = meetingSignals
    ? `\n\n${meetingSignals}\n\nUse the meeting signals above as additional context about what the client is focusing on, their stated priorities, and any market observations from real conversations. These are firsthand signals — treat them as high-confidence qualitative data.`
    : "";

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: `${rules}\n\nYou are a market strategy analyst.`,
    messages: [
      {
        role: "user",
        content: `Research the market positioning and strategy of ${client.name} (${client.website ?? "no website"}) in the ${client.industry ?? "their"} industry.

Analyze:
1. Market they compete in — what category, what buyer problem do they solve?
2. Ideal customer profile — who is the core buyer? Be specific (demographics, context, motivation).
3. Business model — how do they make money? (subscription, transaction, service fee, etc.)
4. Differentiation — what makes them distinct from competitors? What do they own?
5. Market white space — what positions or audiences are NOT served by existing players?
6. Growth stage signals — early / growth / established? What signals suggest this?

Base all observations on what you can verify from their website and publicly available information.
Do not invent KPIs, revenue numbers, or growth rates without a source.

Return structured markdown.${signalsBlock}`,
      },
    ],
    maxOutputTokens: 1500,
  });
  return text;
}

async function researchSentiment(client: Client, rules: string, meetingSignals = ""): Promise<string> {
  const signalsBlock = meetingSignals
    ? `\n\n${meetingSignals}\n\nCross-reference the meeting signals with the sentiment research below. Client or prospect concerns surfaced in meetings are strong qualitative signals — factor them in directly.`
    : "";

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: `${rules}\n\nYou are a customer sentiment and UX analyst.`,
    messages: [
      {
        role: "user",
        content: `Research customer sentiment and common questions for ${client.name} (${client.website ?? "no website"}) in the ${client.industry ?? "their"} industry.

Analyze:
1. FAQ patterns — what do people in this category typically ask before buying? (from reviews, forums, their own FAQ page)
2. Common objections — what hesitations or concerns appear repeatedly?
3. What customers value most — what makes buyers choose in this category?
4. Regulatory/compliance landscape — are there rules, disclaimers, or banned claims relevant to this industry?
5. Whitespace opportunities — unmet customer needs, underserved segments, or service gaps you observe
6. Sentiment signals — any public reviews, testimonials, or community mentions you can cite (with source)

Do not invent review data or ratings without a verifiable source.

Return structured markdown.${signalsBlock}`,
      },
    ],
    maxOutputTokens: 1500,
  });
  return text;
}

/* ── Phase 2: Document generators (parallel) ─────────────────────── */

interface Research {
  social: string;
  content: string;
  competitive: string;
  strategy: string;
  sentiment: string;
}

async function generateDoc(
  client: Client,
  docType: ContextDocType,
  research: Research,
  rules: string,
): Promise<string> {
  const template = TEMPLATES[docType] ?? "";
  const researchBlock = buildResearchBlock(docType, research);

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: `${rules}\n\nYou are a strategic analyst writing a living context document for ${client.name}.
You follow the document template structure exactly.
You only include facts you can substantiate from the research provided.
You never guess numbers — write "data unavailable" when a metric was not measured.`,
    messages: [
      {
        role: "user",
        content: `Fill in this ${docType} document template for ${client.name} (${client.website ?? "no website"}).

## CLIENT CONTEXT
${clientContext(client)}

## RESEARCH FINDINGS
${researchBlock}

## TEMPLATE TO FILL
${fillFrontmatter(template, client, docType, "internal")}

---

Fill every section of the template above using the research findings.
Replace all <placeholder> text with real content.
Keep all section headings exactly as written.
Where a measurement is unavailable, write "data unavailable" — never guess.
Update the frontmatter: set last_updated to ${todayISO()}, set client to "${client.id}".
Return ONLY the filled markdown document. No preamble, no explanation.`,
      },
    ],
    maxOutputTokens: 4000,
  });
  return text;
}

function buildResearchBlock(docType: ContextDocType, research: Research): string {
  const parts: string[] = [];
  if (["brand-voice", "branding-guidelines"].includes(docType)) {
    parts.push("### Content & Messaging Research\n" + research.content);
    parts.push("### Sentiment & Customer Research\n" + research.sentiment);
  }
  if (["market-strategy"].includes(docType)) {
    parts.push("### Strategy Research\n" + research.strategy);
    parts.push("### Sentiment Research\n" + research.sentiment);
    parts.push("### Competitive Research (for white space)\n" + research.competitive);
  }
  if (["competitor-analysis"].includes(docType)) {
    parts.push("### Competitive Research\n" + research.competitive);
    parts.push("### Social Research\n" + research.social);
  }
  if (["product-information"].includes(docType)) {
    parts.push("### Content & Messaging Research\n" + research.content);
    parts.push("### Strategy Research\n" + research.strategy);
    parts.push("### Sentiment Research\n" + research.sentiment);
  }
  if (["client-guidelines"].includes(docType)) {
    parts.push("### Content Research\n" + research.content);
    parts.push("### Sentiment Research\n" + research.sentiment);
  }
  if (["action-plan"].includes(docType)) {
    parts.push("### Strategy Research\n" + research.strategy);
    parts.push("### Competitive Research\n" + research.competitive);
    parts.push("### Sentiment Research\n" + research.sentiment);
  }
  return parts.length ? parts.join("\n\n") : Object.values(research).join("\n\n");
}

/* ── Main pipeline ────────────────────────────────────────────────── */

/**
 * Run the full onboarding pipeline for a client:
 * 1. 5 parallel research agents gather raw intelligence
 * 2. 7 parallel document generators fill the context doc templates
 * 3. condense-pipeline generates client-tier (50% condensed) versions of the 5 public docs
 * 4. All docs atomically replace existing clientContextDocs for this client
 */
export async function runOnboardPipeline(clientId: string): Promise<void> {
  const [client, agent, existingCompetitors, existingTranscripts] = await Promise.all([
    getClient(clientId),
    getSystemAgent(INTEL_AGENT_ID),
    listClientCompetitors(clientId),
    listTranscripts({ clientId }),
  ]);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  // Load additional instructions from agent config (non-fatal if missing)
  const isLegacyPrompt = agent?.systemPrompt?.startsWith("You are the Karos Intel AI");
  const additionalInstructions = (!isLegacyPrompt && agent?.systemPrompt) ? agent.systemPrompt : "";
  const rules = coreRules(additionalInstructions);

  // Build meeting signals from stored transcripts for this client
  const meetingSignals = buildMeetingSignals(existingTranscripts);

  // Phase 1: 5 parallel research agents
  // Pass manually-tracked competitors into competitive research so regeneration
  // always accounts for competitors the client's team has explicitly flagged.
  // Pass meeting signals into strategy/sentiment research for firsthand context.
  const [social, content, competitive, strategy, sentiment] = await Promise.all([
    researchSocial(client, rules),
    researchContent(client, rules),
    researchCompetitive(client, rules, existingCompetitors),
    researchStrategy(client, rules, meetingSignals),
    researchSentiment(client, rules, meetingSignals),
  ]);

  const research: Research = { social, content, competitive, strategy, sentiment };

  // Phase 2: 7 parallel document generators
  const internalDocTypes: PipelineDocType[] = [
    "brand-voice",
    "market-strategy",
    "competitor-analysis",
    "product-information",
    "branding-guidelines",
  ];
  const internalOnlyDocTypes: PipelineDocType[] = ["client-guidelines", "action-plan"];

  const [
    brandVoice,
    marketStrategy,
    competitorAnalysis,
    productInfo,
    brandingGuidelines,
    clientGuidelines,
    actionPlan,
  ] = await Promise.all([
    ...internalDocTypes.map((dt) => generateDoc(client, dt, research, rules)),
    ...internalOnlyDocTypes.map((dt) => generateDoc(client, dt, research, rules)),
  ]);

  // "meeting-notes" is written exclusively by appendMeetingSignalToContextDoc — not generated here.
  type PipelineDocType = Exclude<ContextDocType, "meeting-notes">;
  const internalContents: Record<PipelineDocType, string> = {
    "brand-voice": brandVoice,
    "market-strategy": marketStrategy,
    "competitor-analysis": competitorAnalysis,
    "product-information": productInfo,
    "branding-guidelines": brandingGuidelines,
    "client-guidelines": clientGuidelines,
    "action-plan": actionPlan,
  };

  // Phase 3: Condensation (5 public docs → client-tier)
  const condensed = await condenseDocs(client, internalDocTypes, internalContents, rules);

  // Phase 4: Build full doc set and atomically replace
  const now = Date.now();
  const allDocs = [
    // Internal tier (5 public docs)
    ...internalDocTypes.map((dt) => ({
      clientId,
      docType: dt,
      tier: "internal" as const,
      content: internalContents[dt],
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    // Internal-only tier (2 docs)
    ...internalOnlyDocTypes.map((dt) => ({
      clientId,
      docType: dt,
      tier: "internal-only" as const,
      content: internalContents[dt],
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    // Client tier (5 condensed docs)
    ...condensed.map((doc) => ({
      clientId,
      docType: doc.docType,
      tier: "client" as const,
      content: doc.content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
  ];

  await replaceClientContextDocs(clientId, allDocs);
}
