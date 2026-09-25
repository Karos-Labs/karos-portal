import "server-only";

import { renderFeedbackMarkdown } from "@/lib/client-agent-feedback";
import { getClientAgentByKey, listClientAgentFeedback } from "@/lib/data-client-agents";

/**
 * The client's standing feedback about an agent, for an ENGINE run.
 *
 * The same two-level feedback (global direction, then per-template notes) and
 * the same rendering the legacy path attaches as a context file
 * (`buildClientAgentFeedbackFiles`), sent instead as the `standingFeedback`
 * run input. The engine path never sent context files, so until this an
 * engine-routed agent (every Instagram, TikTok and X run today) never saw a
 * word of it. The engine hands it to every drafting step as
 * `clientStandingFeedback`, beside the run's direction and never inside it.
 *
 * Same rules as the legacy attachment: only a LIVE umbrella, never a launch
 * run (a setup run is what creates the templates), active rows only (resolved
 * and withdrawn ones stop being sent the moment they change), and resolved by
 * the agent's stable key so an umbrella bound before a lab re-import keeps
 * working. Best-effort: a read that fails costs the run its feedback, never
 * the run itself.
 */
export async function standingFeedbackForEngineRun(input: {
  clientId: string;
  agentKey: string;
  runType?: string;
}): Promise<string | undefined> {
  if (input.runType === "launch") return undefined;
  try {
    const umbrella = await getClientAgentByKey(input.clientId, input.agentKey);
    if (umbrella?.launchState !== "live") return undefined;
    const rows = await listClientAgentFeedback({ clientAgentId: umbrella.id, status: "active" });
    const markdown = renderFeedbackMarkdown({ agentName: umbrella.displayName, rows, templates: umbrella.templates });
    return markdown ?? undefined;
  } catch (e) {
    console.error("[agent-engine] reading client-agent standing feedback failed:", e);
    return undefined;
  }
}
