import "server-only";
import { getClientSeoGeo, listAssets } from "@/lib/data";
import { toRoutableRecommendation, type RoutableRecommendation } from "./routable-recommendation";

/**
 * [SCRUM-260/T-B15] Shared read path: a client's most recent `seo-geo-agent`
 * report asset, parsed into `RoutableRecommendation`s.
 *
 * Factored out of `createTasksFromSeoGeoReportAction`
 * (`@/lib/actions/seo-geo-task-actions.ts`, T-B14) rather than duplicated,
 * because `approveSeoGeoRecommendationAction`
 * (`@/lib/actions/intel-actions.ts`, T-B15) needs the exact same "which asset
 * is the current report, and what does `toRoutableRecommendation` make of
 * its `routableRecommendations`" answer to find ONE recommendation by recId —
 * a second, independently-drifting copy of "latest first, meta.
 * agentEngineProductId === 'seo-geo-agent', meta.routableRecommendations is
 * an array" is exactly the kind of duplication that goes stale silently.
 *
 * Returns `undefined` when the client has no such asset at all — distinct
 * from `[]` (a report exists but parsed to zero valid recommendations) —
 * because `createTasksFromSeoGeoReportAction` reports those two cases
 * differently to its caller (a hard "no report yet" error vs. a quiet
 * `created: 0`).
 */
export async function latestSeoGeoReportRecommendations(
  clientId: string,
): Promise<RoutableRecommendation[] | undefined> {
  // Since 2026-09-05 the seo-geo-agent creates no portal asset — its output is
  // internal data — so the current report lives on `clientSeoGeo`. Records from
  // before then have no `routableRecommendations` there and fall through to the
  // asset scan below, which still finds the last asset-era report.
  const insights = await getClientSeoGeo(clientId);
  if (insights?.routableRecommendations) {
    return insights.routableRecommendations
      .map(toRoutableRecommendation)
      .filter((r): r is RoutableRecommendation => r !== undefined);
  }

  const assets = await listAssets({ clientId });
  // Latest first: listAssets already sorts by createdAt desc.
  const reportAsset = assets.find(
    (a) => a.meta?.agentEngineProductId === "seo-geo-agent" && Array.isArray(a.meta?.routableRecommendations),
  );
  if (!reportAsset) return undefined;

  const raw = reportAsset.meta?.routableRecommendations;
  return Array.isArray(raw)
    ? raw.map(toRoutableRecommendation).filter((r): r is RoutableRecommendation => r !== undefined)
    : [];
}

/**
 * Find one recommendation, by recId, within the client's most recent
 * `seo-geo-agent` report. `undefined` covers every "can't classify" case
 * alike (no report yet, report has no routableRecommendations, this recId
 * isn't in the current report) — callers treat all of them the same way:
 * no classification data means no automatic run, the same fail-safe default
 * `toRoutableRecommendation` itself uses for an unmapped record.
 */
export async function findRoutableRecommendation(
  clientId: string,
  recId: string,
): Promise<RoutableRecommendation | undefined> {
  const recs = await latestSeoGeoReportRecommendations(clientId);
  return recs?.find((r) => r.recId === recId);
}
