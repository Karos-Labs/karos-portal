import "server-only";
import type { Client } from "@/lib/types";
import { dispatchAgentEngineRun, type DispatchAgentEngineRunResult } from "./dispatch";

/**
 * Task 1's "independent, observable steps" — dispatches `seo-geo-agent`/
 * `intel-report-agent` through agent-engine's Pub/Sub topic whenever
 * onboarding runs (`src/lib/intel/pipeline.ts`'s `runOnboardPipeline`),
 * alongside (never instead of) the existing rich in-process SEO/GEO and
 * Intel Report pipelines. Deliberately NOT wired to write into
 * `upsertClientSeoGeo`/`upsertClientReport`: agent-engine's `seo-geo-agent`
 * and `intel-report-agent` currently produce a structurally different
 * output (no citation leaderboards, per-engine visibility, roster, etc.) —
 * see this task's own scoping note. Each dispatch is its own real `jobs`
 * doc, visible in the Jobs list independent of whatever the in-process
 * pipeline is doing, which is what makes it "observable" rather than a
 * side effect buried inside another function's log lines.
 *
 * Best-effort: a dispatch failure here (Pub/Sub misconfigured, agent-engine
 * down) is logged as its own failed `jobs` doc but never thrown — it must
 * never block or fail the real onboarding pipeline that already produces
 * the client's actual SEO/GEO/report data.
 */
export async function dispatchOnboardingResearchAgents(client: Pick<Client, "id" | "name" | "agentsRepoSlug">): Promise<{
  seoGeo: DispatchAgentEngineRunResult | { skipped: true; reason: string };
  intelReport: DispatchAgentEngineRunResult | { skipped: true; reason: string };
}> {
  if (!client.agentsRepoSlug) {
    const skipped = { skipped: true as const, reason: "client has no agentsRepoSlug configured" };
    return { seoGeo: skipped, intelReport: skipped };
  }

  const [seoGeo, intelReport] = await Promise.all([
    dispatchAgentEngineRun({
      clientId: client.id,
      clientSlug: client.agentsRepoSlug,
      productId: "seo-geo-agent",
      runKind: "recurring",
      agentName: "SEO/GEO Research (Agent Engine)",
      title: `[Agent Engine] SEO/GEO research — ${client.name}`,
    }),
    dispatchAgentEngineRun({
      clientId: client.id,
      clientSlug: client.agentsRepoSlug,
      productId: "intel-report-agent",
      runKind: "recurring",
      agentName: "Intel Report (Agent Engine)",
      title: `[Agent Engine] Intel report — ${client.name}`,
    }),
  ]);

  return { seoGeo, intelReport };
}
