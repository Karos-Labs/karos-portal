import type { ManagedTaskType } from "@/lib/types";

/**
 * Maps one of karosCMO's "managed" catalog task types onto agent-engine's
 * own fixed `productId` enum (`apps/agent-server/src/wiring/workflows.ts`'s
 * `KNOWN_PRODUCT_IDS`) — the only two directions this repo can currently
 * dispatch through agent-engine at all:
 *
 *   - "landing_page" is a direct 1:1 match: agent-engine's
 *     `landing-builder-agent`.
 *   - "social_post" is Instagram-or-TikTok (`MANAGED_TASK_LABELS`'s own
 *     "Social posts (IG/TikTok)" in `src/lib/jobs/submit-managed.ts`) and
 *     needs `brief.platform` (set by `execution-engine.ts`'s own
 *     "instagram" vs "tiktok" keyword match) to know which: `"instagram"` →
 *     `instagram-agent`, `"tiktok"` → `branded-shorts-agent`.
 *
 * Returns `undefined` — never a guess — for `"custom"` (see
 * `resolveAgentEngineProductIdForCustomAgent` below, which routes the three
 * custom agents agent-engine now has real workflows for) or when a
 * "social_post" brief has no recognized `platform`. Every caller must treat
 * `undefined` as "stay on the legacy agent-service path," not as an error.
 */
export function resolveAgentEngineProductId(taskType: ManagedTaskType, brief: Record<string, unknown>): string | undefined {
  if (taskType === "landing_page") {
    return "landing-builder-agent";
  }
  if (taskType === "social_post") {
    const platform = typeof brief.platform === "string" ? brief.platform.toLowerCase() : undefined;
    if (platform === "instagram") return "instagram-agent";
    if (platform === "tiktok") return "branded-shorts-agent";
    return undefined;
  }
  return undefined;
}

/**
 * The custom-agent half of the cutover: which `customAgents.key` values now
 * have a real agent-engine workflow behind them.
 *
 * Keyed on the agent's stable `key` rather than its display name, because the
 * name is admin-editable and a rename must not silently reroute a client's
 * traffic to a different execution engine.
 *
 * Only the three DRAFTING agents are listed. The lab repo also ships
 * setup and manager variants (`karos-linkedin-setup-v2`,
 * `karos-linkedin-manager-v2`, `karos-reddit-setup`, ...) and those are
 * different products doing different work — onboarding interviews, account
 * management — that agent-engine has no workflow for. Routing them by a
 * `startsWith("karos-linkedin")` shortcut would send an onboarding interview
 * into a post-drafting workflow, so the map is exact and explicit.
 *
 * Everything absent from this map stays on agent-service, which is still the
 * executor for the overwhelming majority of production jobs. This is a
 * per-agent cutover, not a switch.
 */
const ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY: Readonly<Record<string, string>> = {
  "karos-x-agent-v2": "x-agent",
  "karos-linkedin-writer-v2": "linkedin-agent",
  "karos-reddit-runner": "reddit-agent",
};

export function resolveAgentEngineProductIdForCustomAgent(agentKey: string): string | undefined {
  return ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY[agentKey];
}

/**
 * The subset of a custom agent's brief that agent-engine understands as a
 * per-run request (`WorkflowContext.input`).
 *
 * Allow-listed rather than passed through wholesale for two reasons. The
 * engine's workflows overlay these onto the client's standing config, so an
 * unrecognized key would be carried into a run and silently ignored — looking
 * honoured without being. And a brief is user input: forwarding it verbatim
 * would let a form field named `targetSubreddits` or `xHandle` reach a place
 * where the engine reads client identity.
 *
 * `request` is the portal's own primary brief field on every launch profile
 * that has one (generic, X, LinkedIn, Reddit — see `submit-custom.ts`'s
 * `runLabel`), and it becomes the run's requested topic.
 */
export function toEngineRunInput(briefValues: Record<string, string> | undefined): Record<string, string> {
  if (!briefValues) return {};

  const input: Record<string, string> = {};
  const request = briefValues["request"]?.trim();
  if (request) input.requestedTopic = request;

  for (const key of ["requestedLane", "requestedArchetype", "requestedSubreddit", "requestedThreadUrl", "requestedThreadTitle"] as const) {
    const value = briefValues[key]?.trim();
    if (value) input[key] = value;
  }
  return input;
}
