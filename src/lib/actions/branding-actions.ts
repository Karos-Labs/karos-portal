"use server";

import { revalidatePath } from "next/cache";
import {
  updateClient,
  listClients,
  getClient,
  getClientContextDoc,
  upsertClientContextDoc,
} from "@/lib/data";
import {
  applyBrandingForClient,
  brandingToContextDocContent,
  buildBrandVoiceSection,
  injectBrandVoiceSection,
  type BrandingGenResult,
} from "@/lib/branding";
import type { BrandColor, BrandingGuidelines } from "@/lib/types";
import { requireStaff, requireAdmin, requireClientAccess, logActivity } from "./_shared";

/**
 * usagePct is internal mix guidance (CD-E2): a CLIENT_USER never receives it
 * and their form never sends it, so a client editing the palette would
 * otherwise silently blank the agency's numbers. Re-apply the stored values,
 * matched on hex first (a reorder keeps its share) and position second.
 * Staff payloads pass through untouched — that is how a share gets cleared.
 */
function preserveInternalUsage(
  incoming: BrandColor[] | undefined,
  stored: BrandColor[] | undefined,
): BrandColor[] | undefined {
  if (!incoming?.length || !stored?.length) return incoming;
  const byHex = new Map<string, number>();
  for (const c of stored) {
    if (c.usagePct != null) byHex.set(c.hex.toLowerCase(), c.usagePct);
  }
  return incoming.map((c, i) => {
    const pct = byHex.get(c.hex.toLowerCase()) ?? stored[i]?.usagePct;
    return pct != null ? { ...c, usagePct: pct } : c;
  });
}

/** Save or update branding guidelines for a client. Single source of truth:
 *  writes the structured client field AND keeps both context docs in sync so
 *  AI agents never see stale or conflicting branding data.
 */
export async function saveBrandingGuidelinesAction(
  clientId: string,
  guidelines: Omit<BrandingGuidelines, "updatedAt">,
): Promise<void> {
  const user = await requireClientAccess(clientId);

  // Read BEFORE the write: a client's payload carries no usagePct, so the
  // stored values have to be merged back in (CD-E2).
  const client = await getClient(clientId);
  const dominantColors =
    user.role === "CLIENT_USER"
      ? preserveInternalUsage(
          guidelines.dominantColors,
          client?.brandingGuidelines?.dominantColors,
        )
      : guidelines.dominantColors;

  const fullGuidelines: BrandingGuidelines = {
    ...guidelines,
    ...(dominantColors ? { dominantColors } : {}),
    updatedAt: Date.now(),
  };
  const now = Date.now();

  const [, brandingDoc, voiceDoc] = await Promise.all([
    updateClient(clientId, { brandingGuidelines: fullGuidelines }),
    // Deterministic tier — see the matching write in src/lib/branding.ts.
    getClientContextDoc(clientId, "branding-guidelines", "internal"),
    getClientContextDoc(clientId, "brand-voice", "internal"),
  ]);

  const clientName = client?.name ?? clientId;

  await Promise.allSettled([
    upsertClientContextDoc({
      clientId,
      docType: "branding-guidelines",
      tier: brandingDoc?.tier ?? "internal",
      content: brandingToContextDocContent(fullGuidelines, clientName),
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

  await logActivity({
    clientId,
    timestamp: now,
    type: "BRANDING_UPDATED",
    title: "Brand guidelines updated",
    description: "Colors, fonts and tone keywords manually saved",
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
  });

  revalidatePath(`/clients/${clientId}`);
}

/**
 * AI-generate branding guidelines for a client via Claude Haiku world knowledge.
 */
export async function generateBrandingAction(clientId: string): Promise<BrandingGenResult> {
  const user = await requireStaff();

  const result = await applyBrandingForClient(clientId);

  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "BRANDING_UPDATED",
    title: "Brand guidelines generated via AI",
    description: `AI generated brand profile from domain knowledge${result.primaryAccent ? ` · ${result.primaryAccent}` : ""}${result.visualStyle ? ` · ${result.visualStyle}` : ""}`,
    actor: user.name,
    actorRole: "staff",
    metadata: { source: result.source, primaryAccent: result.primaryAccent },
  });

  revalidatePath(`/clients/${clientId}`);
  return result;
}

/**
 * One-time retroactive backfill: AI-generate branding guidelines for every client.
 * Runs sequentially to stay within Anthropic API rate limits. Admin-only.
 */
export async function backfillBrandingForAllClientsAction(): Promise<{
  total: number;
  generated: number;
  failed: number;
  results: Array<{ clientId: string; name: string; status: "ai_generated" | "failed"; primaryAccent?: string }>;
}> {
  await requireAdmin();

  const clients = await listClients();
  const results: Array<{
    clientId: string;
    name: string;
    status: "ai_generated" | "failed";
    primaryAccent?: string;
  }> = [];

  for (const client of clients) {
    try {
      const r = await applyBrandingForClient(client.id, client);
      results.push({ clientId: client.id, name: client.name, status: r.source, primaryAccent: r.primaryAccent });
    } catch (err) {
      console.error(`[backfill] Failed for ${client.name} (${client.id}):`, err);
      results.push({ clientId: client.id, name: client.name, status: "failed" });
    }
  }

  revalidatePath("/clients");

  return {
    total: clients.length,
    generated: results.filter((r) => r.status === "ai_generated").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}
