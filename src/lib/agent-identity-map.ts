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
import { agentLabelForAsset, chainFamilyFor, type ChainFamily } from "@/lib/post-chain";

/** What the resolver needs to know about a client's umbrella agents. */
export type ClientAgentIdentity = Pick<
  ClientAgent,
  "id" | "agentKey" | "customAgentId" | "displayName" | "platform" | "chainFamily" | "launchState"
>;

/** The job fields identity is resolved from — never its payload or its events. */
export type IdentityJob = Pick<
  Job,
  "clientAgentId" | "customAgentId" | "agentName" | "external"
>;

export interface ContentIdentityInput {
  job?: IdentityJob | null;
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

/**
 * The umbrella index rule 1 looks a linked id up in.
 *
 * EXPORTED AND HOISTABLE (review wave, 2026-09). It used to be built inside
 * `resolveContentIdentity`, which is called once per row by surfaces that render
 * many rows — a fresh Map over the client's whole umbrella list per asset, for a
 * lookup that never changes within a render. Callers with a loop build it once
 * and pass it; callers with a single row still pass nothing and pay for one.
 */
export function clientAgentsById(
  agents: readonly ClientAgentIdentity[],
): Map<string, ClientAgentIdentity> {
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
 * A managed task type is the catalog's spelling of a content family. Both the
 * asset (`meta.taskType`) and the job (`external.taskType`) carry it, and
 * "landing_page" deliberately maps to nothing — it belongs to no chain.
 */
const FAMILY_BY_TASK_TYPE: Record<string, ChainFamily> = {
  social_post: "social",
  // RETIRED product, kept for HISTORY. Every v1 newsletter job carries this in
  // `external.taskType`, and this map is what the /jobs list, the calendar's
  // past-run cards and the run history resolve a family from. Keyed by `string`
  // for exactly this reason — see RETIRED_NEWSLETTER_TASK_TYPE in types.ts.
  newsletter_issue: "email",
  blog_article: "article",
};

/**
 * The content family this row belongs to, from whichever of the three shapes
 * the calling surface happens to hold.
 *
 * Reading it off the JOB matters as much as off the asset: a run row IS the
 * job and nothing else (the calendar's past-run cards, the /jobs list, the
 * agent run history), and the managed job whose `agentName` is the literal
 * "Social posts (IG/TikTok)" string F147 is about carries its family only in
 * `external.taskType`. Without this rung those rows would keep printing the
 * managed-product label beside the umbrella's own name on the very same day.
 */
function familyOf(input: ContentIdentityInput): ChainFamily | null {
  if (input.asset) {
    const family = chainFamilyFor(input.asset.type);
    if (family) return family;
    const assetTaskType = metaString(input.asset.meta, "taskType");
    if (assetTaskType && FAMILY_BY_TASK_TYPE[assetTaskType]) {
      return FAMILY_BY_TASK_TYPE[assetTaskType];
    }
  }
  const jobTaskType = input.job?.external?.taskType;
  if (jobTaskType && FAMILY_BY_TASK_TYPE[jobTaskType]) return FAMILY_BY_TASK_TYPE[jobTaskType];
  return null;
}

/**
 * Resolve the single identity for a run / asset / schedule row.
 *
 * Rules, in order — the first that answers wins:
 *   1. an explicit umbrella link (slot, job, or schedule row);
 *   2. the job's / schedule's custom agent → its umbrella for this client;
 *   3. the content family — read from the asset's type / `meta.taskType` or
 *      from the job's `external.taskType` — → the client's live umbrella that
 *      OWNS that family. This is the rung that kills the double identity: a
 *      social post produced before umbrellas existed carries no agent link at
 *      all, and without this it would keep rendering the managed-product label
 *      beside the umbrella's own name;
 *   4. today's fallback labels (agentLabelForAsset / the job's agent name),
 *      so nothing that renders today starts rendering blank.
 */
export function resolveContentIdentity(
  input: ContentIdentityInput,
  clientAgents: ClientAgentIdentity[],
  /** A prepared `clientAgentsById(clientAgents)`, for callers in a loop. */
  agentsByIdIndex?: ReadonlyMap<string, ClientAgentIdentity>,
): ContentIdentity {
  const agentsById = agentsByIdIndex ?? clientAgentsById(clientAgents);

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

  const family = familyOf(input);
  if (family) {
    const owner = clientAgents.find(
      (agent) => agent.chainFamily === family && agent.launchState === "live",
    );
    if (owner) return identityOf(owner);
  }

  if (input.asset) {
    const label = agentLabelForAsset(input.asset);
    if (label) return { label };
  }

  const fallback = input.job?.agentName ?? input.scheduledRun?.agentName;
  return { label: fallback && fallback.trim() ? fallback : "Karos agent" };
}

/**
 * The ONE name a RUN row prints — /jobs, the calendar's past-run cards, the
 * Workspace activity timeline, an agent's run history.
 *
 * Four surfaces were each writing `resolveContentIdentity({ job }, …).label`
 * inline, which is four places for one of them to quietly go back to reading
 * `job.agentName`. It is also the only thing the surface test can hold onto:
 * a test that re-declares the call proves the RULES (agent-identity-map.test.ts
 * already does that) and nothing at all about the wiring.
 *
 * The job ALONE, deliberately — never its assets. A run row IS the job, so its
 * fallback rung must stay the run's own recorded name; feeding the deliverables
 * in would let an asset-derived label outrank it.
 */
export function runRowLabel(job: IdentityJob, clientAgents: ClientAgentIdentity[]): string {
  return resolveContentIdentity({ job }, clientAgents).label;
}

/**
 * The same, for a row that has not fired yet (the calendar's scheduled cards).
 * The schedule carries the LAB agent's repo name
 * ("karos-instagram-tiktok-content-agent"), so printing it verbatim is the
 * F147 defect wearing a third name.
 */
export function scheduleRowLabel(
  scheduledRun: Pick<PlannedScheduledRun, "clientAgentId" | "customAgentId" | "agentName">,
  clientAgents: ClientAgentIdentity[],
): string {
  return resolveContentIdentity({ scheduledRun }, clientAgents).label;
}

/**
 * Umbrellas grouped by client, for the surfaces that render rows of MANY
 * clients at once (the staff calendar overview, /jobs).
 *
 * Those surfaces resolve an identity per row, and a per-row umbrella query
 * would be one Firestore read per printed line. They read the umbrellas once
 * for the whole scope and index them here instead.
 */
export function identitiesByClient<T extends ClientAgentIdentity & { clientId: string }>(
  agents: T[],
): Map<string, T[]> {
  const byClient = new Map<string, T[]>();
  for (const agent of agents) {
    const bucket = byClient.get(agent.clientId);
    if (bucket) bucket.push(agent);
    else byClient.set(agent.clientId, [agent]);
  }
  return byClient;
}

/**
 * The archive grouping's projection: assetId → the ONE name its group heading
 * may carry.
 *
 * A pure function rather than a loop inside the page, because the archive is a
 * CLIENT component: it used to receive `jobId → job.agentName` and join it
 * itself, which is a second (and, for an asset whose job was filtered out of
 * the payload, a differently-answering) copy of the resolver. Resolving here
 * means only finished labels cross the RSC boundary — no umbrella ids, launch
 * states or chain families reach the browser to be re-derived from.
 */
export function contentLabelsByAsset(
  assets: Array<
    Pick<Asset, "id" | "jobId" | "agentId" | "meta" | "type" | "templateKey" | "templateName">
  >,
  jobs: Array<IdentityJob & { id: string }>,
  clientAgents: ClientAgentIdentity[],
): Record<string, string> {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  // Both indexes hoisted out of the loop — see `clientAgentsById`.
  const agentsById = clientAgentsById(clientAgents);
  const labels: Record<string, string> = {};
  for (const asset of assets) {
    const job = asset.jobId ? (jobById.get(asset.jobId) ?? null) : null;
    labels[asset.id] = resolveContentIdentity({ asset, job }, clientAgents, agentsById).label;
  }
  return labels;
}
