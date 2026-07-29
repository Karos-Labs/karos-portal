"use server";

import { revalidatePath } from "next/cache";

import { getClient, getClientCredits, getCustomAgent } from "@/lib/data";
import { getClientAgent, updateClientAgent } from "@/lib/data-client-agents";
import { submitCustomAgentJob, isCustomAgentGrantedToClient } from "@/lib/jobs/submit-custom";
import {
  evaluateTemplateRunGate,
  templateRunPrompt,
  umbrellaRunBlock,
} from "@/lib/client-agent-runs";
import { buildAgentSetup } from "@/lib/client-agent-rows";
import { ensureSlotHorizon } from "@/lib/client-agent-slots";
import { effectiveRotation } from "@/lib/client-agents";
import {
  CREDIT_COSTS,
  availableCredits,
  creditBlockReason,
  isBillableClientActor,
} from "@/lib/credits";
import { clientSafeRunError } from "@/lib/custom-agent-launch";
import { reorderTemplateKeys } from "@/lib/slot-plan";
import { logActivity, requireClientAccess } from "./_shared";
import { templateRunStartedTitle } from "@/lib/activity-titles";
import type { AppUser, ClientAgent, ClientAgentTemplate, CustomAgent } from "@/lib/types";

/**
 * The LIVE client agent's own actions (Phase 3 §7.1 card 4): run one template
 * now, pause/resume a template, reorder the rotation.
 *
 * Separate from client-agent-actions.ts (which owns bind → launch → curate →
 * go live) because these are the actions of an agent that is already working.
 * They share one rule with the launch: every refusal here is also computed
 * pre-flight by the same pure gate (client-agent-runs.ts), so the card never
 * renders a control this file would turn away.
 */

/** Everything the three actions below resolve before they can decide anything. */
async function loadUmbrella(
  clientAgentId: string,
  clientId: string,
): Promise<
  | { ok: true; user: AppUser; umbrella: ClientAgent; agent: CustomAgent }
  | { ok: false; error: string }
> {
  const user = await requireClientAccess(clientId);
  const umbrella = await getClientAgent(clientAgentId);
  // Same answer for "missing" and "belongs to another client": the browser
  // supplies both ids, so a foreign umbrella id paired with an own clientId
  // must not confirm that the foreign one exists.
  if (!umbrella || umbrella.clientId !== clientId) return { ok: false, error: "Agent not found." };
  const agent = await getCustomAgent(umbrella.customAgentId);
  if (!agent || !agent.enabled) return { ok: false, error: "Agent not found." };
  return { ok: true, user, umbrella, agent };
}

function findTemplate(
  umbrella: ClientAgent,
  templateKey: string,
): ClientAgentTemplate | undefined {
  return umbrella.templates.find((t) => t.key === templateKey);
}

/* ─────────────────────── run one template, right now ────────────────────── */

/**
 * Fire a single post of one template stream (§6.1 "manual template run").
 *
 * Priced at the agent's flat per-run `creditCost` — Q6's ruling is that
 * templates inherit the agent price, so there is no per-template price to look
 * up and the number on the row is the number the ledger records.
 *
 * The gate ladder, server-side, in the card's own order:
 *   1. the agent is granted to this client;
 *   2. the umbrella is LIVE (the §2 guard rail — the client's surface for a
 *      not-live agent is the launch card, not a Run button);
 *   3. the template exists and is active;
 *   4. credits (billable client actors only — the charge itself happens inside
 *      the submit core, jobId-paired, so the existing refund paths apply).
 */
export async function runClientAgentTemplateAction(input: {
  clientId: string;
  clientAgentId: string;
  templateKey: string;
}): Promise<{ jobId?: string; error?: string }> {
  const loaded = await loadUmbrella(input.clientAgentId, input.clientId);
  if (!loaded.ok) return { error: loaded.error };
  const { user, umbrella, agent } = loaded;

  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };
  if (
    user.role === "CLIENT_USER" &&
    !(await isCustomAgentGrantedToClient(client, agent))
  ) {
    // Same message the submit core uses — never leak which agents exist
    // beyond a client's allowlist.
    return { error: "Agent not found." };
  }

  const template = findTemplate(umbrella, input.templateKey);
  if (!template) return { error: "That format isn't on this agent." };

  const cost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
  const billable = isBillableClientActor(user);
  let spendable: number | undefined;
  let blockReason: string | null = null;
  if (billable) {
    const now = Date.now();
    const credits = await getClientCredits(input.clientId);
    spendable = availableCredits(credits, now);
    if (spendable < cost) blockReason = creditBlockReason(credits, cost, now);
  }

  // The INTAKE rung, resolved with the SAME call the card makes. The gate
  // already has this rung; this action was calling the gate without ever
  // filling the field in, so server-side it was a no-op and the ladder here was
  // one rung shorter than the one the button was painted from. For an X /
  // LinkedIn umbrella with no intake that meant the press cleared this gate,
  // reached the submit core, and was refused there — after the credit check,
  // with a different message. "One function, called from both" only holds if
  // both feed it the same input.
  const setup =
    (await buildAgentSetup(input.clientId, [{ id: agent.id, key: agent.key }]))[agent.id] ?? null;

  const gate = evaluateTemplateRunGate({
    launchState: umbrella.launchState,
    templateStatus: template.status,
    ...(setup ? { setup } : {}),
    cost,
    ...(spendable !== undefined ? { availableCredits: spendable } : {}),
    creditBlockReason: blockReason,
  });
  if (!gate.allowed) return { error: gate.reason };

  const result = await submitCustomAgentJob(user, {
    agentId: agent.id,
    clientId: input.clientId,
    prompt: templateRunPrompt({
      agentName: umbrella.displayName,
      templateName: template.name,
      templateKey: template.key,
      rationale: template.rationale ?? null,
    }),
    runType: "manual_template",
    clientAgentId: umbrella.id,
    templateKey: template.key,
  });

  if (!result.jobId || result.error) {
    const message = result.error ?? "This run could not be started right now.";
    return { error: billable ? clientSafeRunError(message) : message };
  }

  void logActivity({
    clientId: input.clientId,
    timestamp: Date.now(),
    type: "CAMPAIGN_CREATED",
    title: templateRunStartedTitle(umbrella.displayName, template.name),
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: {
      jobId: result.jobId,
      clientAgentId: umbrella.id,
      templateKey: template.key,
      runType: "manual_template",
    },
  });
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { jobId: result.jobId };
}

/* ───────────────────────── pause / resume a template ────────────────────── */

/**
 * Turn one template stream off or back on.
 *
 * Client-callable for pause/resume only. "retired" is not offered here: it
 * drops the stream out of the client's own list, which is the same
 * irreversible-looking outcome that `setPlannedRunStatusAction` already keeps
 * away from clients for schedules.
 *
 * Pausing rewrites the rotation, which is what stops the slot generator from
 * planning days for a stream that will not produce. Existing future slots are
 * NOT rewritten — a client who pauses a format on Tuesday has not asked for
 * next month's plan to be reshuffled, and the reorder action is where that
 * happens deliberately.
 */
export async function setClientAgentTemplateStatusAction(input: {
  clientId: string;
  clientAgentId: string;
  templateKey: string;
  status: "active" | "paused";
}): Promise<{ error?: string }> {
  const loaded = await loadUmbrella(input.clientAgentId, input.clientId);
  if (!loaded.ok) return { error: loaded.error };
  const { user, umbrella } = loaded;

  const blocked = umbrellaRunBlock(umbrella.launchState);
  if (blocked && user.role === "CLIENT_USER") return { error: blocked.reason };

  const template = findTemplate(umbrella, input.templateKey);
  if (!template) return { error: "That format isn't on this agent." };
  if (template.status === "retired") return { error: "That format has been retired." };
  if (template.status === input.status) return {};

  const templates = umbrella.templates.map((t) =>
    t.key === input.templateKey ? { ...t, status: input.status } : t,
  );
  const next: ClientAgent = { ...umbrella, templates };
  await updateClientAgent(umbrella.id, { templates, rotation: effectiveRotation(next) });
  // Resuming re-opens days the paused rotation stopped planning.
  if (input.status === "active") {
    await ensureSlotHorizon({ ...next, rotation: effectiveRotation(next) }, user.uid);
  }
  revalidatePath(`/clients/${input.clientId}/agents`);
  revalidatePath("/calendar");
  return {};
}

/* ──────────────────────────── reorder the rotation ──────────────────────── */

/**
 * Re-position the template registry from an ordered list of keys.
 *
 * `reorderTemplateKeys` (slot-plan.ts) is what merges the submitted order with
 * the stored one: keys the request omits keep their relative order after the
 * ones it names, so a stale page that has never heard of a template added
 * five minutes ago cannot silently drop it.
 *
 * The horizon is regenerated afterwards, which is the point of reordering: the
 * new rotation is what the NEXT unplanned days cycle through. Days that already
 * exist are untouched — see ensureSlotHorizon.
 */
export async function reorderClientAgentTemplatesAction(input: {
  clientId: string;
  clientAgentId: string;
  orderedKeys: string[];
}): Promise<{ error?: string }> {
  const loaded = await loadUmbrella(input.clientAgentId, input.clientId);
  if (!loaded.ok) return { error: loaded.error };
  const { user, umbrella } = loaded;

  const blocked = umbrellaRunBlock(umbrella.launchState);
  if (blocked && user.role === "CLIENT_USER") return { error: blocked.reason };
  if (umbrella.templates.length === 0) return { error: "This agent has no formats yet." };

  const currentKeys = [...umbrella.templates]
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
    .map((t) => t.key);
  const orderedKeys = reorderTemplateKeys(currentKeys, input.orderedKeys);
  const byKey = new Map(umbrella.templates.map((t) => [t.key, t]));
  const templates = orderedKeys
    .map((key, index) => {
      const template = byKey.get(key);
      return template ? { ...template, position: index } : null;
    })
    .filter((t): t is ClientAgentTemplate => t !== null);

  const next: ClientAgent = { ...umbrella, templates };
  const rotation = effectiveRotation(next);
  await updateClientAgent(umbrella.id, { templates, rotation });
  await ensureSlotHorizon({ ...next, rotation }, user.uid);
  revalidatePath(`/clients/${input.clientId}/agents`);
  revalidatePath("/calendar");
  return {};
}
