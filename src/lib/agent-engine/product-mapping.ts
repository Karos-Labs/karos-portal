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
 * The map is exact rather than a prefix match, and that is the important part.
 * A setup agent and a drafting agent for the same channel share a name prefix
 * and do entirely different work, so a `startsWith("karos-linkedin")` shortcut
 * would feed an onboarding form into a post-drafting workflow. Each pairing is
 * written out because each was checked.
 *
 * `karos-linkedin-manager-v2` is deliberately still absent: it runs on two
 * clocks and rewrites the generators' inputs, and agent-engine has neither a
 * scheduler nor a write path for that. It stays on agent-service until it does.
 *
 * Everything absent from this map stays on agent-service, which is still the
 * executor for the overwhelming majority of production jobs. This is a
 * per-agent cutover, not a switch.
 */
const ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY: Readonly<Record<string, string>> = {
  "karos-x-agent-v2": "x-agent",
  "karos-linkedin-writer-v2": "linkedin-agent",
  "karos-reddit-runner": "reddit-agent",
  // Onboarding, now that agent-engine has workflows for them. They record a
  // filled form as the charter the drafting agents above read, so a client
  // set up here is a client those agents can then run for.
  //
  // The manager variants stay absent on purpose: karos-linkedin-manager-v2
  // runs on two clocks and rewrites the generators' inputs, and agent-engine
  // has neither a scheduler nor a write path for that.
  "karos-linkedin-setup-v2": "linkedin-setup-agent",
  "karos-reddit-setup": "reddit-setup-agent",
  // Three more whose engine workflows already exist.
  //
  // instagram-agent and branded-shorts-agent route correctly but cannot
  // finish yet: the first holds at image vetting until UNSPLASH_ACCESS_KEY is
  // provisioned, and the second needs BRANDED_SHORTS_ENGINE_DIR for its video
  // tools. Both fail honestly rather than wrongly, and the per-client gate
  // means neither routes for any client until someone opts that client in --
  // so this is the mapping landing ahead of the prerequisites, not instead of
  // them.
  "karos-instagram-agent": "instagram-agent",
  "landing-builder": "landing-builder-agent",
  "branded-shorts": "branded-shorts-agent",
  //
  // karos-tiktok-agent is deliberately NOT here. There is no `tiktok-agent`
  // product id -- mapping to one would make every TikTok job fail on an
  // unresolvable product instead of running where it works today. And it is
  // not branded-shorts wearing another name: branded-shorts is e18, one
  // talking-head video into one vertical short, while the TikTok agent is the
  // podcast/commentary CLIP system. Pointing it at branded-shorts-agent would
  // quietly run a different product for the client. It needs its own
  // workflow.
};

export function resolveAgentEngineProductIdForCustomAgent(agentKey: string): string | undefined {
  return ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY[agentKey];
}

/**
 * Which `runKind` a dispatch to this product should carry.
 *
 * `"recurring"` for everything, with one exception that is not cosmetic:
 * `landing-builder-agent` treats `runKind === "recurring"` as MODE=rebuild —
 * "apply the one feedback delta" — and its own doc comment says so outright.
 * A rebuild needs a `feedback-round.json` for the next round number, and if
 * one isn't in the bundle the run resolves to `blocked_intake`.
 *
 * This portal has no feedback-round concept anywhere in it, so the only thing
 * a landing-page job here can possibly mean is a fresh build. Sending
 * `"recurring"` meant every landing job blocked on a feedback round that
 * nothing in this codebase can produce — and because the first build never
 * happened, no later run could ever have a prior site to rebuild either.
 * Verified both directions against prep: the same brief blocks as
 * `"recurring"` and proceeds to the copy/compose stages as `"setup"`.
 *
 * Only `landing-builder-agent` and `seo-geo-agent` branch on `runKind` engine-
 * side at all, and seo-geo is not reachable from either submit path, so this
 * changes nothing else.
 *
 * When the portal grows a real "here is my feedback on round N" surface, this
 * is the function that should start returning `"recurring"` for it.
 */
export function resolveAgentEngineRunKind(productId: string): "setup" | "recurring" {
  return productId === "landing-builder-agent" ? "setup" : "recurring";
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

/**
 * Which clients may have their custom-agent jobs routed to agent-engine.
 *
 * Per-agent routing alone is not enough to cut over safely, and production
 * shows why: all seven clients are granted the X agent, but only one has an
 * `xHandle` in the engine's workspace store. Routing on the agent key alone
 * would send six clients' X jobs to `blocked_intake` — work that succeeds on
 * agent-service today.
 *
 * `AGENT_ENGINE_CUSTOM_AGENT_CLIENTS` is a comma-separated list of
 * `agentsRepoSlug` values, or `*` for all. Unset means NOBODY, so deploying
 * this code changes nothing until someone names a client — which is what lets
 * the build ship to production ahead of the cutover decision.
 *
 * A client is added once its engine-side context is in place and one real run
 * has been verified. That is the unit of this drain: not "the X agent is
 * migrated" but "this client's X agent is migrated".
 */
export function isClientEnabledForEngineCustomAgents(
  clientSlug: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!clientSlug) return false;
  const raw = env.AGENT_ENGINE_CUSTOM_AGENT_CLIENTS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(clientSlug);
}
