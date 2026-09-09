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
import {
  hasLinkedInAgentIntake,
  hasLinkedInV2Setup,
  isLinkedInAgent,
  isLinkedInSetupV2,
  isLinkedInV2Agent,
} from "@/lib/agent-service/linkedin-agent-context";
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
  // The v2 STAND-UP rung, which this gate was missing while both cores enforced
  // it (submit-custom.ts and run-custom-agent.ts refuse on hasLinkedInV2Setup).
  // That is exactly the invisible schedule this module exists to prevent: the
  // row passed the gate, the card read as live, and every single fire was turned
  // away before a job row existed — no failed status, no charge, nothing to see.
  //
  // V2 keys only, matching the cores: the e10 generation has no stand-up run.
  //
  // AND THE SETUP SKILL IS EXEMPT, which is the whole point of it — it is the run
  // that CREATES the foundation row. Both cores carry this exemption
  // (submit-custom.ts's `!isLinkedInSetupV2(agent.key) &&` and
  // run-custom-agent.ts's `&& !isLinkedInSetupV2(agent.key)`); without it this
  // gate is stricter than the thing it mirrors and refuses the only run that can
  // ever satisfy it — so a paused setup schedule could never be resumed, and a
  // new one could only be created once it was no longer needed.
  if (
    isLinkedInV2Agent(agent.key) &&
    !isLinkedInSetupV2(agent.key) &&
    !(await hasLinkedInV2Setup(client.id))
  ) {
    return `${LINKEDIN_SETUP_REQUIRED_PREFIX} first. This agent has not been set up for ${client.name} yet. Press "Set it up" on the LinkedIn agent card, which stands up the lanes, the voice and the first topics. The schedule stays off until then.`;
  }
  if (isRedditAgent(agent.key) && !(await hasRedditAgentIntake(client.id))) {
    return `${REDDIT_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the account form there. The schedule stays off until then.`;
  }
  return null;
}
