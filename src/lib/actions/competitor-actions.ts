"use server";

import { revalidatePath } from "next/cache";
import {
  getClient,
  createClientCompetitor,
  deleteClientCompetitor,
  listClientCompetitors,
  replaceReportCompetitors,
  getClientContextDoc,
  upsertClientContextDoc,
  upsertClientReport,
} from "@/lib/data";
import { parseMarkdownReport, buildClientReport } from "@/lib/report-parser";
import type { ClientCompetitor } from "@/lib/types";
import { requireStaff, logActivity } from "./_shared";

/** Core AI competitor analysis helper — not exported. */
async function _analyzeCompetitors(clientId: string): Promise<void> {
  const [client, competitors] = await Promise.all([
    getClient(clientId),
    listClientCompetitors(clientId),
  ]);
  if (!client || competitors.length === 0) return;

  const { generateObject } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { z } = await import("zod");

  const schema = z.object({
    competitors: z.array(
      z.object({
        company: z.string().describe("Exact competitor name as provided."),
        url: z.string().optional().describe("Primary website URL. Omit if unknown."),
        positioning: z.string().optional().describe(
          "STRICT: 3–5 words max. Noun phrase only — NO verbs, NO sentences, NO punctuation. " +
          "Good: 'Enterprise marketing automation' | 'AI-driven B2B outreach' | 'SMB payroll platform'. " +
          "Bad: 'They offer a high-end automated marketing solution for enterprise clients.'",
        ),
        keyStrengths: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff. " +
          "Good: ['Global brand authority', 'Massive capital runway', 'G2 Leader badge'].",
        ),
        keyWeaknesses: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff. " +
          "Good: ['Complex onboarding', 'Legacy UI/UX', 'Enterprise-only pricing'].",
        ),
        threatLevel: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
        marketTier: z.enum(["Leader", "Challenger", "Niche", "Other"]),
        overlap: z.enum(["High", "Medium", "Low-Med", "Low"]),
      }),
    ),
  });

  const names = competitors.map((c) => c.company).join(", ");
  const clientCtx = [
    client.name,
    client.website ? `(${client.website})` : "",
    client.description ? `— ${client.description}` : "",
  ].filter(Boolean).join(" ");

  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema,
    system:
      "You are a competitive intelligence analyst producing data for a compact UI dashboard table. " +
      "Every text field you output is rendered directly in a table cell — long text BREAKS the layout. " +
      "\n\nABSOLUTE FORMATTING RULES (violating these corrupts the UI):\n" +
      "• positioning — max 5 words, noun phrase, no verbs. e.g. 'Enterprise marketing automation'\n" +
      "• keyStrengths items — max 4 words each. e.g. 'Global brand authority'\n" +
      "• keyWeaknesses items — max 4 words each. e.g. 'Complex onboarding'\n" +
      "• NEVER write complete sentences, introductory phrases, or trailing punctuation.\n" +
      "• NEVER use filler words: 'very', 'highly', 'extremely', 'robust', 'comprehensive', 'cutting-edge'.\n" +
      "• Data must be specific and scannable in under 2 seconds.",
    prompt: `Analyze these competitors for ${clientCtx}.\n\nCOMPETITORS: ${names}\n\nReturn one object per competitor.`,
    maxOutputTokens: 3500,
  });

  if (object.competitors.length === 0) return;

  const now = Date.now();
  await replaceReportCompetitors(
    clientId,
    object.competitors.map((c) => ({
      ...c,
      clientId,
      deepDive: false,
      source: "report" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/**
 * Parse a raw Markdown report, persist it, and bulk-create competitor rows.
 * Admin/employee only. Overwrites any existing report for this client.
 */
export async function importReportAction(
  clientId: string,
  markdown: string,
  pdfUrl?: string,
): Promise<void> {
  const user = await requireStaff();

  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");

  const parsed = parseMarkdownReport(markdown);
  const report = buildClientReport(clientId, parsed, markdown, pdfUrl);
  await upsertClientReport(report);

  const now = Date.now();
  await replaceReportCompetitors(
    clientId,
    parsed.competitorRows.map((row) => ({
      ...row,
      clientId,
      source: "report" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );

  await logActivity({
    clientId,
    timestamp: now,
    type: "INTEL_GENERATION",
    title: "Intel Report imported",
    description: `Markdown report parsed — score ${report.overallScore}/100 (${report.overallGrade}), ${parsed.competitorRows.length} competitors`,
    actor: user.name,
    actorRole: "staff",
  });

  revalidatePath(`/clients/${clientId}`);
}

/** Manually add a competitor to a client's tracker. */
export async function addCompetitorAction(
  clientId: string,
  input: {
    company: string;
    url?: string;
    founded?: string;
    marketTier: ClientCompetitor["marketTier"];
    minInvestment?: string;
    overlap: ClientCompetitor["overlap"];
    positioning?: string;
    scale?: string;
    keyStrengths?: string[];
    keyWeaknesses?: string[];
    threatLevel?: ClientCompetitor["threatLevel"];
  },
): Promise<void> {
  await requireStaff();

  const now = Date.now();
  await createClientCompetitor({
    clientId,
    company: input.company,
    url: input.url,
    founded: input.founded,
    marketTier: input.marketTier,
    minInvestment: input.minInvestment,
    overlap: input.overlap,
    deepDive: false,
    positioning: input.positioning,
    scale: input.scale,
    keyStrengths: input.keyStrengths ?? [],
    keyWeaknesses: input.keyWeaknesses ?? [],
    threatLevel: input.threatLevel,
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });

  try {
    const existingDoc = await getClientContextDoc(clientId, "competitor-analysis");
    if (existingDoc) {
      const today = new Date().toISOString().slice(0, 10);
      const signal = [
        "",
        "---",
        "",
        `## Manually Added Competitor — ${today}`,
        `- **Company:** ${input.company}`,
        ...(input.url ? [`- **Website:** ${input.url}`] : []),
        `- **Market Tier:** ${input.marketTier}`,
        ...(input.threatLevel ? [`- **Threat Level:** ${input.threatLevel}`] : []),
        `- **Overlap:** ${input.overlap}`,
        ...(input.positioning ? [`- **Positioning:** ${input.positioning}`] : []),
        ...(input.keyStrengths?.length ? [`- **Key Strengths:** ${input.keyStrengths.join(", ")}`] : []),
        ...(input.keyWeaknesses?.length ? [`- **Key Weaknesses:** ${input.keyWeaknesses.join(", ")}`] : []),
      ].join("\n");

      await upsertClientContextDoc({
        clientId,
        docType: "competitor-analysis",
        tier: existingDoc.tier,
        content: existingDoc.content + signal,
        version: existingDoc.version,
        sources: existingDoc.sources,
        createdAt: existingDoc.createdAt,
        updatedAt: now,
      });
    }
  } catch {
    // Non-fatal: competitor creation already succeeded
  }

  revalidatePath(`/clients/${clientId}`);
}

/** Remove a competitor from the tracker. */
export async function deleteCompetitorAction(id: string): Promise<void> {
  await requireStaff();
  await deleteClientCompetitor(id);
  revalidatePath("/clients");
}

/** Add a competitor by name and trigger AI analysis for the full tracked list. */
export async function addCompetitorAndAnalyzeAction(
  clientId: string,
  name: string,
): Promise<void> {
  const user = await requireStaff();
  if (!name.trim()) throw new Error("Competitor name required");

  await createClientCompetitor({
    clientId,
    company: name.trim(),
    marketTier: "Challenger",
    overlap: "Medium",
    deepDive: false,
    keyStrengths: [],
    keyWeaknesses: [],
    source: "manual",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "COMPETITOR_ADDED",
    title: `Competitor added: ${name.trim()}`,
    actor: user.name,
    actorRole: "staff",
  });

  try {
    await _analyzeCompetitors(clientId);
    await logActivity({
      clientId,
      timestamp: Date.now(),
      type: "COMPETITOR_ANALYZED",
      title: "Competitor intelligence updated",
      description: "AI analyzed all tracked competitors and refreshed profiles",
      actor: "System AI",
      actorRole: "system",
    });
  } catch {
    // Analysis failed; competitor name is saved, profiles will populate on next report run
  }

  revalidatePath(`/clients/${clientId}`);
}

/** Discover and fully analyze top competitors from scratch (for clients with no existing data). */
export async function backfillCompetitorsAction(clientId: string): Promise<void> {
  await requireStaff();
  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");

  const { generateObject } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { z } = await import("zod");

  const schema = z.object({
    competitors: z.array(
      z.object({
        company: z.string().describe("Exact competitor company name."),
        url: z.string().optional().describe("Primary website URL. Omit if unknown."),
        positioning: z.string().optional().describe(
          "STRICT: 3–5 words max. Noun phrase only — NO verbs, NO sentences, NO punctuation.",
        ),
        keyStrengths: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff.",
        ),
        keyWeaknesses: z.array(z.string()).describe(
          "STRICT: 2–3 items, each 2–4 words max. Keywords only — NO sentences, NO fluff.",
        ),
        threatLevel: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
        marketTier: z.enum(["Leader", "Challenger", "Niche", "Other"]),
        overlap: z.enum(["High", "Medium", "Low-Med", "Low"]),
      }),
    ),
  });

  const clientCtx = [
    `Company: ${client.name}`,
    client.website ? `Website: ${client.website}` : "",
    client.description ? `Description: ${client.description}` : "",
  ].filter(Boolean).join("\n");

  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema,
    system:
      "You are a market intelligence analyst producing data for a compact UI dashboard table. " +
      "Every text field you output is rendered directly in a table cell — long text BREAKS the layout. " +
      "\n\nABSOLUTE FORMATTING RULES (violating these corrupts the UI):\n" +
      "• positioning — max 5 words, noun phrase, no verbs.\n" +
      "• keyStrengths items — max 4 words each.\n" +
      "• keyWeaknesses items — max 4 words each.\n" +
      "• NEVER write complete sentences or use filler words.",
    prompt: `${clientCtx}\n\nIdentify the top 5–7 direct competitors. Return one object per competitor.`,
    maxOutputTokens: 4500,
  });

  if (object.competitors.length === 0) throw new Error("No competitors discovered — try adding names manually.");

  const now = Date.now();
  await replaceReportCompetitors(
    clientId,
    object.competitors.map((c) => ({
      ...c,
      clientId,
      deepDive: false,
      source: "report" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );

  await logActivity({
    clientId,
    timestamp: now,
    type: "COMPETITOR_ANALYZED",
    title: "Competitors discovered & analyzed",
    description: `AI identified and profiled ${object.competitors.length} competitors`,
    actor: "System AI",
    actorRole: "system",
  });

  revalidatePath(`/clients/${clientId}`);
}
