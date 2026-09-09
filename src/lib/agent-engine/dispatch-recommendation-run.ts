import "server-only";
import type { Client } from "@/lib/types";
import { dispatchAgentEngineRun, type DispatchAgentEngineRunResult } from "./dispatch";
import { isKnownEngineProductId } from "./product-mapping";
import type { RoutableRecommendation } from "./routable-recommendation";

/**
 * [SCRUM-260/T-B15, D2/SCRUM-278] "The split" — what the system runs
 * automatically once a client approves a recommendation.
 *
 * PRODUCTION-READINESS CAVEAT (do not remove this gate without re-reading
 * the ticket). T-A2/SCRUM-236 and T-A3/SCRUM-237 — the agent-engine work
 * that makes `seo-geo-agent` actually emit real, non-fabricated `owner`/
 * `fixAction`/`engineProductId` classification on a fired recommendation —
 * exist ONLY as an unmerged branch in agent-engine's own repo as of this
 * writing (2026-08-30). They have not landed in that repo's production, so
 * this module's dispatch must default to OFF in every environment this repo
 * ships to, regardless of whether the general `AGENT_ENGINE_DISPATCH_ENABLED`
 * switch (`./dispatch.ts`) happens to be on for unrelated agent-engine
 * features (e.g. control-plane agents, `control-plane-actions.ts`) — this is
 * a DELIBERATELY SEPARATE flag from that one, not an alias for it, precisely
 * so flipping the general switch can never silently also turn this on before
 * T-A2/T-A3 ship for real and the recommendations this reads stop being
 * fabricated. Same "read `process.env.X === 'true'` at call time" convention
 * `isAgentEngineDispatchEnabled()`/`isMiddlewareDispatchEnabled()`/
 * `isAgentEnginePubSubConfigured()` already use in this exact neighborhood —
 * no config object, no build-time constant, so an environment can flip it
 * without a redeploy once it is actually safe to.
 */
export function isSeoGeoRecommendationRunDispatchEnabled(): boolean {
  return process.env.SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED === "true";
}

/**
 * one_click vs review_approve — both `owner: "karos_agent"`, but NOT the same
 * trigger (this is the one distinction the ticket's own scope note flags as
 * undecided and asks this module to settle explicitly):
 *
 *   - "one_click": the catalog's own contract is that the fix is already
 *     machine-appliable and the human's one click IS the whole review — RFC-09
 *     §3's "never silently goes live" is satisfied by the approval click
 *     itself. So approving fires a run in `"apply"` mode: ship the fix.
 *   - "review_approve": still karos_agent, but the catalog is telling us the
 *     human needs to review the AGENT'S draft before anything ships — the
 *     approval click authorizes the agent to go produce that draft, not to
 *     publish it. So approving fires a run in `"draft"` mode: produce
 *     something a human reviews next, never a final-shipping run.
 *
 * Firing the SAME "apply" run for both would make `review_approve` a no-op
 * label — the whole reason C2 has two `ActionKind`s here instead of one.
 */
export type SeoGeoRecommendationRunMode = "apply" | "draft";

export function seoGeoRecommendationRunMode(
  actionKind: RoutableRecommendation["actionKind"],
): SeoGeoRecommendationRunMode {
  return actionKind === "one_click" ? "apply" : "draft";
}

export type SeoGeoRecommendationRunOutcome =
  | { dispatched: true; mode: SeoGeoRecommendationRunMode; result: DispatchAgentEngineRunResult }
  | { dispatched: false; reason: string };

/**
 * Decide whether approving `rec` should trigger a real agent-engine run, and
 * do it if so. THE DISPATCH RULE, per C2/RFC-09 and this ticket's own scope
 * (`owner`/`actionKind` are the classification authority, never `recId`):
 *
 *   - `owner: "karos_agent"` (`one_click` or `review_approve`) — "the system
 *     runs it automatically", gated on the flag above. This is the ONLY
 *     branch that ever calls `dispatchAgentEngineRun`.
 *   - `owner: "karos_tool"` — "a tool runs it". No separate lightweight
 *     "run a tool" primitive exists in this repo today (checked `dispatch.ts`
 *     and `submit-managed.ts` directly): every dispatch path in this repo
 *     goes through `dispatchAgentEngineRun`, a full agent-engine run. Routing
 *     a `karos_tool` record through that same primitive would misrepresent
 *     "a connector needs linking" as "a run is in flight" on the client's
 *     job list. So concretely, in THIS repo, "a tool runs it" means: no
 *     dispatch here — the task T-B14's converter already created
 *     (`owner: "client_managed"`, `metadata.type: "integration_action"`,
 *     `completionTrigger: "integration_connected:<platform>"`) is the whole
 *     mechanism, and it runs once a human/ops process (or, once one exists,
 *     an actual tool runner) completes that connection.
 *
 *     SCRUM-392 (ratified 2026-09-01) checked the obvious candidate for that
 *     tool runner — agent-engine's T-A17/`dispatchSeoFix` — and found it does
 *     not satisfy `karos_tool` end to end (artifact-only, no persistence, no
 *     apply step, and it treats `karos_tool` identically to `client_manual`
 *     by its own design). This finding — originally just this module's own
 *     observation — is now the project's ratified answer, not a local guess:
 *     see `rec-owner-run-status.ts` for the full record and the test that
 *     pins it. Building a real tool-runner primitive is still out of scope
 *     here.
 *   - `owner: "client_manual"` — always the client's own action. Never
 *     dispatches anything, flag or no flag.
 */
export async function dispatchSeoGeoRecommendationRun(
  rec: RoutableRecommendation,
  client: Pick<Client, "id" | "name" | "agentsRepoSlug">,
  createdBy: string,
): Promise<SeoGeoRecommendationRunOutcome> {
  if (rec.owner !== "karos_agent") {
    return {
      dispatched: false,
      reason: `owner "${rec.owner}" is not karos_agent — approving this category never triggers a run here`,
    };
  }

  if (!isSeoGeoRecommendationRunDispatchEnabled()) {
    return {
      dispatched: false,
      reason:
        "SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED is not set — run dispatch on approval stays off " +
        "until T-A2/T-A3 land in production and seo-geo-agent emits real classification",
    };
  }

  // Rule 3, read again defensively at this third boundary (routable-recommendation.ts
  // and routable-recommendation-tasks.ts each re-check this once already): a
  // karos_agent record is only ever routable when `engineProductId` is a
  // verified, known engine product. Never trust it just because `owner` says so.
  if (!isKnownEngineProductId(rec.engineProductId)) {
    return {
      dispatched: false,
      reason: `karos_agent record "${rec.recId}" carries no verified engineProductId — cannot dispatch`,
    };
  }

  if (!client.agentsRepoSlug) {
    return {
      dispatched: false,
      reason: `${client.name} has no agentsRepoSlug configured, which agent-engine resolves its workspace against`,
    };
  }

  const mode = seoGeoRecommendationRunMode(rec.actionKind);

  const result = await dispatchAgentEngineRun({
    clientId: client.id,
    clientSlug: client.agentsRepoSlug,
    productId: rec.engineProductId,
    runKind: "recurring",
    agentName: "SEO/GEO Recommendation Fix (Agent Engine)",
    title: `[Agent Engine] ${mode === "apply" ? "Apply" : "Draft"} fix ${rec.recId} — ${client.name}`,
    inputs: { recId: rec.recId, fixAction: rec.fixAction, mode },
    createdBy,
  });

  return { dispatched: true, mode, result };
}
