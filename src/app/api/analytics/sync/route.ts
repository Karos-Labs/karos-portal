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
import { syncSlotPostedForAsset } from "@/lib/client-agent-slots";
import { DEFAULT_PLATFORM_FOR_TYPE } from "@/lib/scheduling";
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
  action: "written" | "skipped" | "expired" | "published" | "unavailable";
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
  /**
   * Assets/seats scanned that no live API could answer for. They used to be
   * counted as `mock` and WRITTEN; now they are counted here and skipped, so
   * this number is the honest size of the measurement gap rather than the size
   * of the invented dataset.
   */
  let unavailable = 0;
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
            // The slot this asset fulfils records that its day happened (§3).
            // Best-effort: a missed stamp costs nothing and re-derives later.
            await syncSlotPostedForAsset({ clientId: client.id, assetId: a.id, now }).catch(
              () => {},
            );
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
      // NOTE (rewritten 2026-08): a client with none of these connected is
      // still scanned, but nothing is WRITTEN for them any more.
      // fetchPlatformMetrics used to answer a missing token with deterministic
      // mock data "so demo/dev clients still get a working Self-Improving
      // Loop" — which meant the loop improved itself against invented numbers,
      // and those rows then reached content generation and the client-facing
      // strategy swarm as measurement. It returns null now; the asset is
      // recorded as `unavailable` in the run report and no row is persisted.
      const byPlatform = new Map(
        integrations
          .filter((i) => i.platform !== "google" && integrationIsUsable(i))
          .map((i) => [i.platform, i]),
      );

      // Recently-published assets that actually reached a platform. Some published
      // assets (bulk-imported/legacy content marked "published" outside the normal
      // schedule flow) never got `scheduledPlatform` set — infer it from the asset
      // type (e.g. "instagram_post" → "instagram") rather than dropping them, so
      // real published content still shows up in AI Insights / Task Map winners.
      const published = assets
        .map((a) => ({ asset: a, platform: a.scheduledPlatform ?? DEFAULT_PLATFORM_FOR_TYPE[a.type] }))
        .filter(
          (p): p is { asset: typeof p.asset; platform: string } =>
            p.asset.status === "published" &&
            p.asset.publishedAt != null &&
            p.asset.publishedAt >= recentSince &&
            !!p.platform,
        );

      for (const { asset, platform } of published) {
        const integration = byPlatform.get(platform);
        assetsScanned++;

        try {
          const measured = await fetchPlatformMetrics(platform, integration?.credentials ?? {}, asset);
          // null = no live API could answer. Write nothing rather than a
          // stand-in; "not measured" is a state every reader already renders.
          if (!measured) {
            unavailable++;
            results.push({
              clientId: client.id,
              platform,
              assetId: asset.id,
              action: "unavailable",
              detail: "no live metrics for this asset — nothing written",
            });
            continue;
          }
          const { metrics, source } = measured;
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
          live++;
          results.push({ clientId: client.id, platform, assetId: asset.id, action: "written", source });
        } catch (e) {
          if (e instanceof TokenExpiredError) {
            await markIntegrationForReauth(client.id, platform).catch(() => {});
            logger.logError({
              clientId: client.id,
              agentId: null,
              operation: "analytics_sync",
              errorMessage: `${platform} token expired/revoked - marked for reauthentication`,
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
            const measured = await fetchSeatMetrics(seat);
            // Seats have no live analytics path at all until the LinkedIn
            // Marketing API is granted, so this is null every time today. The
            // call is still made because it validates the token, which is what
            // pauses a dead seat in the catch below.
            if (!measured) {
              unavailable++;
              results.push({
                clientId: client.id,
                platform: "linkedin",
                assetId: seatAssetId,
                action: "unavailable",
                detail: "seat analytics need LinkedIn Marketing API access — nothing written",
              });
              continue;
            }
            const { metrics, source } = measured;
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
            live++;
            results.push({ clientId: client.id, platform: "linkedin", assetId: seatAssetId, action: "written", source });
          } catch (e) {
            if (e instanceof TokenExpiredError) {
              await updateEmployeeSeat(client.id, seat.id, { status: "paused" }).catch(() => {});
              logger.logError({
                clientId: client.id,
                agentId: null,
                operation: "analytics_sync",
                errorMessage: `LinkedIn seat "${seat.employeeName}" token expired - seat paused`,
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
    sources: { live, unavailable },
    integrationsExpired: expired,
    results,
  });
}
