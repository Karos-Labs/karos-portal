import "server-only";
import { isAgentEngineDispatchEnabled, isAgentEngineTransportConfigured } from "./dispatch";
import {
  isClientEnabledForEngineCustomAgents,
  resolveAgentEngineProductIdForCustomAgent,
} from "./product-mapping";

/**
 * Whether this client has at least one enabled custom agent that
 * `submit-custom.ts` would route to agent-engine right now — the exact
 * three-part decision that function makes per run (`isAgentEngineDispatchEnabled()
 * && client.agentsRepoSlug && isClientEnabledForEngineCustomAgents(...)`,
 * then per-agent `resolveAgentEngineProductIdForCustomAgent`), asked once for
 * a whole roster instead of once per submitted job.
 *
 * SCRUM-264: the point of asking this BEFORE a run is attempted is that a
 * client cut over to agent-engine currently gets no warning of any kind when
 * it is unreachable — they find out only when a run they started fails.
 */
export function clientHasEngineRoutedCustomAgent(
  clientSlug: string | undefined,
  agentKeys: readonly string[],
): boolean {
  if (!isAgentEngineDispatchEnabled() || !isClientEnabledForEngineCustomAgents(clientSlug)) {
    return false;
  }
  return agentKeys.some((key) => resolveAgentEngineProductIdForCustomAgent(key) !== undefined);
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
