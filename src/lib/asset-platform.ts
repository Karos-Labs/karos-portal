import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";

/**
 * THE ASSET'S TARGET PLATFORM, ASKED IN ONE PLACE.
 *
 * An explicit schedule wins; otherwise the first of the agent's own channels
 * the asset's type can actually be published to.
 *
 * It lived inside `asset-actions.ts` until 2026-09-24, when the bulk approval
 * needed the same answer. Exporting it from there was not an option and the
 * sweep said so immediately: that file is `"use server"`, so every export is a
 * public server-action endpoint, and a synchronous helper would have been one
 * with no session check at all. It is a pure read over an asset, so it belongs
 * in a plain module both callers import — the alternative, a second copy in
 * the bulk path, is how a batch books a client's stills to TikTok.
 */
export function preferredPlatform(asset: Asset): string | undefined {
  if (asset.scheduledPlatform) return asset.scheduledPlatform;
  const compatible = PUBLISHABLE_PLATFORMS[asset.type] ?? [];
  return (asset.channels ?? []).find((c) => compatible.includes(c));
}
