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

/**
 * Higher score = larger / more relevant industry rival, used to rank the auto-seeded pool.
 *
 * Measured AI-answer presence (llmMentions, written back after each SEO/GEO
 * capture) dominates: a rival the engines actually name outranks any
 * analyst-assessed threat/tier/overlap combination, because the tracked-5 feeds
 * the next capture's share-of-voice roster — we want to measure against the
 * brands that win the AI conversation. Analyst signals break ties and rank the
 * never-measured pool.
 */
function autoSeedScore(c: ClientCompetitor): number {
  const threat = THREAT_WEIGHT[c.threatLevel ?? ""] ?? 0;
  const tier = TIER_WEIGHT[c.marketTier] ?? 0;
  const overlap = OVERLAP_WEIGHT[c.overlap] ?? 0;
  const llm = Math.min(c.llmMentions ?? 0, 999);
  return llm * 1000 + threat * 100 + tier * 10 + overlap;
}

/**
 * Resolves the exactly-`limit` competitors shown on the dashboard: manually added
 * competitors always occupy the first slots (in the order they were added), and any
 * remaining slots are backfilled with the highest-priority auto-seeded ("report")
 * industry rivals. Pure/client-safe — takes the full tracked list and re-derives the
 * view, so deleting a row and recomputing naturally backfills the next-best rival.
 *
 * `limit: null` ⇒ no cap at all (portal revamp Account Center Competitors tab —
 * "holds everything we gather"): every manual row, then every auto-seeded rival,
 * same ordering, nothing dropped. Kept a distinct case rather than `Infinity`
 * so `remaining <= 0` still short-circuits correctly with a real limit of 0.
 */
export function computeTrackedCompetitors(
  all: ClientCompetitor[],
  limit: number | null = TRACKED_COMPETITOR_LIMIT,
): ClientCompetitor[] {
  const manualSorted = [...all]
    .filter((c) => c.source === "manual")
    .sort((a, b) => b.createdAt - a.createdAt);
  const autoSorted = [...all]
    .filter((c) => c.source !== "manual")
    .sort((a, b) => autoSeedScore(b) - autoSeedScore(a) || a.company.localeCompare(b.company));

  if (limit === null) return [...manualSorted, ...autoSorted];

  // Newest-first: if a client has tracked more than `limit` manually, keep the ones
  // they added most recently rather than getting stuck with the oldest forever.
  const manual = manualSorted.slice(0, limit);
  const remaining = limit - manual.length;
  if (remaining <= 0) return manual;

  return [...manual, ...autoSorted.slice(0, remaining)];
}
