import "server-only";

import { listAssets, listClientMarketingAnalytics } from "@/lib/data";
import { isWorkspaceWriterConfigured, writeWorkspaceJson } from "@/lib/agent-engine/workspace-writer";
import { projectWhatWorks, type MeasuredPost, type WhatWorksProjection } from "@/lib/agent-engine/performance-signal";
import type { Asset, Client } from "@/lib/types";

/**
 * Writes what this client's own posts say worked into the place the engine
 * already looks.
 *
 * `projectWhatWorks` does the arithmetic and is pure. This is the half with
 * the side effect: it reads the rows, resolves what each post WAS, and writes
 * one document per platform to
 * `clients/<slug>/context/learning/<platform>/what-works.json` — the exact
 * path `client.getLearningContext` reads, in the envelope it unwraps.
 *
 * ## The envelope is not decoration
 *
 * The engine treats a file with no object `data` as ABSENT, deliberately: a
 * malformed projection is the projector's bug and must not become the run's
 * held status. So the shape is part of the contract, and `source` is what lets
 * a reviewer asking "why did it think that" see when the answer was computed
 * and from how many rows.
 *
 * ## An empty result is still written
 *
 * A platform with too little data gets a document carrying its refusal rather
 * than no document. Absent and "measured, nothing conclusive" are different
 * states, and only one of them means somebody should go and look. The engine
 * reads both as "no preference", which is correct either way.
 */

/** Where a post's trait comes from, in order. The first one present wins. */
function traitOf(asset: Asset | undefined): string | null {
  if (!asset) return null;
  // `templateKey` is the archetype the engine matches on ("carousel-edu"), and
  // is what makes this signal actionable rather than merely true. `type` is the
  // coarse fallback — it can still separate a carousel from a reel.
  const key = asset.templateKey?.trim();
  if (key) return key;
  return asset.type?.trim() || null;
}

export interface PerformanceSignalSyncResult {
  synced: boolean;
  /** Per platform: how many outliers were written, or the refusal recorded. */
  platforms: Array<{ platform: string; outliers: number; refusal?: string }>;
}

export async function syncPerformanceSignalToWorkspace(
  client: Client,
  now: Date = new Date(),
): Promise<PerformanceSignalSyncResult> {
  if (!client.agentsRepoSlug || !isWorkspaceWriterConfigured()) {
    return { synced: false, platforms: [] };
  }

  const [rows, assets] = await Promise.all([
    listClientMarketingAnalytics(client.id),
    listAssets({ clientId: client.id }),
  ]);
  if (rows.length === 0) return { synced: false, platforms: [] };

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const posts: MeasuredPost[] = rows.map((row) => ({
    assetId: row.assetId,
    platform: row.platform,
    engagementScore: row.engagementScore,
    source: row.source,
    ...(row.metricsVersion !== undefined ? { metricsVersion: row.metricsVersion } : {}),
    trait: traitOf(assetById.get(row.assetId)),
  }));

  const platforms = [...new Set(posts.map((p) => p.platform))].sort();
  const written: PerformanceSignalSyncResult["platforms"] = [];

  for (const platform of platforms) {
    const projection = projectWhatWorks(posts, platform, now);
    await writeWorkspaceJson(
      `clients/${client.agentsRepoSlug}/context/learning/${platform}/what-works.json`,
      envelope(platform, projection, posts.filter((p) => p.platform === platform).length),
    );
    written.push({
      platform,
      outliers: projection.outliers.length,
      ...(projection.refusal ? { refusal: projection.refusal } : {}),
    });
  }

  return { synced: true, platforms: written };
}

function envelope(platform: string, projection: WhatWorksProjection, rows: number) {
  return {
    kind: "what-works",
    platform,
    data: {
      outliers: projection.outliers,
      regeneratedAt: projection.regeneratedAt,
      // Carried INSIDE data so it travels with the document a run reads, not
      // only in a log this side. "Measured, nothing conclusive" is a real
      // answer and the reader deserves it.
      ...(projection.refusal ? { refusal: projection.refusal } : {}),
    },
    source: {
      projectedAt: projection.regeneratedAt,
      projectedBy: "karos-portal/performance-signal",
      // No hash: this projection is derived from rows that change every sync,
      // so a hash would differ on every tick and say nothing. The engine reads
      // it as a string and uses it for display only.
      contentHash: "",
      rows,
    },
  };
}
