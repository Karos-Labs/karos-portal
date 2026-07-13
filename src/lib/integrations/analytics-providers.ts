/**
 * Analytics providers — the single place that fetches performance metrics from
 * social-network Insights APIs. Mirrors the shape of `publishers.ts`: one async
 * function per platform with a uniform `(credentials, asset)` signature, a
 * `switch` dispatcher, and a shared typed error for dead tokens. Server-only.
 *
 * Live API calls are stubbed for now (we're preparing for them, not shipping
 * them): each `fetchLiveX` throws `MetricsUnavailableError`, and the dispatcher
 * falls back to a deterministic, realistic mock so the whole ingestion loop —
 * fetch → normalize → score → persist — is exercisable end-to-end today. When a
 * platform's real endpoint is wired in, replace its `fetchLiveX` body and the
 * mock fallback simply stops being reached.
 */

import "server-only";
import type { Asset, ClientIntegration, MarketingMetrics } from "@/lib/types";
import { mockRawMetrics, normalizePlatformMetrics, type RawPlatformMetrics } from "@/lib/analytics";
import { TokenExpiredError } from "@/lib/integrations/publishers";

/** Thrown when a platform's Insights API isn't wired up yet — triggers the mock fallback. */
export class MetricsUnavailableError extends Error {
  constructor(platform: string) {
    super(`Live metrics not available for ${platform} yet`);
    this.name = "MetricsUnavailableError";
  }
}

export interface PlatformMetricsResult {
  metrics: MarketingMetrics;
  /** "live" once a real API answered; "mock" while we fall back. */
  source: "live" | "mock";
}

/* ── Live fetch (stubbed) ────────────────────────────────────────────── */

/**
 * Endpoint map for the real per-platform Insights fetch, wired in later. Until
 * then this signals "not available" so the caller falls back to mock data:
 *   linkedin  → GET /rest/organizationalEntityShareStatistics (share URN)
 *   tiktok    → POST /v2/research/video/query/ (or Business Insights API)
 *   instagram → GET /{ig-media-id}/insights?metric=impressions,reach,saved,…
 *   facebook  → GET /{post-id}/insights?metric=post_impressions,post_clicks,…
 *   twitter   → GET /2/tweets/:id?tweet.fields=public_metrics,non_public_metrics
 *   youtube   → YouTube Analytics API reports query for the video id
 *
 * A real implementation branches on `platform`, authenticates with `credentials`,
 * and scopes the query to `asset`. It must throw `TokenExpiredError` on 401/403
 * so the cron marks the integration expired rather than masking a dead token
 * with fake numbers. Returns a platform-native payload for `normalizePlatformMetrics`.
 */
async function fetchLiveRaw(
  platform: string,
  credentials: Record<string, string>,
  asset: Asset,
): Promise<RawPlatformMetrics> {
  // No access token means we couldn't call a live API even if it were wired up.
  if (!credentials.accessToken) throw new MetricsUnavailableError(platform);
  // Live endpoints are not implemented yet; fall through to the mock path.
  throw new MetricsUnavailableError(`${platform} (asset ${asset.id})`);
}

/* ── Dispatcher ──────────────────────────────────────────────────────── */

/**
 * Fetch and normalize the recent performance metrics for one asset on one
 * platform. Tries the live API first; on `MetricsUnavailableError` (or any
 * non-auth error) it falls back to deterministic mock data so the loop keeps
 * running. A real `TokenExpiredError` propagates so the caller can mark the
 * integration expired rather than masking a broken connection with fake numbers.
 */
export async function fetchPlatformMetrics(
  platform: string,
  integration: ClientIntegration,
  asset: Asset,
): Promise<PlatformMetricsResult> {
  try {
    const raw = await fetchLiveRaw(platform, integration.credentials, asset);
    return { metrics: normalizePlatformMetrics(platform, raw), source: "live" };
  } catch (err) {
    if (err instanceof TokenExpiredError) throw err;
    // MetricsUnavailableError (stub) or a transient live failure → mock fallback.
    const raw = mockRawMetrics(platform, asset.id);
    return { metrics: normalizePlatformMetrics(platform, raw), source: "mock" };
  }
}
