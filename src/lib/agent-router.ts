/**
 * Capability-aware agent routing for the copilot chat's `run_agent_now` tool
 * (T-B7/SCRUM-251).
 *
 * BEFORE THIS FILE: the tool decided whether to dispatch a run with one line —
 * `customAgents.find((a) => a.name.toLowerCase().includes(q))` — a literal
 * substring test against the agent's name, with no regard for whether the
 * matched agent could actually produce what was asked, and no check that the
 * run had the inputs it needed to start. `routeAgentRun` below is the single
 * decision point that replaces it, run in this order:
 *
 *   1. NAME RESOLUTION — find the one agent `agentQuery` names. Normalized
 *      EXACT equality (trim + lowercase + collapse whitespace), never a raw
 *      substring test: a substring match can silently pick the wrong agent
 *      (or the right one for the wrong reason) and there is no capability
 *      check downstream of a name-only match to catch that — the whole
 *      premise of this ticket. The catalog block the model reads (built by
 *      `buildProactiveSystemAppendix`) always bolds each agent's exact name,
 *      so the model has the literal string to pass back.
 *   2. CAPABILITY GATE — when the caller names a specific C4 capability tag
 *      the request needs (`requestedCapability`), refuse the run unless the
 *      matched agent's own `capabilities` declares it. Two DIFFERENT refusal
 *      outcomes here, not one, because they mean different things operationally:
 *        - `capabilities: []` (T-B6's honest "not yet described" state, per its
 *          own report — the S-A16/SCRUM-230 data-population pass hasn't landed,
 *          so every custom agent in this repo reads this way today) → the agent
 *          is NOT ROUTABLE by capability at all; we cannot confirm OR deny it
 *          can do the work, so this is a "not yet configured" message, not a
 *          "can't do this" message.
 *        - `capabilities` non-empty but missing the requested tag → the agent
 *          HAS been described, and what it does genuinely does not cover the
 *          request → a "refused, here's what it can do instead" message.
 *      Never fall back to running the name-matched agent anyway in either case.
 *   3. PLATFORM GATE — same shape as the capability gate, but permissive by
 *      default per the field's own contract (`platforms` absent/empty means
 *      platform-agnostic, not "not yet described" — see `ManagedProduct` and
 *      `CustomAgent`'s doc comments): only refuses when the agent DOES declare
 *      a platform list and the requested platform isn't on it.
 *   4. REQUIRED-INPUT CHECK — once an agent is confirmed capable, verify every
 *      key in its `requiredInputs` is present in the caller's `briefValues`
 *      before green-lighting the run. Ask for what's missing rather than
 *      dispatching a run with holes in the input.
 *
 * `consumesMedia` is deliberately NOT turned into a fifth gate here — see the
 * finding in the T-B7 report: the chat route already has a media-capability
 * check (`agentEngineProductAcceptsMediaAssets` /
 * `resolveDispatchedAgentEngineProductId`) that reads the actual agent-engine
 * wiring for the run about to be submitted, which is a more precise signal
 * than an admin-set descriptor field that is null on every custom agent this
 * repo has today. Folding an always-null field into a blocking gate here would
 * refuse nothing in practice while adding a second, potentially-conflicting
 * source of truth for the same question.
 */
import type { ClientCustomAgentSummary } from "@/lib/agent-roster";
import type { CapabilityTag } from "@/lib/agent-service/products";

export type { CapabilityTag };

export interface RouteAgentRunInput {
  /** The agent name text the model extracted from the user's request. */
  agentQuery: string;
  /**
   * Set only when the request clearly asks for one specific C4 deliverable
   * kind (e.g. "make me a video"). Omitted for a generic run request — the
   * capability gate only ever applies when this is set.
   */
  requestedCapability?: CapabilityTag;
  /** Canonical platform key, when the request names a specific target platform. */
  requestedPlatform?: string;
  /** Brief field values supplied so far, keyed by field name. */
  briefValues?: Record<string, string>;
}

export type RouteAgentRunRefusalKind =
  | "not_found"
  | "not_routable"
  | "capability_mismatch"
  | "platform_mismatch"
  | "missing_inputs";

export type RouteAgentRunOutcome =
  | { ok: true; agent: ClientCustomAgentSummary }
  | { ok: false; kind: RouteAgentRunRefusalKind; reason: string };

function normalizeAgentName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * "produce_video" -> "video", "produce_webpage" -> "webpage". Generic on
 * purpose (strips the fixed `produce_` prefix and un-snakes the rest) so a
 * future tag added to `CAPABILITY_TAGS` reads sensibly here with no mapping
 * table to keep in sync — matching the taxonomy's own "open-ended" note in
 * `agent-service/products.ts`.
 */
function humanizeCapability(tag: string): string {
  return tag.replace(/^produce_/, "").replace(/_/g, " ");
}

/** Name resolution alone (step 1) — exported so callers/tests can probe it in isolation. */
export function resolveAgentByName(
  agents: ClientCustomAgentSummary[],
  agentQuery: string,
): ClientCustomAgentSummary | undefined {
  const q = normalizeAgentName(agentQuery);
  return agents.find((a) => normalizeAgentName(a.name) === q);
}

/** The full four-step decision described above. */
export function routeAgentRun(
  agents: ClientCustomAgentSummary[],
  input: RouteAgentRunInput,
): RouteAgentRunOutcome {
  const match = resolveAgentByName(agents, input.agentQuery);
  if (!match) {
    return {
      ok: false,
      kind: "not_found",
      reason:
        agents.length > 0
          ? `I couldn't match "${input.agentQuery}" to one of this client's agents. Available: ${agents.map((a) => a.name).join(", ")}.`
          : "This client has no AI agents assigned yet.",
    };
  }

  if (input.requestedCapability) {
    const capabilities = match.capabilities ?? [];
    if (capabilities.length === 0) {
      return {
        ok: false,
        kind: "not_routable",
        reason:
          `**${match.name}** doesn't have its capabilities configured yet, so I can't confirm it can produce ` +
          `${humanizeCapability(input.requestedCapability)}. Ask your Karos team to set that up, or tell me a different agent to use.`,
      };
    }
    if (!capabilities.includes(input.requestedCapability)) {
      return {
        ok: false,
        kind: "capability_mismatch",
        reason:
          `**${match.name}** isn't set up to produce ${humanizeCapability(input.requestedCapability)} — it's set up for: ` +
          `${capabilities.map(humanizeCapability).join(", ")}. Pick an agent with that capability instead.`,
      };
    }
  }

  if (input.requestedPlatform) {
    const platforms = match.platforms ?? [];
    // Permissive by design when empty: absent/empty `platforms` means
    // platform-agnostic (per the field's own contract), not "not yet
    // described" — unlike `capabilities` above, an empty list here is never a
    // refusal on its own.
    if (platforms.length > 0 && !platforms.includes(input.requestedPlatform)) {
      return {
        ok: false,
        kind: "platform_mismatch",
        reason:
          `**${match.name}** isn't set up for ${input.requestedPlatform} — it targets: ${platforms.join(", ")}.`,
      };
    }
  }

  const required = match.requiredInputs ?? [];
  if (required.length > 0) {
    const provided = new Set(Object.keys(input.briefValues ?? {}));
    const missing = required.filter((key) => !provided.has(key));
    if (missing.length > 0) {
      return {
        ok: false,
        kind: "missing_inputs",
        reason: `Before I can run **${match.name}**, I need: ${missing.join(", ")}. Give me those and I'll start the run.`,
      };
    }
  }

  return { ok: true, agent: match };
}
