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
 * Returns `undefined` — never a guess — when the task type is "custom"
 * (X/LinkedIn/Reddit/newsletter/blog custom agents, and Dynamic Agent
 * Studio specs: none of these map onto agent-engine's fixed workflow
 * catalog; they're portal/admin-authored specs agent-engine has no
 * mechanism to run) or when a "social_post" brief has no recognized
 * `platform`. Every caller must treat `undefined` as "stay on the legacy
 * agent-service path," not as an error.
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
