import "server-only";

/**
 * "Does agent-engine own SETUP for this agent and this client?"
 *
 * ── WHY THE QUESTION EXISTS ───────────────────────────────────────────────
 *
 * Several portal surfaces refuse a writer run until a one-time stand-up has
 * happened, and they answer that question by reading a state row:
 * `liAgentState` "foundation", `seatVoiceProfiles`, `newsletterAgentState`
 * "issue-index", `blogAgentState` "post-index". Every one of those rows was
 * written by the agent-service webhook — and agent-service was deleted on
 * 2026-09-02. On the engine path nothing writes them, nothing ever will, and
 * a gate that waits for one waits forever: the client is told to press "Set it
 * up" for a row the press cannot produce.
 *
 * The engine does not need them. Each channel's setup is inlined into the
 * drafting workflow as its own pre-flight — `00-channel-setup` for LinkedIn
 * and Reddit, `00-roster-setup` for reputation (see the routing notes in
 * product-mapping.ts) — so a run carries the client's filled form, the
 * workflow records what the channel is missing and then drafts. Setup and the
 * first post are one run, and there is nothing for the portal to ask for
 * first.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * Not a blanket "skip the gates". The portal-written INTAKE gates
 * (`hasLinkedInAgentIntake`, `hasNewsletterAgentIntake`, …) stay exactly where
 * they are on both paths: the form is what the engine's pre-flight resolves
 * FROM, so a run with no form is the one run that genuinely has nothing to
 * work with. Only the stand-up rungs — the ones asking for state the engine
 * builds itself — are answered by this.
 *
 * ── HOW IT IS RESOLVED ────────────────────────────────────────────────────
 *
 * Through `resolveDispatchedAgentEngineProductId`, the same three-part gate
 * (`isAgentEngineDispatchEnabled()`, the client's lab slug, the per-agent map)
 * that `submit-custom.ts` resolves once per run as `engineProductId` and
 * branches the reputation agent on. Asked that way, a surface can never call
 * setup "handled" for a client whose run would in fact go somewhere else: a
 * client with no `agentsRepoSlug` is gated exactly as before, because their
 * run does not reach the engine either.
 */

import { getClient } from "@/lib/data";
import { resolveDispatchedAgentEngineProductId } from "@/lib/agent-engine/health";

/**
 * The question asked with the client's lab slug already in hand — the form
 * every caller that holds a `Client` should use (schedule-gate.ts), and the
 * definition the async twin below delegates to.
 */
export function engineOwnsSetup(agentKey: string, clientSlug: string | undefined): boolean {
  return resolveDispatchedAgentEngineProductId(agentKey, clientSlug) !== undefined;
}

/**
 * The same question for a caller that holds only a client id — the readiness
 * builders (client-agent-rows.ts, agent-intake-views.ts), which are handed one
 * and read everything else themselves.
 *
 * `getClient` is `cache()`-wrapped, so asking it once per agent on a roster
 * costs one read per request, not one per card.
 */
export async function engineOwnsSetupForClient(clientId: string, agentKey: string): Promise<boolean> {
  const client = await getClient(clientId);
  return engineOwnsSetup(agentKey, client?.agentsRepoSlug);
}
