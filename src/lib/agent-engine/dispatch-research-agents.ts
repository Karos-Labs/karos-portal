import "server-only";
import type { Client } from "@/lib/types";
import { dispatchAgentEngineRun, type DispatchAgentEngineRunResult } from "./dispatch";

/**
 * Originally Task 1's "independent, observable steps" (T-B17/SCRUM-270):
 * dispatches `seo-geo-agent`/`intel-report-agent` through agent-engine's
 * Pub/Sub topic. Each dispatch is its own real `jobs` doc, visible in the
 * Jobs list independent of anything else onboarding is doing.
 *
 * SCRUM-274 (T-B19) — the cutover — changes what calling this function
 * MEANS, not its own body. Before the cutover, `runOnboardPipeline` called
 * this best-effort and fire-and-forget, purely for observability, alongside
 * (never instead of) its own hardcoded, in-process document generation — a
 * dispatch failure here was logged and swallowed, never blocking the real
 * pipeline. `runOnboardPipeline` is gone now (see `src/lib/intel/
 * agent-onboarding.ts` and this ticket's report). The one remaining caller
 * is `runAgentOnboardingForClient` (`agent-onboarding.ts`), which calls this
 * SYNCHRONOUSLY, AWAITS both dispatches, and is fatal on failure — these two
 * agent-engine runs are now the sole producers of the client's context
 * documents, not an observability side-channel next to a "real" pipeline
 * that no longer exists.
 *
 * One consequence worth being explicit about: `isAgentEngineDispatchEnabled()`
 * (`./dispatch.ts`) no longer gates this call anywhere on the onboarding
 * path — `runAgentOnboarding` calls `dispatchResearchAgents` unconditionally.
 * That flag's own doc comment describes it as "the one flag that turns on
 * agent-engine dispatch anywhere in this repo," which was true when this
 * function's only caller was the old fire-and-forget onboarding-observability
 * path; it is no longer true post-cutover. See this ticket's report for the
 * operational consequence (a client/environment without agent-engine
 * configured now fails onboarding outright, rather than silently degrading
 * to the deleted hardcoded pipeline).
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
