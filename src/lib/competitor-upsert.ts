import "server-only";

import { createClientCompetitor, listClientCompetitors, updateClientCompetitor } from "@/lib/data";
import { competitorBrandKeys, parseCompetitorInput } from "@/lib/competitor-input";

/**
 * Create-or-promote a manual competitor from quick-add input.
 *
 * Lives outside `actions/` so it is NOT a server action: onboarding's Finish
 * (onboarding-actions.ts) and the quick-add action share it, and neither
 * exposes it to the network on its own.
 *
 * The input may be a name, a bare domain, or a full pasted URL; URLs are parsed
 * so the row carries a real `url` (favicon + identity keys) instead of storing
 * the raw string as its display name. If the brand is ALREADY in the pool under
 * any identity key, no new row is created: a matching report or lab row is
 * promoted to manual (the user explicitly wants it tracked — promotion locks a
 * tracked-5 slot and counts as "added now" for the newest-first manual
 * ordering), and a matching manual row is left untouched. This is what prevents
 * the classic duplicate of "https://speedrun.a16z.com" (manual, raw) +
 * "Speedrun by a16z" (report, resolved).
 */
export async function upsertManualCompetitor(
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
    if (hit.source !== "manual") {
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
