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
import type { BrandingGuidelines } from "@/lib/types";
import { requireStaff, requireAdmin, requireClientAccess, logActivity } from "./_shared";

/** Save or update branding guidelines for a client. Single source of truth:
 *  writes the structured client field AND keeps both context docs in sync so
 *  AI agents never see stale or conflicting branding data.
 */
export async function saveBrandingGuidelinesAction(
  clientId: string,
  guidelines: Omit<BrandingGuidelines, "updatedAt">,
): Promise<void> {
  const user = await requireClientAccess(clientId);

  const fullGuidelines: BrandingGuidelines = { ...guidelines, updatedAt: Date.now() };
  const now = Date.now();

  const [, client, brandingDoc, voiceDoc] = await Promise.all([
    updateClient(clientId, { brandingGuidelines: fullGuidelines }),
    getClient(clientId),
    getClientContextDoc(clientId, "branding-guidelines"),
    getClientContextDoc(clientId, "brand-voice"),
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
