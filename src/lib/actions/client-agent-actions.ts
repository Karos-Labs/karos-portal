"use server";

import { revalidatePath } from "next/cache";

import {
  getClient,
  getClientCredits,
  getCustomAgent,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import {
  claimClientAgentLaunch,
  getClientAgent,
  releaseClientAgentLaunch,
  updateClientAgent,
  upsertClientAgent,
} from "@/lib/data-client-agents";
import { isCustomAgentGrantedToClient, submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import {
  LAUNCH_BLOCK_REASON,
  canSubmitLaunch,
  evaluateLaunchGate,
  isOptionsMode,
  type ClientAgentTemplateInput,
} from "@/lib/client-agents";
import { ensureSlotHorizon } from "@/lib/client-agent-slots";
import { availableCredits, creditBlockReason, isBillableClientActor } from "@/lib/credits";
import {
  clientSafeRunError,
  isLinkedInAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import { hasXAgentIntake } from "@/lib/agent-service/x-agent-context";
import { hasLinkedInAgentIntake } from "@/lib/agent-service/linkedin-agent-context";
import { socialPlatformsFor } from "@/components/agent-identity";
import { logActivity, requireClientAccess, requireStaff } from "./_shared";
import type { ClientAgent, ClientAgentTemplate, CustomAgent } from "@/lib/types";

/**
 * Client-agent umbrella actions — bind, LAUNCH, curate, go live (Phase 3 §2).
 *
 * The launch is the one-time heavy setup run that researches the client and
 * designs their template set. Albert's rulings: it is triggerable by BOTH the
 * client and staff (Q2) and it is CLIENT-BILLED at a price set per agent from
 * the measured setup-vs-run cost ratio (Q1) — with the client's button GATED
 * while that price is uncalibrated rather than charging a provisional number
 * (Q10).
 *
 * Every refusal here is a line a client may read, and every one of them is
 * ALSO computed pre-flight by the same pure gate (client-agents.ts), so the
 * card never offers a control this action would refuse.
 */

const MAX_TEMPLATES = 12;
const MAX_TEMPLATE_NAME = 80;
const MAX_TEMPLATE_RATIONALE = 400;
const TEMPLATE_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/* ─────────────────────────────── binding ────────────────────────────── */

/**
 * Which content family an umbrella's slots own.
 *
 * The X agent deliberately owns NONE: it produces a weekly batch and syncs to
 * the calendar as a daily pick-of-3 (§4.5), so its slots present choices and
 * must never re-date chain assets. Everything else maps by identity, with the
 * social platforms as the catch-all — that is the same signal §9's backfill
 * uses to decide an agent is a content platform at all.
 */
function chainFamilyForAgent(agent: Pick<CustomAgent, "key" | "name">): ClientAgent["chainFamily"] {
  if (isXAgentIdentity(agent.key)) return undefined;
  const identity = `${agent.key} ${agent.name}`.toLowerCase();
  if (/newsletter/.test(identity)) return "email";
  if (/blog|article/.test(identity)) return "article";
  if (socialPlatformsFor(identity).length > 0) return "social";
  return undefined;
}

/**
 * Whether this agent is ALREADY working for this client — a successful custom
 * run in its history, or a live weekly schedule row.
 *
 * Binding such an agent as `not_launched` is not a neutral act: the client's
 * agents page hands a pre-launch umbrella its card, which removes the agent's
 * Run button, its schedule row and its run history from the client's view and
 * replaces the lot with "Not set up yet" — for an agent that is, visibly to
 * them, producing. That is why the bind control asks before doing it (W6).
 */
async function isAgentProducingForClient(
  clientId: string,
  agent: Pick<CustomAgent, "id" | "name">,
): Promise<boolean> {
  const [jobs, schedules] = await Promise.all([
    listJobs({ clientId }),
    listPlannedScheduledRuns({ clientId }),
  ]);
  const successful = new Set(["review", "approved", "delivered"]);
  const hasRun = jobs.some(
    (job) =>
      job.external?.taskType === "custom" &&
      successful.has(job.status) &&
      (job.customAgentId === agent.id || (!job.customAgentId && job.agentName === agent.name)),
  );
  if (hasRun) return true;
  return schedules.some(
    (run) => run.customAgentId === agent.id && run.status !== "completed",
  );
}

/**
 * Create (or return) the umbrella binding a lab agent to a client. Staff-only:
 * a client never chooses which lab agent backs their Instagram Agent.
 *
 * Idempotent by construction — the doc id is derived from (clientId, agentKey),
 * so a second bind returns the existing umbrella with its launch state, its
 * templates and its rotation untouched.
 *
 * An agent that is ALREADY producing for this client is not bound silently: the
 * call returns `alreadyProducing` and writes nothing, so the control can offer
 * the two honest choices (W6). `bindAsLive` takes the grandfathered path —
 * the same state §9's backfill gives an agent whose runs predate launches — and
 * `bindAsNew` is the deliberate "yes, take it offline until it is set up".
 */
export async function bindClientAgentAction(input: {
  clientId: string;
  customAgentId: string;
  displayName?: string;
  /** Bind an already-producing agent as live (keeps it producing). */
  bindAsLive?: boolean;
  /** Bind as not-set-up even though it is already producing (staff confirmed). */
  bindAsNew?: boolean;
}): Promise<{
  id?: string;
  created?: boolean;
  /** Set when the bind needs a decision first — nothing was written. */
  alreadyProducing?: boolean;
  error?: string;
}> {
  const user = await requireStaff();
  const [client, agent] = await Promise.all([
    getClient(input.clientId),
    getCustomAgent(input.customAgentId),
  ]);
  if (!client) return { error: "Client not found." };
  if (!agent || !agent.enabled) return { error: "Agent not found." };

  if (!input.bindAsLive && !input.bindAsNew) {
    if (await isAgentProducingForClient(input.clientId, agent)) {
      return { alreadyProducing: true };
    }
  }

  const identity = `${agent.key} ${agent.name}`;
  const platform = socialPlatformsFor(identity)[0] ?? "";
  const chainFamily = chainFamilyForAgent(agent);
  const now = Date.now();
  const { id, created } = await upsertClientAgent({
    clientId: input.clientId,
    agentKey: agent.key,
    customAgentId: agent.id,
    displayName: (input.displayName ?? agent.name).trim().slice(0, 120) || agent.name,
    platform,
    ...(chainFamily ? { chainFamily } : {}),
    // Explicit at bind time, never inferred from a missing chainFamily (W3).
    slotMode: isXAgentIdentity(agent.key) ? "options" : "single",
    // Grandfathered: an agent that is already producing keeps producing. Its
    // template registry stays empty until someone fills it, which is exactly
    // the state the backfill leaves — and the page keeps serving it today's
    // card while it is empty, so nothing the client uses disappears.
    ...(input.bindAsLive
      ? { launchState: "live" as const, launchCompletedAt: now }
      : { launchState: "not_launched" as const }),
    templates: [],
    rotation: [],
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { id, created };
}

/* ──────────────────────────── the launch flow ───────────────────────── */

/**
 * The setup brief. Names the deliverables the curation pane and the T1 seam
 * expect, and states what the run must NOT do: a launch designs the templates,
 * it does not produce a batch of posts (which would put content on a client's
 * calendar before any of it was planned).
 */
function launchPrompt(agent: ClientAgent, clientName: string): string {
  return [
    `Set up the ${agent.displayName} for ${clientName}.`,
    "",
    "Research this client's brand, their audience, and what already works in their market, then design the recurring post templates this agent will produce from now on (aim for 3-5).",
    "",
    "Deliverables:",
    "1. A written rationale: the template set, and why each one fits this client.",
    "2. `templates.json` — a client-facing artifact containing [{ key, name, rationale }] with kebab-case keys, so the portal can register the templates automatically.",
    "",
    "Do not produce finished posts in this run — this is the setup, not a content batch.",
  ].join("\n");
}

/**
 * Fire the setup run for a client agent.
 *
 * The gate ladder runs SERVER-SIDE in this order (§2), each rung with a
 * client-readable refusal:
 *   1. agent granted + the umbrella is in a launchable state (one launch in
 *      flight per umbrella — enforced by a transactional claim, not a read);
 *   2. intake-gated agents (X / LinkedIn) must have their intake stored;
 *   3. pricing gate, billable client actors only — no calibrated price, no
 *      client-fired launch;
 *   4. the charge itself, jobId-paired inside the submit core so the existing
 *      webhook refund hands it back on failure with no new code.
 *
 * Staff (and admins in "View as Client") skip rungs 3 and 4 entirely: their
 * launches are free, and they are precisely the runs that measure what a setup
 * costs so the price can be set.
 */
export async function submitClientAgentLaunchAction(input: {
  clientId: string;
  clientAgentId: string;
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const umbrella = await getClientAgent(input.clientAgentId);
  // Same answer for "missing" and "belongs to another client" — the browser
  // supplies both ids, so a foreign umbrella id paired with an own clientId
  // must not confirm that the foreign one exists.
  if (!umbrella || umbrella.clientId !== input.clientId) return { error: "Agent not found." };

  const [client, agent] = await Promise.all([
    getClient(input.clientId),
    getCustomAgent(umbrella.customAgentId),
  ]);
  if (!client) return { error: "Client not found." };
  if (!agent || !agent.enabled) return { error: "Agent not found." };

  const granted =
    user.role !== "CLIENT_USER" || (await isCustomAgentGrantedToClient(client, agent));

  // Intake readiness, resolved with the SAME calls the submit core hard-gates
  // on, so the two can never disagree about whether a run may start.
  let intakeReady = true;
  let intakeLabel: string | null = null;
  if (isXAgentIdentity(agent.key)) {
    intakeLabel = "X agent data";
    intakeReady = await hasXAgentIntake(input.clientId);
  } else if (isLinkedInAgentIdentity(agent.key)) {
    intakeLabel = "LinkedIn agent data";
    intakeReady = await hasLinkedInAgentIntake(input.clientId, agent.key);
  }

  const billable = isBillableClientActor(user);
  const launchCost = agent.launchCreditCost ?? null;
  let spendable: number | undefined;
  let blockReason: string | null = null;
  if (billable) {
    const now = Date.now();
    const credits = await getClientCredits(input.clientId);
    spendable = availableCredits(credits, now);
    if (launchCost != null && spendable < launchCost) {
      blockReason = creditBlockReason(credits, launchCost, now);
    }
  }

  const gate = evaluateLaunchGate({
    launchState: umbrella.launchState,
    granted,
    intakeReady,
    intakeLabel,
    launchCreditCost: launchCost,
    ...(spendable !== undefined ? { availableCredits: spendable } : {}),
    creditBlockReason: blockReason,
  });
  if (!gate.allowed) return { error: gate.reason };

  // Atomic: two presses (or a client and a staff member at once) cannot both
  // submit a setup job and charge for it.
  if (!(await claimClientAgentLaunch(umbrella.id))) {
    return { error: LAUNCH_BLOCK_REASON.launch_in_flight };
  }

  const result = await submitCustomAgentJob(user, {
    agentId: agent.id,
    clientId: input.clientId,
    prompt: launchPrompt(umbrella, client.name),
    runType: "launch",
    clientAgentId: umbrella.id,
    ...(billable && launchCost != null
      ? {
          charge: {
            amount: launchCost,
            operation: "agent_launch" as const,
            reason: `Agent setup · ${umbrella.displayName}`,
          },
        }
      : {}),
  });

  if (!result.jobId || result.error) {
    // Nothing ran and nothing was charged (the core deletes the job and hands
    // the credits back before returning), so the umbrella goes back to
    // launchable rather than sitting in a failed state the client would have
    // to ask staff to clear.
    await releaseClientAgentLaunch(umbrella.id);
    const message = result.error ?? "This setup could not be started right now.";
    return { error: billable ? clientSafeRunError(message) : message };
  }

  await updateClientAgent(umbrella.id, { launchJobId: result.jobId });
  void logActivity({
    clientId: input.clientId,
    timestamp: Date.now(),
    type: "CAMPAIGN_CREATED",
    title: `Agent setup started: ${umbrella.displayName}`,
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: { jobId: result.jobId, clientAgentId: umbrella.id, runType: "launch" },
  });
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { jobId: result.jobId };
}

/** Staff "Reset": clear a failed launch so the agent can be set up again. */
export async function resetClientAgentLaunchAction(
  clientAgentId: string,
): Promise<{ error?: string }> {
  await requireStaff();
  const umbrella = await getClientAgent(clientAgentId);
  if (!umbrella) return { error: "Agent not found." };
  if (umbrella.launchState === "live") return { error: "This agent is already live." };
  await releaseClientAgentLaunch(clientAgentId);
  revalidatePath(`/clients/${umbrella.clientId}/agents`);
  return {};
}

/* ───────────────────────────── curation ─────────────────────────────── */

function normalizeTemplates(
  inputs: ClientAgentTemplateInput[],
  existing: ClientAgentTemplate[],
  now: number,
): { templates: ClientAgentTemplate[]; error?: string } {
  if (inputs.length > MAX_TEMPLATES) {
    return { templates: [], error: `At most ${MAX_TEMPLATES} templates.` };
  }
  const previous = new Map(existing.map((t) => [t.key, t]));
  const seen = new Set<string>();
  const templates: ClientAgentTemplate[] = [];
  for (const [index, raw] of inputs.entries()) {
    const key = raw.key.trim().toLowerCase();
    if (!TEMPLATE_KEY_RE.test(key)) {
      return { templates: [], error: `"${raw.key}" is not a valid template key (kebab-case).` };
    }
    if (seen.has(key)) return { templates: [], error: `Duplicate template "${key}".` };
    seen.add(key);
    const name = raw.name.trim().slice(0, MAX_TEMPLATE_NAME);
    if (!name) return { templates: [], error: "Every template needs a name." };
    const rationale = raw.rationale?.trim().slice(0, MAX_TEMPLATE_RATIONALE);
    const prior = previous.get(key);
    templates.push({
      key,
      name,
      ...(rationale ? { rationale } : {}),
      status: raw.status ?? prior?.status ?? "active",
      position: index,
      source: prior?.source ?? "manual",
      addedAt: prior?.addedAt ?? now,
    });
  }
  return { templates };
}

/**
 * Staff confirm the template registry produced by the launch (Q3 default: the
 * curation gate stays even once the setup run emits `templates.json` — it just
 * becomes one click). Rotation follows the confirmed order.
 */
export async function saveClientAgentTemplatesAction(input: {
  clientAgentId: string;
  templates: ClientAgentTemplateInput[];
}): Promise<{ error?: string }> {
  await requireStaff();
  const umbrella = await getClientAgent(input.clientAgentId);
  if (!umbrella) return { error: "Agent not found." };
  const now = Date.now();
  const { templates, error } = normalizeTemplates(input.templates, umbrella.templates, now);
  if (error) return { error };
  await updateClientAgent(umbrella.id, {
    templates,
    rotation: templates.filter((t) => t.status === "active").map((t) => t.key),
  });
  revalidatePath(`/clients/${umbrella.clientId}/agents`);
  return {};
}

/**
 * Staff "Go live": the curated template set becomes the client's live agent.
 * Refused without templates — a live umbrella with an empty registry would
 * generate slots for nothing and show the client an agent that cannot produce.
 */
export async function goLiveClientAgentAction(
  clientAgentId: string,
): Promise<{ error?: string }> {
  const user = await requireStaff();
  const umbrella = await getClientAgent(clientAgentId);
  if (!umbrella) return { error: "Agent not found." };
  if (umbrella.launchState === "live") return {};
  if (canSubmitLaunch(umbrella.launchState)) {
    return { error: "Run the setup first — there is nothing to confirm yet." };
  }
  const active = umbrella.templates.filter((t) => t.status === "active");
  // The options-mode umbrella (X) has no template streams by design — its
  // product is the daily pick, so an empty registry is the correct state.
  if (active.length === 0 && !isOptionsMode(umbrella)) {
    return { error: "Confirm at least one template before going live." };
  }
  const rotation = active.map((t) => t.key);
  await updateClientAgent(umbrella.id, {
    launchState: "live",
    launchCompletedAt: Date.now(),
    launchError: null,
    rotation,
  });
  // Going live is the first moment the plan CAN be drawn: there is a confirmed
  // rotation to cycle. Best-effort — a missing or paused schedule simply means
  // no days to plan yet, and the umbrella is live either way.
  await ensureSlotHorizon(
    { ...umbrella, launchState: "live", rotation, templates: umbrella.templates },
    user.uid,
  ).catch(() => ({ created: 0 }));
  revalidatePath(`/clients/${umbrella.clientId}/agents`);
  revalidatePath("/calendar");
  return {};
}
