import type { Job } from "@/lib/types";

/**
 * The two research agents. Their output IS the data the rest of the agents run
 * on (context docs, SEO/GEO insights, the intel report store); showing it in
 * Assets as a "note" beside real posts and articles was clutter at best and
 * misleading at worst — a client would approve or schedule a research dump.
 * Decided 2026-09-05.
 *
 * Its own module, with no imports beyond a type, because both `materialize.ts`
 * and `reconcile.ts` need these and the reconcile suites mock `./materialize`
 * down to `materializeAgentEngineDeliverable` alone — a helper that lived there
 * would be `undefined` under every one of those mocks.
 */
export const INTERNAL_DATA_PRODUCTS: ReadonlySet<string> = new Set(["intel-report-agent", "seo-geo-agent"]);

export function isInternalDataProduct(productId: string | undefined): boolean {
  return productId !== undefined && INTERNAL_DATA_PRODUCTS.has(productId);
}

/**
 * True once this job's current run has been materialized — as an asset, or
 * (internal-data products) without one, recorded on `agentEngineMaterializedRunId`.
 * Reconcile's "already done?" question, answered in one place.
 */
export function hasMaterialized(job: Pick<Job, "assetIds" | "agentEngineRunId" | "agentEngineMaterializedRunId">): boolean {
  return job.assetIds.length > 0 || (job.agentEngineRunId !== undefined && job.agentEngineMaterializedRunId === job.agentEngineRunId);
}
