import "server-only";
import { isAgentEngineDispatchEnabled, isAgentEngineTransportConfigured } from "./dispatch";
import { resolveAgentEngineProductIdForCustomAgent } from "./product-mapping";

/**
 * Whether this client has at least one enabled custom agent that
 * `submit-custom.ts` would route to agent-engine right now — the exact
 * decision that function makes per run (`isAgentEngineDispatchEnabled() &&
 * client.agentsRepoSlug`, then per-agent
 * `resolveAgentEngineProductIdForCustomAgent`), asked once for a whole roster
 * instead of once per submitted job.
 *
 * ## No per-client allowlist any more (2026-09-06)
 *
 * Until this date a third condition sat between the two above:
 * `AGENT_ENGINE_CUSTOM_AGENT_CLIENTS`, a deploy-time list of `agentsRepoSlug`
 * values naming the clients "cut over" to the engine. It existed to protect
 * clients whose work still succeeded on agent-service. agent-service was
 * deleted on 2026-09-02, so the list stopped protecting anything and started
 * doing the opposite: every client not on it had their runs posted to a
 * service that no longer exists — a guaranteed 404 from the client view, which
 * is the defect that removed the list. A client enabled in the portal now
 * dispatches to the engine on the strength of having the agent granted and a
 * lab slug to run as; what the engine then needs per client (a channel
 * identity, a brand profile, a review roster) is the engine's own intake to
 * ask for, and it does, with a `blocked_intake` that names the missing piece.
 *
 * SCRUM-264: the point of asking this BEFORE a run is attempted is that a
 * client routed to agent-engine gets no warning of any kind when it is
 * unreachable — they find out only when a run they started fails.
 */
export function clientHasEngineRoutedCustomAgent(
  clientSlug: string | undefined,
  agentKeys: readonly string[],
): boolean {
  if (!isAgentEngineDispatchEnabled() || !clientSlug) {
    return false;
  }
  return agentKeys.some((key) => resolveAgentEngineProductIdForCustomAgent(key) !== undefined);
}

/**
 * Whether ONE specific custom agent, for one specific client, would actually
 * be routed to agent-engine on a run submitted RIGHT NOW — the exact
 * per-run gate `submit-custom.ts` applies before it ever creates a job doc
 * (`isAgentEngineDispatchEnabled() && client.agentsRepoSlug`, then
 * `resolveAgentEngineProductIdForCustomAgent(agent.key)`), returning the
 * resolved productId (or `undefined`, meaning "falls through to the legacy
 * agent-service path" — a path with nothing at the end of it since
 * 2026-09-02; see the note above).
 *
 * SCRUM-249 (T-B5) exists because of exactly the bug this function closes: a
 * prior version of the chat route decided whether a client's uploaded file
 * would be wired into a run by asking
 * `resolveAgentEngineProductIdForCustomAgent(agent.key)` ALONE — which
 * answers "does agent-engine have a workflow for this agent key at all",
 * independent of whether agent-engine dispatch is enabled or whether the
 * client has a lab slug to run as. The result was a client told "Attached ...
 * as source media for this run" for a run that never reached the engine.
 *
 * `submit-custom.ts` now calls this too instead of re-deriving the same
 * predicate inline, specifically so the two can never drift back apart: this
 * function IS the definition of "would actually dispatch to the engine", not
 * a description of it duplicated at a second call site.
 */
export function resolveDispatchedAgentEngineProductId(
  agentKey: string,
  clientSlug: string | undefined,
): string | undefined {
  if (!isAgentEngineDispatchEnabled() || !clientSlug) {
    return undefined;
  }
  return resolveAgentEngineProductIdForCustomAgent(agentKey);
}

/**
 * The engine counterpart to a page's `!isAgentServiceConfigured()` check:
 * true when this client's runs would be routed to agent-engine AND
 * agent-engine's dispatch transport is not currently configured — i.e.
 * every run `submit-custom.ts` would hand to the engine for this client
 * fails today, with nothing on screen saying so.
 *
 * False whenever the client is not cut over (nothing changes for them, so
 * nothing should warn them) and false whenever the transport IS configured
 * (the engine may still fail at runtime for other reasons — a bad workflow,
 * a downstream 500 — but that is not "unconfigured", and is not this
 * banner's job to predict).
 */
export function shouldShowEngineHealthBanner(
  clientSlug: string | undefined,
  agentKeys: readonly string[],
): boolean {
  return clientHasEngineRoutedCustomAgent(clientSlug, agentKeys) && !isAgentEngineTransportConfigured();
}
