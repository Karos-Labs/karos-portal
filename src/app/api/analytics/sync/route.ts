import { type NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  listClients,
  listClientIntegrations,
  listAssets,
  upsertClientMarketingAnalytics,
  markIntegrationForReauth,
  getEmployeeSeatsForSync,
  updateEmployeeSeat,
  reconcileAssetPublished,
} from "@/lib/data";
import { shouldReconcilePublished } from "@/lib/asset-lifecycle";
import { blockingPredecessor } from "@/lib/post-chain";
import { fetchPlatformMetrics, fetchSeatMetrics } from "@/lib/integrations/analytics-providers";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { integrationIsUsable } from "@/lib/integration-status";
import { logger } from "@/services/logger";

// Long-running batch: on GCP Cloud Run the request can run well past Vercel's
// old 60s ceiling. Cloud Scheduler triggers it and the container timeout governs.
export const maxDuration = 300;

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
  action: "written" | "skipped" | "expired" | "published";
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
  let seatsScanned = 0;
  let publishedReconciled = 0;

  for (const client of clients) {
    try {
      const [integrations, assets] = await Promise.all([
        listClientIntegrations(client.id),
        listAssets({ clientId: client.id }),
      ]);

      // Lifecycle reconciliation (runs regardless of integrations): flip assets
      // whose auto-publish slot has passed — or that carry a captured platform
      // post id — to "published", completing the parent task in the same
      // transaction, so nothing stays stuck on Approved/Scheduled after it's live.
      for (const a of assets) {
        if (!shouldReconcilePublished(a, now)) continue;
        // A post the publish cron is HOLDING for ordering looks exactly like a
        // reconcile candidate (auto, on-calendar, slot passed) — so without this
        // the two crons fight and this one wins, marking a post "published" that
        // was deliberately never posted, and un-blocking its successors in the
        // process. Same gate as /api/publish, same client-wide asset list.
        if (blockingPredecessor(a, assets)) continue;
        try {
          const r = await reconcileAssetPublished(a.id, now);
          if (r.changed) {
            publishedReconciled++;
            results.push({ clientId: client.id, platform: a.scheduledPlatform ?? "-", assetId: a.id, action: "published" });
          }
        } catch (e) {
          results.push({
            clientId: client.id,
            platform: a.scheduledPlatform ?? "-",
            assetId: a.id,
            action: "skipped",
            detail: `reconcile: ${e instanceof Error ? e.message : "unknown"}`,
          });
        }
      }

      // Connected, non-expired social integrations, keyed by platform. Gmail is
      // an operational integration, not a distribution channel — exclude it.
      const byPlatform = new Map(
        integrations
          .filter((i) => i.platform !== "google" && integrationIsUsable(i))
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
            await markIntegrationForReauth(client.id, platform).catch(() => {});
            logger.logError({
              clientId: client.id,
              agentId: null,
              operation: "analytics_sync",
              errorMessage: `${platform} token expired/revoked — marked for reauthentication`,
              severity: "WARN",
            });
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

      // LinkedIn employee-advocacy: measure every ACTIVE seat on its own handle.
      // Per-seat records aggregate dynamically through the per-client analytics
      // queries. A dead seat token pauses that seat and moves on (resilient).
      if (byPlatform.has("linkedin")) {
        const seats = await getEmployeeSeatsForSync(client.id);
        for (const seat of seats) {
          seatsScanned++;
          const seatAssetId = `seat_${seat.id}`;
          try {
            const { metrics, source } = await fetchSeatMetrics(seat);
            await upsertClientMarketingAnalytics({
              clientId: client.id,
              assetId: seatAssetId,
              taskId: null,
              platform: "linkedin",
              assetType: "employee_advocacy",
              assetLabel: seat.employeeName,
              metrics,
              source,
              capturedAt: now,
            });
            written++;
            if (source === "mock") mock++;
            else live++;
            results.push({ clientId: client.id, platform: "linkedin", assetId: seatAssetId, action: "written", source });
          } catch (e) {
            if (e instanceof TokenExpiredError) {
              await updateEmployeeSeat(client.id, seat.id, { status: "paused" }).catch(() => {});
              logger.logError({
                clientId: client.id,
                agentId: null,
                operation: "analytics_sync",
                errorMessage: `LinkedIn seat "${seat.employeeName}" token expired — seat paused`,
                severity: "WARN",
              });
              expired++;
              results.push({ clientId: client.id, platform: "linkedin", assetId: seatAssetId, action: "expired", detail: "seat token expired — paused" });
            } else {
              results.push({ clientId: client.id, platform: "linkedin", assetId: seatAssetId, action: "skipped", detail: `error: ${e instanceof Error ? e.message : "unknown"}` });
            }
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
    checked: { clients: clients.length, assetsScanned, seatsScanned },
    publishedReconciled,
    recordsWritten: written,
    sources: { live, mock },
    integrationsExpired: expired,
    results,
  });
}
