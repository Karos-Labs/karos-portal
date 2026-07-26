import "server-only";

import {
  createClientCompetitor,
  listClientCompetitors,
  updateClientCompetitor,
} from "@/lib/data";
import { brandKeys, normalizeBrandKey, type SeoGeoInsights } from "@/lib/seo-geo";
import { competitorBrandKeys } from "@/lib/competitor-input";

/** Max auto-created competitor rows per capture (pool candidates — the tracker still shows 5). */
const MAX_DISCOVERED_CREATES = 5;

/**
 * Write the measured AI-visibility signal back into the competitor pool after a
 * SEO/GEO capture:
 *
 *  1. Every existing competitor that was on the capture roster gets its
 *     `llmMentions` refreshed (including explicit zeros — "measured, never
 *     named" must rank below "named in 4 answers").
 *  2. The top non-roster brands the engines actually named (discoveredBrands)
 *     are created as auto-seeded ("report") competitor rows, so the tracked-5
 *     selector can surface them and the NEXT capture measures them properly.
 *
 * Together with the llmMentions term in computeTrackedCompetitors, this is what
 * makes competitor selection reflect who actually wins the AI conversation
 * instead of only the analyst's report guess. Manual rows are never created,
 * deleted, or re-ranked here — staff/client picks always keep their slots.
 */
export async function syncCompetitorsFromVisibility(
  clientId: string,
  insights: SeoGeoInsights,
): Promise<{ updated: number; created: number }> {
  const existing = await listClientCompetitors(clientId);
  // Every pool row is reachable under ALL its identity keys (name-derived and
  // url-derived) — one-sided keying misses rows whose display name isn't their
  // domain label and would create duplicates.
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const c of existing) {
    for (const k of competitorBrandKeys(c.company, c.url)) if (!byKey.has(k)) byKey.set(k, c);
  }

  const mentionsByKey = new Map(
    insights.competitorsNamed.map((c) => [normalizeBrandKey(c.name), c.mentions] as const),
  );

  let updated = 0;
  // Roster competitors (roster[0] is the client) were all measured this run —
  // absent from competitorsNamed means measured-but-never-named, i.e. zero.
  for (const rosterName of insights.roster.slice(1)) {
    const key = normalizeBrandKey(rosterName);
    const row = byKey.get(key);
    if (!row) continue;
    const mentions = mentionsByKey.get(key) ?? 0;
    if (row.llmMentions === mentions && row.llmMentionsAt === insights.capturedAt) continue;
    await updateClientCompetitor(row.id, {
      llmMentions: mentions,
      llmMentionsAt: insights.capturedAt,
      updatedAt: Date.now(),
    });
    updated++;
  }

  let created = 0;
  for (const brand of insights.discoveredBrands ?? []) {
    if (created >= MAX_DISCOVERED_CREATES) break;
    const keys = brandKeys(brand.name, brand.url);
    const existingRow = keys.map((k) => byKey.get(k)).find(Boolean);
    if (existingRow) {
      // Already in the pool under another spelling — refresh its measurement instead.
      if (existingRow.llmMentions !== brand.mentions || existingRow.llmMentionsAt !== insights.capturedAt) {
        await updateClientCompetitor(existingRow.id, {
          llmMentions: brand.mentions,
          llmMentionsAt: insights.capturedAt,
          ...(existingRow.url || !brand.url ? {} : { url: brand.url }),
          updatedAt: Date.now(),
        });
        updated++;
      }
      continue;
    }
    const now = Date.now();
    await createClientCompetitor({
      clientId,
      company: brand.name,
      ...(brand.url ? { url: brand.url } : {}),
      marketTier: "Challenger",
      overlap: "Medium",
      deepDive: false,
      positioning: "Frequently named by AI engines",
      keyStrengths: ["Strong AI-answer visibility"],
      keyWeaknesses: [],
      threatLevel: "MEDIUM",
      source: "report",
      llmMentions: brand.mentions,
      llmMentionsAt: insights.capturedAt,
      createdAt: now,
      updatedAt: now,
    });
    created++;
  }

  return { updated, created };
}
