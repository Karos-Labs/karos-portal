import type { Asset } from "@/lib/types";

/**
 * Returns the asset set that should be visible in the client-facing library.
 * Drafts remain visible so pending work is reviewable alongside approved and
 * published deliverables, and the list is ordered by recency.
 */
export function getClientLibraryAssets(assets: Asset[]): Asset[] {
  return [...assets].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
}
