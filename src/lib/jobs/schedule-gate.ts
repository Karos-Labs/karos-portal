import "server-only";

/**
 * The one answer to "would this schedule refuse on every single fire?", asked
 * where a schedule is WRITTEN rather than only where it fires.
 *
 * Both submit cores (lib/jobs/submit-custom.ts and
 * lib/agent-service/run-custom-agent.ts) refuse some pairs before they write a
 * job row, which leaves no job, no failed status and no charge behind — so a
 * schedule created past one of those refusals is invisible: the card reads as
 * live and nothing ever arrives. This runs the same predicates the cores run, so
 * the two cannot disagree about which schedules can ever fire.
 *
 * Returns null when the schedule can fire. The copy is client-facing: the
 * always-on card on a client's AI agents page shows it verbatim.
 */

import { hasXAgentIntake, isXAgent } from "@/lib/agent-service/x-agent-context";
import { hasLinkedInAgentIntake, isLinkedInAgent } from "@/lib/agent-service/linkedin-agent-context";
import { hasRedditAgentIntake, isRedditAgent } from "@/lib/agent-service/reddit-agent-context";
import {
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  REDDIT_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  agentKeyMatchesClientSlug,
  perClientAgentSlug,
} from "@/lib/custom-agent-launch";
import type { Client, CustomAgent } from "@/lib/types";

export async function unfireableScheduleReason(
  client: Client,
  agent: CustomAgent,
): Promise<string | null> {
  // A per-client agent instance is baked under the one client folder its key
  // names. A staff calendar and the admin scheduled-runs card can both pair any
  // client with any agent, so a mismatched pair is reachable from there even
  // though a client's own agents page never lists one.
  if (!agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)) {
    return `${agent.name} runs only for the client whose lab repo slug is "${perClientAgentSlug(agent.key)}", and ${client.name}'s slug is ${client.agentsRepoSlug ? `"${client.agentsRepoSlug}"` : "not set"}. Use this client's own agent — the schedule stays off until then.`;
  }
  // The agents that draft FROM stored agent data (X e13, LinkedIn e10, Reddit
  // e15) need their company-level form saved. Unattended fires have no one to
  // answer it.
  //
  // Same copy as the submit cores' refusals except for the closing clause: this
  // one is answering "why is the schedule off", not "why did nothing run".
  if (isXAgent(agent.key) && !(await hasXAgentIntake(client.id))) {
    return `${X_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the company page form there. The schedule stays off until then.`;
  }
  // Keyed, like the cores: the Path-B master has no company form of its own and
  // gates on any LinkedIn intake, so passing the key is what keeps a
  // seat-only workspace able to schedule the master (ruling 6).
  if (isLinkedInAgent(agent.key) && !(await hasLinkedInAgentIntake(client.id, agent.key))) {
    return `${LINKEDIN_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the company page form there. The schedule stays off until then.`;
  }
  if (isRedditAgent(agent.key) && !(await hasRedditAgentIntake(client.id))) {
    return `${REDDIT_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the account form there. The schedule stays off until then.`;
  }
  return null;
}
