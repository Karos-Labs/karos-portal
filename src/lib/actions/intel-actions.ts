"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import {
  getClient,
  updateClient,
  getAgent,
  upsertSystemAgent,
  updateAgent,
  listClientContextDocs,
  replaceClientContextDocs,
  getSystemAgent,
  getClientContextDoc,
  getClientContextDocByTier,
  updateContextDocSummary,
  updateContextDocContent,
} from "@/lib/data";
import { logger } from "@/services/logger";
import { getCurrentUser } from "@/lib/auth";
import type { ContextDocTier } from "@/lib/types";
import { requireStaff, requireAdmin, logActivity } from "./_shared";
import { MODELS } from "@/lib/constants";

/**
 * Generate a short (2-sentence) company brief from the client's context docs.
 * Cached on `client.brief` — only regenerates when `force` is set or no brief exists.
 * Callable by staff or the client themselves.
 */
export async function generateClientBriefAction(
  clientId: string,
  force = false,
): Promise<{ ok: true; brief: string } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user || user.disabled) return { ok: false, error: "Unauthorized" };
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  const client = await getClient(clientId);
  if (!client) return { ok: false, error: "Client not found" };
  if (client.brief && !force) return { ok: true, brief: client.brief };

  const docs = await listClientContextDocs(clientId);
  const source = ["product-information", "brand-voice", "market-strategy"]
    .map((dt) => docs.find((d) => d.docType === dt && d.tier === "client") ?? docs.find((d) => d.docType === dt))
    .filter(Boolean)
    .map((d) => d!.content.replace(/^---[\s\S]*?---\n?/, "").slice(0, 1800))
    .join("\n\n");

  if (!source.trim()) return { ok: false, error: "No documents to summarize yet." };

  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const MODEL = MODELS.HAIKU;
  const { text, usage } = await generateText({
    model: anthropic(MODEL),
    system:
      "Write a plain, factual company description in exactly two short sentences (about two lines total). " +
      "Describe what the company does and who it serves. " +
      "Do NOT use em dashes (—). Do NOT use marketing hype or adjectives like 'leading' or 'innovative'. " +
      "Return only the description text, no preamble.",
    messages: [{ role: "user", content: `Company: ${client.name}\n\n${source}` }],
    maxOutputTokens: 160,
  });

  after(() =>
    logger.logUsage({
      clientId,
      agentId: null,
      agentName: "Company Brief",
      modelName: MODEL,
      operation: "client_brief",
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }),
  );

  const brief = text
    .trim()
    .replace(/\s*[—–]\s*/g, ", ") // strip em/en dashes
    .replace(/^["']|["']$/g, "")
    .slice(0, 320);

  if (!brief) return { ok: false, error: "Could not generate a description." };

  await updateClient(clientId, { brief });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, brief };
}

export async function addActivityNoteAction(clientId: string, text: string): Promise<void> {
  const user = await requireStaff();
  if (!text.trim()) throw new Error("Note text is required");
  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "MANUAL_NOTE",
    title: "Note",
    description: text.trim(),
    actor: user.name,
    actorRole: "staff",
  });
  revalidatePath(`/clients/${clientId}`);
}

/**
 * Seed the Intel Report system agent into Firestore (idempotent).
 * Admin-only: call once from the admin UI or on first deploy.
 */
export async function seedIntelAgentAction(): Promise<void> {
  await requireAdmin();
  const { INTEL_AGENT_ID, DEFAULT_INTEL_PROMPT } = await import("@/lib/intel-report");
  const existing = await getAgent(INTEL_AGENT_ID);
  if (existing) return;
  const now = Date.now();
  await upsertSystemAgent(INTEL_AGENT_ID, {
    name: "Intel Report Agent",
    description:
      "Automated Digital Intelligence & Competitive Report generator. Runs via Claude API — never shown to clients.",
    icon: "BarChart2",
    color: "#C8FF00",
    model: MODELS.SONNET,
    systemPrompt: DEFAULT_INTEL_PROMPT,
    outputKind: "freeform",
    fields: [],
    capabilities: ["generate"],
    status: "published",
    isActive: true,
    shared: false,
    isSystem: true,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  });
}

/** Update the Intel Report Agent's system prompt template. Admin-only. */
export async function updateIntelPromptAction(template: string): Promise<void> {
  await requireAdmin();
  const { INTEL_AGENT_ID } = await import("@/lib/intel-report");
  await updateAgent(INTEL_AGENT_ID, { systemPrompt: template, updatedAt: Date.now() });
}

/**
 * Run the Intel Report pipeline for a client. Admins and employees only.
 */
export async function generateIntelReportAction(clientId: string): Promise<void> {
  await requireStaff();
  const { INTEL_AGENT_ID, runIntelReportPipeline } = await import("@/lib/intel-report");
  const existing = await getAgent(INTEL_AGENT_ID);
  if (!existing) await seedIntelAgentAction();
  await runIntelReportPipeline(clientId);
  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "INTEL_GENERATION",
    title: "Intel Report generated",
    description: "Full 5-agent competitive intelligence pipeline completed",
    actor: "System AI",
    actorRole: "system",
  });
  revalidatePath(`/clients/${clientId}`);
}

/**
 * Re-condense the existing internal context docs for a client into fresh client-tier docs.
 * Does NOT re-run the full 5-agent research pipeline — only the condensation pass.
 */
export async function refreshClientContextDocsAction(clientId: string): Promise<void> {
  await requireStaff();
  const { INTEL_AGENT_ID } = await import("@/lib/intel-report");

  const [client, agent, internalDocs] = await Promise.all([
    getClient(clientId),
    getSystemAgent(INTEL_AGENT_ID),
    listClientContextDocs(clientId, "internal"),
  ]);
  if (!client) throw new Error("Client not found");

  const { RESEARCH_ENGINE_RULES, METRICS_RULES } = await import("@/lib/onboard-templates");
  const isLegacyPrompt = agent?.systemPrompt?.startsWith("You are the Karos Intel AI");
  const additionalInstructions = (!isLegacyPrompt && agent?.systemPrompt) ? agent.systemPrompt : "";
  const rules = [RESEARCH_ENGINE_RULES, "", METRICS_RULES, additionalInstructions.trim()]
    .filter(Boolean)
    .join("\n");

  const internalMap: Record<string, string> = {};
  for (const doc of internalDocs) internalMap[doc.docType] = doc.content;

  const { refreshClientCondensedDocs } = await import("@/lib/condense-pipeline");
  const condensed = await refreshClientCondensedDocs(client, internalMap, rules);

  const existing = await listClientContextDocs(clientId);
  const nonClientDocs = existing.filter((d) => d.tier !== "client");
  const now = Date.now();

  await replaceClientContextDocs(clientId, [
    ...nonClientDocs.map(({ id: _id, ...rest }) => ({ ...rest, updatedAt: now })),
    ...condensed.map((doc) => ({
      clientId,
      docType: doc.docType,
      tier: "client" as ContextDocTier,
      content: doc.content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
  ]);

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Generate a 4-5 bullet executive summary for a context document using Claude Haiku.
 * Results are ephemeral — cached in client component state per session, not persisted.
 */
export async function generateDocSummaryAction(
  clientId: string,
  docType: string,
  tier: string,
): Promise<string[]> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) throw new Error("Forbidden");

  const docs = await listClientContextDocs(clientId);
  const doc =
    docs.find((d) => d.docType === docType && d.tier === tier) ??
    docs.find((d) => d.docType === docType);
  if (!doc) return [];

  // Serve cached summary if the doc content hasn't changed since last generation.
  if (doc.summary?.length && doc.summaryVersion === doc.version) {
    return doc.summary;
  }

  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const MODEL = MODELS.HAIKU;
  const { text, usage } = await generateText({
    model: anthropic(MODEL),
    system:
      "You are a strategic analyst. Distill the document into exactly 4-5 high-impact executive insights. " +
      "Return ONLY a valid JSON array of strings — no markdown, no preamble, no trailing text. " +
      "Each string: max 20 words, starts with an action verb or key noun, concrete and specific.",
    messages: [
      {
        role: "user",
        content: doc.content.replace(/^---[\s\S]*?---\n?/, "").slice(0, 4000),
      },
    ],
    maxOutputTokens: 450,
  });

  let bullets: string[];
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\n?|\n?```$/g, "");
    const arr = JSON.parse(cleaned);
    bullets = Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string" && s.length > 4).slice(0, 5)
      : [];
  } catch {
    bullets = text
      .split("\n")
      .map((l) => l.replace(/^[-*\d."'\[\]]+\s*/, "").trim())
      .filter((l) => l.length > 8)
      .slice(0, 5);
  }

  const { id: docId, version: docVersion } = doc;
  after(async () => {
    // Persist summary so the next request is served from cache (no LLM call).
    await updateContextDocSummary(docId, bullets, docVersion);
    logger.logUsage({
      clientId,
      agentId: null,
      agentName: "Executive Summary",
      modelName: MODEL,
      operation: "doc_summary",
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });
  });

  return bullets;
}

/**
 * Apply verified client corrections to a context document (Fix with Review feature).
 * Re-uses the document's current content without re-running the full research pipeline.
 * Also re-condenses the client-facing version so both tiers stay in sync.
 */
export async function applyDocCorrectionAction(
  clientId: string,
  docType: string,
  tier: string,
  corrections: string,
): Promise<void> {
  const user = await requireStaff();
  if (!corrections.trim()) throw new Error("Corrections text is required");

  const [client, doc] = await Promise.all([
    getClient(clientId),
    getClientContextDocByTier(clientId, docType, tier as import("@/lib/types").ContextDocTier),
  ]);
  if (!client) throw new Error("Client not found");
  if (!doc) throw new Error("Document not found");

  const { applyDocCorrections } = await import("@/lib/onboard-pipeline");
  const corrected = await applyDocCorrections(client, docType, doc.content, corrections);
  await updateContextDocContent(doc.id, corrected);

  // If we corrected an internal doc, apply the same corrections to the client-facing version too.
  if (tier === "internal") {
    const clientDoc = await getClientContextDocByTier(clientId, docType, "client");
    if (clientDoc) {
      const correctedClient = await applyDocCorrections(client, docType, clientDoc.content, corrections);
      await updateContextDocContent(clientDoc.id, correctedClient);
    }
  }

  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "CONTEXT_DOC_UPDATED",
    title: `${docType} corrected via Fix with Review`,
    description: corrections.length > 160
      ? corrections.slice(0, 157) + "…"
      : corrections,
    actor: user.name,
    actorRole: "staff",
  });

  revalidatePath(`/clients/${clientId}`);
}

export async function deleteContextItemAction(id: string) {
  await requireStaff();
  const { getContextItem, deleteContextItem } = await import("@/lib/data");
  const { deleteObject } = await import("@/lib/storage");
  const item = await getContextItem(id);
  if (!item) return;
  await deleteObject(item.storagePath);
  await deleteContextItem(id);
  revalidatePath(`/clients/${item.clientId}`);
}

export async function updateContextItemNoteAction(id: string, note: string) {
  await requireStaff();
  const { getContextItem, updateContextItem } = await import("@/lib/data");
  const item = await getContextItem(id);
  if (!item) throw new Error("Context item not found");
  await updateContextItem(id, { note: note.trim() });
  revalidatePath(`/clients/${item.clientId}`);
}

/** Upload a PDF report file to Firebase Storage and return its durable download URL. */
export async function uploadReportPdfAction(
  clientId: string,
  bytes: number[],
): Promise<string> {
  await requireStaff();
  const { uploadBytes } = await import("@/lib/storage");
  const buffer = Buffer.from(bytes);
  const path = `clients/${clientId}/reports/${Date.now()}_intel.pdf`;
  const { url } = await uploadBytes({ bytes: buffer, path, contentType: "application/pdf" });
  return url;
}
