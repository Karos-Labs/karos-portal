import type { ClientCompetitor } from "@/lib/types";

/** Strict cap on how many competitors the dashboard displays at once. */
export const TRACKED_COMPETITOR_LIMIT = 5;

const THREAT_WEIGHT: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const TIER_WEIGHT: Record<ClientCompetitor["marketTier"], number> = {
  Leader: 3,
  Challenger: 2,
  Niche: 1,
  Other: 0,
};
const OVERLAP_WEIGHT: Record<ClientCompetitor["overlap"], number> = {
  High: 3,
  Medium: 2,
  "Low-Med": 1,
  Low: 0,
};

/** Higher score = larger / more relevant industry rival, used to rank the auto-seeded pool. */
function autoSeedScore(c: ClientCompetitor): number {
  const threat = THREAT_WEIGHT[c.threatLevel ?? ""] ?? 0;
  const tier = TIER_WEIGHT[c.marketTier] ?? 0;
  const overlap = OVERLAP_WEIGHT[c.overlap] ?? 0;
  return threat * 100 + tier * 10 + overlap;
}

/**
 * Resolves the exactly-`limit` competitors shown on the dashboard: manually added
 * competitors always occupy the first slots (in the order they were added), and any
 * remaining slots are backfilled with the highest-priority auto-seeded ("report")
 * industry rivals. Pure/client-safe — takes the full tracked list and re-derives the
 * view, so deleting a row and recomputing naturally backfills the next-best rival.
 */
export function computeTrackedCompetitors(
  all: ClientCompetitor[],
  limit: number = TRACKED_COMPETITOR_LIMIT,
): ClientCompetitor[] {
  // Newest-first: if a client has tracked more than `limit` manually, keep the ones
  // they added most recently rather than getting stuck with the oldest forever.
  const manual = all
    .filter((c) => c.source === "manual")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  const remaining = limit - manual.length;
  if (remaining <= 0) return manual;

  const auto = all
    .filter((c) => c.source !== "manual")
    .sort((a, b) => autoSeedScore(b) - autoSeedScore(a) || a.company.localeCompare(b.company))
    .slice(0, remaining);

  return [...manual, ...auto];
}
