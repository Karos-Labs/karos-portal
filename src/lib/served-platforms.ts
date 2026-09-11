import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { platformForAgentIdentity } from "@/lib/content-platform";

/**
 * The channels an agent of a client's actually posts to, and the two rules
 * that follow from the list (pure, client-safe).
 *
 * WHY (Albert, 2026-09-11, of a "YouTube Shorts" proposal on his calendar):
 * "we are not doing YouTube agents. why is it there." The copilot's Scan &
 * Refresh proposed content for every CONNECTED channel — his YouTube was
 * connected for analytics — and its gap rules told it to fill a channel no
 * product posts to with "source content the team repurposes". Nothing here
 * makes anything for YouTube, so a task for it is a task nobody can execute,
 * which the prompt's own NEVER list already forbids. The list of channels is
 * now derived from the agents, and every writer of a proposal (the copilot's
 * create_tasks tool, the War Room's persist) and every reader that offers one
 * for approval (the calendar) asks it.
 *
 * DERIVED, NOT STORED. No custom agent carries a `platforms` descriptor today
 * (the manifest never wrote one), so the answer comes off the agent's identity
 * — the same `platformForAgentIdentity` every card and chip resolves its mark
 * from — plus the managed products' own lists. An explicit descriptor, when
 * one exists, is honoured too.
 *
 * INTEGRATION KEYS, because that is what a task's `platform`, an integration
 * row and the prompt's gap detection all speak: the X agent serves "twitter".
 */

/** Integration key for a mark id: the registry says "twitter" where the marks say "x". */
const INTEGRATION_KEY: Record<string, string> = { x: "twitter" };

function integrationKey(platform: string): string {
  const key = platform.toLowerCase();
  return INTEGRATION_KEY[key] ?? key;
}

export interface ServedAgentLike {
  key?: string | null;
  name: string;
  platforms?: readonly string[] | null;
}

export function servedPlatformKeys(
  agents: readonly ServedAgentLike[],
  products: readonly { platforms: readonly string[] }[] = MANAGED_PRODUCTS,
): Set<string> {
  const served = new Set<string>();
  for (const product of products) for (const platform of product.platforms) served.add(integrationKey(platform));
  for (const agent of agents) {
    for (const platform of agent.platforms ?? []) served.add(integrationKey(platform));
    const own = platformForAgentIdentity(agent.key ?? null, agent.name);
    if (own) served.add(integrationKey(own));
  }
  return served;
}

/** A task with no platform is about no channel in particular, and passes. */
export function isServedPlatform(platform: string | null | undefined, served: ReadonlySet<string>): boolean {
  return !platform || served.has(integrationKey(platform));
}

/**
 * Which proposals the channel rule applies to: content, and connecting a NEW
 * channel. Re-authenticating one the client already connected is neither — a
 * YouTube connected for analytics still needs its token renewed.
 */
export function proposalNeedsServedPlatform(task: { owner: string; title: string }): boolean {
  if (task.owner === "karos_managed") return true;
  return /\bconnect\b/i.test(task.title) && !/re-?auth/i.test(task.title);
}

/** What a skipped proposal leaves behind (client copy: the War Room prints it). */
export function unservedPlatformSkipNote(skipped: number): string {
  return `${skipped} not added: no agent of yours posts to that channel`;
}

/**
 * A title or description with every agent id replaced by the agent's name.
 *
 * The model is handed ids so it can fill the `agentId` field, and it wrote one
 * into prose: "2-3 short-form YouTube Shorts per week via Ji7p4nLTzDcbcKgDhtee".
 * The prompt now says not to; this is the guarantee. Short ids are left alone
 * so a name that happens to be a common word cannot be rewritten by accident.
 */
export function withoutAgentIds(text: string, agents: readonly { id: string; name: string }[]): string {
  let out = text;
  for (const agent of agents) {
    if (agent.id.length >= 12 && out.includes(agent.id)) out = out.split(agent.id).join(agent.name);
  }
  return out;
}
