"use server";

/**
 * Reputation agent (v2) intake actions: the client's own configuration and the
 * one press that fires setup.
 *
 * ── ASK vs BUILD ──────────────────────────────────────────────────────────
 *
 * The roster proper, the response voice, the autonomy bounds and the recurring
 * complaint themes are all BUILT by setup from the client's own documents and
 * their real review history. None of it is asked here and none of it may be.
 *
 * What is left is what setup cannot discover, and one field is unlike anything
 * the other four families collect: `crisisRoutingTag`. It is a fact about the
 * client's own organisation, it exists in no document, and it is the whole of
 * the portal's answer when a draft-only agent finds something urgent.
 *
 * NO SEATS AND NO ZOD. A review is about the business, so every write here is
 * the `seatId: null` document. Validation is hand-written for the same reason
 * its four siblings' is: the parse and the CLEAR pass have to agree on what "the
 * client emptied this" means, and a schema that coerced a blank to a default
 * would silently keep a rule the client deleted.
 */

import { revalidatePath } from "next/cache";
import {
  clearAgentIntakeFields,
  getAgentIntake,
  getClient,
  getCustomAgentByKey,
  upsertAgentIntake,
} from "@/lib/data";
import { REPUTATION_SETUP_KEY, clientSafeRunError } from "@/lib/custom-agent-launch";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { isBillableClientActor } from "@/lib/credits";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;
const MAX_SURFACES = 25;
const MAX_MARKETS = 40;
const MAX_NO_GOS = 40;

/**
 * A list field, one entry per line or comma-separated.
 *
 * Deduplicated case-insensitively, stored in the CLIENT'S OWN CASING: the run
 * quotes these back in a refusal, and a client reading their own rule in the
 * wrong case has to stop and work out whether it is theirs.
 */
function parseList(raw: string, cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

/* ─────────────────────────── the form ─────────────────────────── */

/**
 * Every answer is OPTIONAL, and saving the form satisfies the first rung of the
 * run gate. Same portal policy as the other four families: the run dialog
 * renders this form inline, so pressing Run the first time IS the form. The
 * SECOND rung (has setup produced a roster) decides whether a pulse can start.
 */
export async function saveReputationCompanyIntakeAction(input: {
  clientId: string;
  /** Where the client believes they are reviewed. A seed for the roster. */
  reviewSurfaces: string;
  /** Locations or markets the reviews are spread across. */
  reviewMarkets: string;
  /** Standing context a responder must know before writing. */
  reputationContext: string;
  /** Who an urgent review is routed to, and how. */
  crisisRoutingTag: string;
  /** Claims they may never make in a public reply. */
  responseNoGos: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  for (const value of [
    input.reviewSurfaces,
    input.reviewMarkets,
    input.reputationContext,
    input.crisisRoutingTag,
    input.responseNoGos,
  ]) {
    if (value.length > MAX_TEXT) {
      return { error: "Please keep each answer under 2,000 characters." };
    }
  }

  const surfacesRaw = input.reviewSurfaces.trim();
  const marketsRaw = input.reviewMarkets.trim();
  const noGosRaw = input.responseNoGos.trim();
  const reviewSurfaces = parseList(input.reviewSurfaces, MAX_SURFACES);
  const reviewMarkets = parseList(input.reviewMarkets, MAX_MARKETS);
  const responseNoGos = parseList(input.responseNoGos, MAX_NO_GOS);

  // An answer we cannot read is a misunderstanding, not a blank. Say so rather
  // than storing nothing: silently keeping none of a BINDING never-claim list is
  // how a promise the client's own lawyers forbade ends up in a public reply.
  if (noGosRaw && responseNoGos.length === 0) {
    return {
      error:
        "We could not read anything in that list. Write one per line, or separate them with commas.",
    };
  }
  if (surfacesRaw && reviewSurfaces.length === 0) {
    return {
      error: "We could not read a site in that list. Write one per line, like Google or Yelp.",
    };
  }

  // The upsert MERGES, so an answer the client CLEARED would otherwise keep
  // steering every future pulse. Each condition keys on the RAW input being
  // blank, never on a parse result: keying a list on its parsed length would
  // turn an answer we failed to read into a delete, and the guards above only
  // hold while they and this drop agree on what "cleared" means.
  //
  // `crisisRoutingTag` is in the list like the rest, and the reason is worth
  // stating: a contact who has LEFT must actually disappear. A stale name here
  // routes an urgent review to somebody who no longer works there, which is
  // worse than the honest "nobody named" the context builder writes when it is
  // absent.
  const existing = await getAgentIntake(input.clientId, "reputation", null);
  if (existing) {
    const drop: Array<
      | "reviewSurfaces"
      | "reviewMarkets"
      | "reputationContext"
      | "crisisRoutingTag"
      | "responseNoGos"
    > = [];
    if (!surfacesRaw && existing.reviewSurfaces?.length) drop.push("reviewSurfaces");
    if (!marketsRaw && existing.reviewMarkets?.length) drop.push("reviewMarkets");
    if (!input.reputationContext.trim() && existing.reputationContext) {
      drop.push("reputationContext");
    }
    if (!input.crisisRoutingTag.trim() && existing.crisisRoutingTag) drop.push("crisisRoutingTag");
    if (!noGosRaw && existing.responseNoGos?.length) drop.push("responseNoGos");
    await clearAgentIntakeFields(existing.id, drop);
  }

  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "reputation",
    seatId: null,
    // No platform account and no engagement roster. Spelled rather than omitted
    // so the shared document never carries another family's leftovers on a
    // client who runs more than one agent.
    handle: null,
    roster: [],
    ...(reviewSurfaces.length > 0 ? { reviewSurfaces } : {}),
    ...(reviewMarkets.length > 0 ? { reviewMarkets } : {}),
    ...(input.reputationContext.trim()
      ? { reputationContext: input.reputationContext.trim() }
      : {}),
    ...(input.crisisRoutingTag.trim() ? { crisisRoutingTag: input.crisisRoutingTag.trim() } : {}),
    ...(responseNoGos.length > 0 ? { responseNoGos } : {}),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/reputation-agent`);
  // The agents page renders this form inline in the run dialog and derives the
  // run gate from the same document, so it goes stale on every write here.
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ─────────────────────────── the setup run ─────────────────────────── */

function setupPrompt(clientName: string): string {
  return [
    `Set up reputation monitoring for ${clientName}.`,
    "",
    "Run the setup skill end to end. Produce the seven standing files every pulse",
    "reads: the business facts, the surface config, the AUTONOMY BOUNDS, the",
    "roster of real listings, the response voice, and the two empty ledgers.",
    "",
    "THE ROSTER IS THE WORK. The client names where they THINK they are reviewed;",
    "resolve that to real listings per surface and market. A business may hold a",
    "Google Business Profile under a trading name and duplicate Yelp entries from",
    "a merge. A wrong listing means drafting replies to another business's",
    "customers, so record how each one was confirmed.",
    "",
    "Set the autonomy bounds explicitly: what may be drafted unattended, what must",
    "be escalated to a person, and what must never be touched. This product is",
    "draft-only either way, but the bounds decide what counts as urgent.",
    "",
    "IF A RESPONSE LEDGER ALREADY EXISTS AND HOLDS ROWS, VERIFY IT, never re-seed",
    "it. Those rows are reviews that have already been answered in public, and an",
    "emptied ledger makes the next pulse answer them a second time.",
    "",
    "Do not draft any replies in this run. This is the setup.",
  ].join("\n");
}

/**
 * Fire setup for a client.
 *
 * Its own action rather than the client-agent launch flow, for the reason its
 * three siblings state: setup is a DIFFERENT SKILL in a different directory from
 * the runner, and that flow fires one agent doc and refuses a second launch with
 * "already live". Re-running setup is a normal act here — a client opens a new
 * location, or a listing gets merged.
 */
export async function runReputationSetupAction(input: {
  clientId: string;
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const agent = await getCustomAgentByKey(REPUTATION_SETUP_KEY);
  if (!agent || !agent.enabled) {
    return {
      error: "The reputation setup agent is not available. Your Karos team can enable it.",
    };
  }
  // The submit core's own gate would also catch this, but its sentence explains
  // a gate rather than naming the one thing the reader has to do, and the form
  // is on the same page as the button they just pressed.
  if (!(await getAgentIntake(input.clientId, "reputation", null))) {
    return { error: "Save your reputation details below first, so setup knows your rules." };
  }

  const result = await submitCustomAgentJob(user, {
    agentId: agent.id,
    clientId: input.clientId,
    prompt: setupPrompt(client.name),
    runType: "launch",
  });

  if (result.jobId && !result.error) {
    revalidatePath(`/clients/${input.clientId}/reputation-agent`);
    revalidatePath(`/clients/${input.clientId}/agents`);
    revalidatePath("/jobs");
    return result;
  }
  // A billable client actor never reads the submit core's internal strings.
  if (result.error && isBillableClientActor(user)) {
    return { error: clientSafeRunError(result.error) };
  }
  return result;
}
