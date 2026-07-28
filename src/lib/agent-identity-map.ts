/**
 * ONE identity for a piece of content, wherever it is rendered (F147).
 *
 * The same Instagram work used to arrive at a client under two names in the
 * same day: the run row said "Instagram Agent" (the custom agent that fired)
 * while the calendar post said "Social posts (IG/TikTok)" (the managed-product
 * label derived from the asset), and a client reasonably read that as two
 * agents doing the same job twice. The cause was per-surface label maps, so
 * the fix is one resolver every surface imports — the JOB_STATUS_META
 * precedent — not a better map per surface.
 *
 * PURE and client-safe: no data layer, no server-only imports. Callers hand it
 * whatever they hold (a job, an asset, a schedule row) plus the client's
 * umbrella agents, and get back a single label + the umbrella it belongs to.
 */

import type { Asset, ClientAgent, Job, PlannedScheduledRun } from "@/lib/types";
import { agentLabelForAsset, chainFamilyFor } from "@/lib/post-chain";

/** What the resolver needs to know about a client's umbrella agents. */
export type ClientAgentIdentity = Pick<
  ClientAgent,
  "id" | "agentKey" | "customAgentId" | "displayName" | "platform" | "chainFamily" | "launchState"
>;

export interface ContentIdentityInput {
  job?: Pick<Job, "clientAgentId" | "customAgentId" | "agentName"> | null;
  asset?: Pick<Asset, "agentId" | "meta" | "type" | "templateKey" | "templateName"> | null;
  scheduledRun?: Pick<PlannedScheduledRun, "clientAgentId" | "customAgentId" | "agentName"> | null;
  /** A slot's umbrella, when the surface already knows it (calendar day cards). */
  clientAgentId?: string | null;
}

export interface ContentIdentity {
  /** The umbrella this content belongs to, when one could be resolved. */
  clientAgentId?: string;
  /** The ONE name to render. Never empty. */
  label: string;
  /** Platform id for the mark ("instagram" | "x" | …), when known. */
  platform?: string;
}

function byId(agents: ClientAgentIdentity[]): Map<string, ClientAgentIdentity> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

function identityOf(agent: ClientAgentIdentity): ContentIdentity {
  return {
    clientAgentId: agent.id,
    label: agent.displayName,
    ...(agent.platform ? { platform: agent.platform } : {}),
  };
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Resolve the single identity for a run / asset / schedule row.
 *
 * Rules, in order — the first that answers wins:
 *   1. an explicit umbrella link (slot, job, or schedule row);
 *   2. the job's / schedule's custom agent → its umbrella for this client;
 *   3. the asset's content family → the client's live umbrella that OWNS that
 *      family. This is the rung that kills the double identity: a social post
 *      produced before umbrellas existed carries no agent link at all, and
 *      without this it would keep rendering the managed-product label beside
 *      the umbrella's own name;
 *   4. today's fallback labels (agentLabelForAsset / the job's agent name),
 *      so nothing that renders today starts rendering blank.
 */
export function resolveContentIdentity(
  input: ContentIdentityInput,
  clientAgents: ClientAgentIdentity[],
): ContentIdentity {
  const agentsById = byId(clientAgents);

  const linkedId = input.clientAgentId ?? input.job?.clientAgentId ?? input.scheduledRun?.clientAgentId;
  if (linkedId) {
    const linked = agentsById.get(linkedId);
    if (linked) return identityOf(linked);
  }

  const customAgentId = input.job?.customAgentId ?? input.scheduledRun?.customAgentId;
  if (customAgentId) {
    const bound = clientAgents.find((agent) => agent.customAgentId === customAgentId);
    if (bound) return identityOf(bound);
  }

  if (input.asset) {
    const family = chainFamilyFor(input.asset.type);
    // A managed taskType is the other spelling of the same family — an older
    // social_post asset and a new one must not resolve differently.
    const taskType = metaString(input.asset.meta, "taskType");
    const impliedFamily =
      family ??
      (taskType === "social_post"
        ? "social"
        : taskType === "newsletter_issue"
          ? "email"
          : taskType === "blog_article"
            ? "article"
            : null);
    if (impliedFamily) {
      const owner = clientAgents.find(
        (agent) => agent.chainFamily === impliedFamily && agent.launchState === "live",
      );
      if (owner) return identityOf(owner);
    }
    const label = agentLabelForAsset(input.asset);
    if (label) return { label };
  }

  const fallback = input.job?.agentName ?? input.scheduledRun?.agentName;
  return { label: fallback && fallback.trim() ? fallback : "Karos agent" };
}
