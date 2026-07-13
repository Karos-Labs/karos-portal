import { type NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  listClients,
  listClientIntegrations,
  listAssets,
  upsertClientMarketingAnalytics,
  markIntegrationExpired,
} from "@/lib/data";
import { fetchPlatformMetrics } from "@/lib/integrations/analytics-providers";
import { TokenExpiredError } from "@/lib/integrations/publishers";

export const maxDuration = 60;

/**
 * Analytics sync engine — the ingestion half of the Self-Improving Marketing
 * Loop. On each run it walks every client's connected integrations, pulls recent
 * per-asset performance metrics, normalizes each platform's native shape into the
 * unified schema, and upserts one row per (client, asset, platform) into
 * `clientMarketingAnalytics`. Those rows are what the Task Map engine reads back
 * (via `getClientPerformanceBenchmarks`) to bias new content toward winners.
 *
 * Robustness: every client and every asset is wrapped in its own try/catch, so
 * one bad integration never aborts the sweep. A real 401/403 marks the
 * integration expired (via TokenExpiredError) instead of persisting fake numbers;
 * an unwired live API falls back to deterministic mock data inside the provider.
 *
 * Live platform Insights APIs are stubbed today — see analytics-providers.ts.
 * Schedule via Cloud Scheduler (daily is plenty): GET, Authorization: Bearer <CRON_SECRET>.
 */

/** Only sync assets published within this window — bounds work as history grows. */
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

type SyncResult = {
  clientId: string;
  platform: string;
  assetId: string;
  action: "written" | "skipped" | "expired";
  source?: "live" | "mock";
  detail?: string;
};

export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const now = Date.now();
  const recentSince = now - RECENT_WINDOW_MS;
  const clients = await listClients();

  const results: SyncResult[] = [];
  let written = 0;
  let mock = 0;
  let live = 0;
  let expired = 0;
  let assetsScanned = 0;

  for (const client of clients) {
    try {
      const [integrations, assets] = await Promise.all([
        listClientIntegrations(client.id),
        listAssets({ clientId: client.id }),
      ]);

      // Connected, non-expired social integrations, keyed by platform. Gmail is
      // an operational integration, not a distribution channel — exclude it.
      const byPlatform = new Map(
        integrations
          .filter((i) => i.platform !== "google" && i.status !== "expired")
          .map((i) => [i.platform, i]),
      );
      if (byPlatform.size === 0) continue;

      // Recently-published assets that actually reached a platform.
      const published = assets.filter(
        (a) =>
          a.status === "published" &&
          a.publishedAt != null &&
          a.publishedAt >= recentSince &&
          !!a.scheduledPlatform,
      );

      for (const asset of published) {
        const platform = asset.scheduledPlatform!;
        const integration = byPlatform.get(platform);
        assetsScanned++;
        if (!integration) {
          results.push({
            clientId: client.id,
            platform,
            assetId: asset.id,
            action: "skipped",
            detail: "no active integration for platform",
          });
          continue;
        }

        try {
          const { metrics, source } = await fetchPlatformMetrics(platform, integration, asset);
          await upsertClientMarketingAnalytics({
            clientId: client.id,
            assetId: asset.id,
            taskId: (asset.meta?.taskId as string | undefined) ?? null,
            platform,
            assetType: asset.type,
            assetLabel: asset.title,
            metrics,
            source,
            capturedAt: now,
          });
          written++;
          if (source === "mock") mock++;
          else live++;
          results.push({ clientId: client.id, platform, assetId: asset.id, action: "written", source });
        } catch (e) {
          if (e instanceof TokenExpiredError) {
            await markIntegrationExpired(client.id, platform).catch(() => {});
            expired++;
            results.push({
              clientId: client.id,
              platform,
              assetId: asset.id,
              action: "expired",
              detail: "token expired — integration marked, will re-auth",
            });
          } else {
            results.push({
              clientId: client.id,
              platform,
              assetId: asset.id,
              action: "skipped",
              detail: `error: ${e instanceof Error ? e.message : "unknown"}`,
            });
          }
        }
      }
    } catch (e) {
      results.push({
        clientId: client.id,
        platform: "-",
        assetId: "-",
        action: "skipped",
        detail: `client sweep failed: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
  }

  return NextResponse.json({
    checked: { clients: clients.length, assetsScanned },
    recordsWritten: written,
    sources: { live, mock },
    integrationsExpired: expired,
    results,
  });
}
