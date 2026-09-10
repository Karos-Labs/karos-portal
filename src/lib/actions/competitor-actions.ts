"use server";

import { revalidatePath } from "next/cache";
import {
  getClient,
  getClientCompetitor,
  createClientCompetitor,
  deleteClientCompetitor,
  listClientCompetitors,
  replaceReportCompetitors,
  updateClientCompetitor,
} from "@/lib/data";
import { competitorBrandKeys, parseCompetitorInput } from "@/lib/competitor-input";
import { requireStaff, requireClientAccess, logActivity } from "./_shared";
import { CREDIT_COSTS } from "@/lib/credits";
import { withClientModelCharge } from "@/lib/client-model-charge";
import { logger } from "@/services/logger";

import { SYSTEM_AI_ACTOR_NAME } from "@/lib/activity-actors";
import type { z as zType } from "zod";
/**
 * Create-or-promote a manual competitor from quick-add input — not exported.
 *
 * The input may be a name, a bare domain, or a full pasted URL; URLs are parsed
 * so the row carries a real `url` (favicon + identity keys) instead of storing
 * the raw string as its display name. If the brand is ALREADY in the pool under
 * any identity key, no new row is created: a matching report row is promoted to
 * manual (the user explicitly wants it tracked — promotion locks a tracked-5
 * slot and counts as "added now" for the newest-first manual ordering), and a
 * matching manual row is left untouched. This is what prevents the classic
 * duplicate of "https://speedrun.a16z.com" (manual, raw) + "Speedrun by a16z"
 * (report, resolved).
 */
async function upsertManualCompetitor(
  clientId: string,
  rawInput: string,
): Promise<{ id: string; company: string; url?: string; created: boolean }> {
  const parsed = parseCompetitorInput(rawInput);
  const existing = await listClientCompetitors(clientId);
  const keys = competitorBrandKeys(parsed.company, parsed.url);
  const hit = existing.find((c) =>
    competitorBrandKeys(c.company, c.url).some((k) => keys.includes(k)),
  );
  const now = Date.now();

  if (hit) {
    if (hit.source === "report") {
      await updateClientCompetitor(hit.id, {
        source: "manual",
        ...(hit.url || !parsed.url ? {} : { url: parsed.url }),
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      id: hit.id,
      company: hit.company,
      ...(hit.url || parsed.url ? { url: hit.url ?? parsed.url } : {}),
      created: false,
    };
  }

  const id = await createClientCompetitor({
    clientId,
    company: parsed.company,
    ...(parsed.url ? { url: parsed.url } : {}),
    marketTier: "Challenger",
    overlap: "Medium",
    deepDive: false,
    keyStrengths: [],
    keyWeaknesses: [],
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    company: parsed.company,
    ...(parsed.url ? { url: parsed.url } : {}),
    created: true,
  };
}

/**
 * Best-effort website lookup for a manually-added competitor that has no URL —
 * covers the client-facing add path, which (unlike the staff path below) never
 * triggers full AI re-analysis. A single small model call so the row still
 * gets its favicon and a clickable site automatically when the company is
 * recognized; silently returns undefined otherwise (initials chip, no link).
 * Client-billed like any other client-triggered model call — see the call
 * site, which prices and refunds it through `withClientModelCharge`.
 */
async function resolveCompetitorWebsite(clientId: string, company: string): Promise<string | undefined> {
  try {
    const { generateObject } = await import("ai");
    const { aiFor, usageFor } = await import("@/lib/ai/provider");
    const { z } = await import("zod");

    const schema = z.object({
      url: z.string().optional().describe(
        "The company's primary website domain, e.g. 'example.com'. Omit if you don't " +
        "recognize this company or it has no website — never guess.",
      ),
    });

    const usageMeta = {
      clientId, agentId: null, agentName: "Competitor URL Lookup",
      ...usageFor("competitor.analysis"), operation: "competitor_url_lookup",
    };
    const { object, usage } = await generateObject({
      model: aiFor("competitor.analysis").model,
      schema,
      system: "You identify company websites for a competitor-tracking UI. Return a bare domain only — no protocol, no path.",
      prompt: `What is the primary website domain for the company "${company}"?`,
      maxOutputTokens: 200,
    });

    logger.logUsage({
      ...usageMeta,
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    });

    return object.url?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Core AI competitor analysis helper — not exported. */
async function _analyzeCompetitors(clientId: string): Promise<void> {
  const [client, competitors] = await Promise.all([
    getClient(clientId),
    listClientCompetitors(clientId),
  ]);
  if (!client || competitors.length === 0) return;

  const { generateObject } = await import("ai");
  const { aiFor, usageFor } = await import("@/lib/ai/provider");
  const { z } = await import("zod");

  const schema = z.object({
    competitors: z.array(
      z.object({
        company: z.string().describe("Exact competitor name as provided."),
        url: z.string().optional().describe(
          "Primary website domain, e.g. 'example.com'. REQUIRED for any real company you recognize — " +
          "the UI derives the competitor's favicon and AI-answer matching aliases from it. " +
          "Omit ONLY if the company genuinely has no website or you cannot identify it.",
        ),
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

  const competitorUsageMeta = {
    clientId, agentId: null, agentName: "Competitor Analysis",
    ...usageFor("competitor.analysis"), operation: "competitor_analysis",
  };
  let object: zType.infer<typeof schema>;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    ({ object, usage } = await generateObject({
      model: aiFor("competitor.analysis").model,
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
    }));
  } catch (err) {
    logger.logGenerationFailure(competitorUsageMeta, err);
    throw err;
  }

  logger.logUsage({
    ...competitorUsageMeta,
    inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
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
 * Stop tracking a competitor from the dashboard widget — accessible to staff and
 * the client's own CLIENT_USER. Re-fetches the competitor server-side and verifies
 * it actually belongs to `clientId` (mirrors requireTaskAccess) so a CLIENT_USER
 * can't delete another client's competitor by pairing a foreign id with their own
 * clientId; the same error is thrown whether the id is missing or belongs to
 * someone else, so foreign ids aren't leaked. Any tracked row — manual or
 * report/staff-seeded — is removable by the client, not just their own manual
 * adds: it's their tracker. Removing a row is sufficient to trigger the
 * dashboard's backfill — the tracked-list view is recomputed from whatever
 * remains, so the next highest-priority auto-seeded rival fills the slot
 * (report rows also regenerate on the next intel run regardless).
 */
export async function removeCompetitorAction(clientId: string, id: string): Promise<void> {
  const user = await requireClientAccess(clientId);
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  const competitor = await getClientCompetitor(id);
  if (!competitor || competitor.clientId !== clientId) throw new Error("Competitor not found");

  await deleteClientCompetitor(id);

  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "COMPETITOR_REMOVED",
    title: `Competitor removed: ${competitor.company}`,
    actor: user.name,
    actorRole: isStaff ? "staff" : "client",
  });

  revalidatePath(`/clients/${clientId}`);
}

/** Discover and fully analyze top competitors from scratch (for clients with no existing data). */
export async function backfillCompetitorsAction(clientId: string): Promise<void> {
  await requireStaff();
  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");

  const { generateObject } = await import("ai");
  const { aiFor, usageFor } = await import("@/lib/ai/provider");
  const { z } = await import("zod");

  const schema = z.object({
    competitors: z.array(
      z.object({
        company: z.string().describe("Exact competitor company name."),
        url: z.string().optional().describe(
          "Primary website domain, e.g. 'example.com'. REQUIRED for any real company you recognize — " +
          "the UI derives the competitor's favicon and AI-answer matching aliases from it. " +
          "Omit ONLY if the company genuinely has no website or you cannot identify it.",
        ),
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

  const discoveryUsageMeta = {
    clientId, agentId: null, agentName: "Competitor Discovery",
    ...usageFor("competitor.analysis"), operation: "competitor_analysis",
  };
  let object: zType.infer<typeof schema>;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    ({ object, usage } = await generateObject({
      model: aiFor("competitor.analysis").model,
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
    }));
  } catch (err) {
    logger.logGenerationFailure(discoveryUsageMeta, err);
    throw err;
  }

  logger.logUsage({
    ...discoveryUsageMeta,
    inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
  });

  if (object.competitors.length === 0) throw new Error("No competitors discovered - try adding names manually.");

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
    // Prose on the client's timeline, so "and" rather than an ampersand.
    title: "Competitors discovered and analyzed",
    description: `AI identified and profiled ${object.competitors.length} competitors`,
    actor: SYSTEM_AI_ACTOR_NAME,
    actorRole: "system",
  });

  revalidatePath(`/clients/${clientId}`);
}

/**
 * Add a competitor by name or pasted URL — accessible to both staff and the
 * client themselves. Staff trigger AI re-analysis after saving; CLIENT_USER
 * saves the record only.
 */
export async function addCompetitorByNameAction(
  clientId: string,
  name: string,
): Promise<{ id: string; company: string; url?: string; created: boolean }> {
  const user = await requireClientAccess(clientId);
  if (!name.trim()) throw new Error("Competitor name required");

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";

  const result = await upsertManualCompetitor(clientId, name);
  const { company } = result;

  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "COMPETITOR_ADDED",
    title: `Competitor added: ${company}`,
    actor: user.name,
    actorRole: isStaff ? "staff" : "client",
  });

  if (isStaff) {
    try {
      await _analyzeCompetitors(clientId);
      await logActivity({
        clientId,
        timestamp: Date.now(),
        type: "COMPETITOR_ANALYZED",
        title: "Competitor intelligence updated",
        description: "AI analyzed all tracked competitors and refreshed profiles",
        actor: SYSTEM_AI_ACTOR_NAME,
        actorRole: "system",
      });
    } catch {
      // Analysis failed; competitor is saved, profiles will populate on next report run
    }
  } else if (result.created && !result.url) {
    // Client path skips full re-analysis (credits, latency) but still deserves
    // the same automatic favicon + website every other row gets — priced and
    // refunded like any other one-off AI tool the client presses in the
    // portal (staff and View-as-Client sessions are never billed, per
    // `withClientModelCharge`/`isBillableClientActor`).
    const outcome = await withClientModelCharge(
      {
        user,
        clientId,
        amount: CREDIT_COSTS.taskAssist,
        operation: "ai_tool",
        reason: `Website lookup · ${company.slice(0, 60)}`,
      },
      async ({ refund }) => {
        const found = await resolveCompetitorWebsite(clientId, company);
        if (!found) {
          await refund("Refund · no website found");
          return undefined;
        }
        return found;
      },
    );
    if (outcome.ok && outcome.result) {
      await updateClientCompetitor(result.id, { url: outcome.result, updatedAt: Date.now() });
      result.url = outcome.result;
    }
  }

  revalidatePath(`/clients/${clientId}`);
  // Returned so the caller can render the new row immediately: the sidebar's
  // competitor list comes from route-scoped context that only the client-page
  // layout refills, so off a client page revalidate + refresh could never show
  // it (QA F62).
  return result;
}
