import { type NextRequest, NextResponse } from "next/server";
import { listScheduledAssets, listAssets, listClientIntegrations, updateAsset, markAssetPublished, markIntegrationExpired, claimAssetForPublish, releaseAssetPublishClaim } from "@/lib/data";
import { blockingPredecessor } from "@/lib/post-chain";
import {
  TokenExpiredError,
  inferPlatform,
  publishAssetToPlatform,
} from "@/lib/integrations/publishers";
import { requireCronSecret } from "@/lib/cron-auth";
import { integrationIsUsable } from "@/lib/integration-status";

/**
 * Auto-publish cron (tier "auto" of the three-tier publishing flow).
 *
 * Every tick it drains scheduled assets whose time has passed and whose
 * publishMode is "auto" (or absent — legacy assets). Manual-push and
 * placeholder items are never touched here: manual goes out via the
 * publishAssetNowAction server action, placeholders never leave the calendar.
 *
 * Per-integration gate: an integration with autoPublish === false is treated
 * as unavailable for auto-posting even though it stays fully usable for
 * "Publish Now".
 *
 * Ordering gate: a due post whose series predecessor hasn't gone out yet is HELD
 * (see blockingPredecessor) rather than published, so a numbered series can't
 * start at no. 2 because no. 1 was still in drafts. Held posts keep their
 * status and are retried every tick, so the hold resolves itself as soon as the
 * predecessor publishes. /api/analytics/sync applies the same gate — without it
 * that cron's reconciler would flip a held post to "published" behind our back.
 */
export async function GET(req: NextRequest) {
  // Auth: Cloud Scheduler sends Authorization: Bearer <CRON_SECRET>. Fails closed
  // in production if CRON_SECRET is unset; open only for local dev convenience.
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const now = Date.now();
  // Limit to 50 assets per cron tick — prevents timeouts on large backlogs.
  // Older-scheduled assets are processed first (sorted by scheduledAt asc).
  const dueAssets = await listScheduledAssets({ before: now, limit: 50, autoOnly: true });

  if (dueAssets.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  // Deduplicate integration fetches: one Firestore read per unique client,
  // not one per asset. Fetched in parallel before the publish loop.
  const uniqueClientIds = [...new Set(dueAssets.map((a) => a.clientId))];
  const integrationsByClient = new Map(
    await Promise.all(
      uniqueClientIds.map(async (clientId) => {
        const integrations = await listClientIntegrations(clientId);
        return [clientId, integrations] as const;
      }),
    ),
  );

  // The ordering gate needs each client's WHOLE library, not just the due
  // assets: the blocker we're looking for is precisely the post that ISN'T due
  // (it's still a draft), so anything narrower can't see it. Same one-read-per-
  // client shape as the integrations above.
  const assetsByClient = new Map(
    await Promise.all(
      uniqueClientIds.map(async (clientId) => {
        const assets = await listAssets({ clientId });
        return [clientId, assets] as const;
      }),
    ),
  );

  type PublishResult = {
    assetId: string;
    platform: string;
    status: "published" | "failed" | "skipped" | "expired" | "held";
    error?: string;
  };

  // Publish all due assets concurrently. allSettled so one failure never
  // prevents other assets from being processed in the same cron tick.
  const settled = await Promise.allSettled(
    dueAssets.map(async (asset): Promise<PublishResult> => {
      // Ordering gate — first, before any platform work: a post whose
      // predecessor is still unpublished must not go out, and there's no point
      // resolving an integration for it. The hold clears by itself on the next
      // tick once the predecessor publishes (or is unscheduled), so this both
      // waits AND flags without anyone having to intervene in the common case.
      const blocker = blockingPredecessor(asset, assetsByClient.get(asset.clientId) ?? []);
      if (blocker) {
        const message = `Waiting for "${blocker.title}" - it comes earlier in this series and is still ${blocker.status}. This post goes out once that one is published (or removed).`;
        await updateAsset(asset.id, { publishError: message, updatedAt: Date.now() }).catch(() => {});
        return { assetId: asset.id, platform: asset.scheduledPlatform ?? "none", status: "held", error: message };
      }

      const integrations = integrationsByClient.get(asset.clientId) ?? [];
      // Auto-eligible = valid token AND the client hasn't turned off auto-publish
      // for that platform (absent flag = enabled, for pre-toggle integrations).
      const autoEligible = integrations.filter(
        (i) => integrationIsUsable(i) && i.autoPublish !== false,
      );
      const connectedPlatforms = autoEligible.map((i) => i.platform);

      const platform =
        asset.scheduledPlatform ??
        inferPlatform(asset.type, connectedPlatforms);

      if (!platform) {
        return {
          assetId: asset.id,
          platform: "none",
          status: "skipped",
          error: "No compatible platform connected",
        };
      }

      const integration = autoEligible.find((i) => i.platform === platform);
      if (!integration) {
        const exists = integrations.some((i) => i.platform === platform);
        return {
          assetId: asset.id,
          platform,
          status: "skipped",
          error: exists
            ? `Auto-publish is disabled or the token expired for ${platform} - use Publish Now or re-connect`
            : `Integration for ${platform} not found`,
        };
      }

      // Atomically claim the asset so a manual "Publish Now" or an overlapping
      // cron tick can't publish the same asset in parallel (→ duplicate post).
      const claimed = await claimAssetForPublish(asset.id);
      if (!claimed) {
        return {
          assetId: asset.id,
          platform,
          status: "skipped",
          error: "Skipped - already claimed by a concurrent publish",
        };
      }

      try {
        const { postId } = await publishAssetToPlatform(platform, integration, asset);
        await markAssetPublished(asset.id, postId);
        return { assetId: asset.id, platform, status: "published" };
      } catch (e) {
        // Release the claim so a later attempt can retry this asset.
        await releaseAssetPublishClaim(asset.id).catch(() => {});
        if (e instanceof TokenExpiredError) {
          // Mark the integration expired so the UI surfaces it and the next
          // cron tick skips the dead token rather than retrying indefinitely.
          await markIntegrationExpired(asset.clientId, platform).catch(() => {});
          return {
            assetId: asset.id,
            platform,
            status: "expired",
            error: e.message,
          };
        }
        // Transient error — leave as "scheduled" so the next cron tick retries,
        // but record the failure so the asset card can surface it.
        const message = e instanceof Error ? e.message : "Unknown error";
        await updateAsset(asset.id, { publishError: message, updatedAt: Date.now() }).catch(() => {});
        return {
          assetId: asset.id,
          platform,
          status: "failed",
          error: message,
        };
      }
    }),
  );

  const results: PublishResult[] = settled.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { assetId: "unknown", platform: "unknown", status: "failed", error: "Unexpected rejection" },
  );

  return NextResponse.json({
    processed: dueAssets.length,
    published: results.filter((r) => r.status === "published").length,
    failed: results.filter((r) => r.status === "failed").length,
    expired: results.filter((r) => r.status === "expired").length,
    held: results.filter((r) => r.status === "held").length,
    results,
  });
}
