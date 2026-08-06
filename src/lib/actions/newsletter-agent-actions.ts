"use server";

/**
 * Newsletter agent (v2) intake actions: the client's own configuration, the
 * per-issue feedback ledger, and the one press that fires setup.
 *
 * ── ASK vs BUILD, and why this form is the shortest of the four ──────────
 *
 * Everything editorial — the content pillars, the voice card, the topic pool,
 * the niche watch-list, the compliance block — is BUILT by the setup skill from
 * the onboarding documents the client already gave us, and lives in
 * `newsletterAgentState`. None of it is asked here and none of it may be: the
 * setup framework names itself the single writer of record for those files, and
 * a form that collected them would put a second author on data that has one.
 *
 * What is left is what research genuinely cannot reach: which day they want it,
 * which platform they send from, who they think they are writing for, the
 * phrases their own lawyers have banned, and any standing legal question they
 * have not resolved. Five fields, all optional.
 *
 * NEWSLETTER HAS NO SEATS. An issue goes out from the business, never from a
 * person, so every write here is the `seatId: null` document — which is also
 * the document the run gate reads. There is no news drop either: the seven-day
 * scan finds what happened; it is not told.
 */

import { revalidatePath } from "next/cache";
import {
  addNewsletterDraftFeedback,
  clearAgentIntakeFields,
  getAgentIntake,
  getClient,
  getCustomAgentByKey,
  upsertAgentIntake,
} from "@/lib/data";
import {
  NEWSLETTER_SETUP_V2_KEY,
  clientSafeRunError,
} from "@/lib/custom-agent-launch";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { isBillableClientActor } from "@/lib/credits";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;
/** A whole issue can be long; this only bounds what a client pastes back to us. */
const MAX_ISSUE_TEXT = 50_000;
/** Enough for a real legal list without letting the field become a document. */
const MAX_BANNED_PHRASES = 60;

/** The closed reason set the weekly manager acts on. */
const NOT_SENT_REASON_CODES = [
  "off_topic",
  "wrong_voice",
  "compliance",
  "too_long",
  "timing",
  "other",
] as const;

type NotSentReasonCode = (typeof NOT_SENT_REASON_CODES)[number];

function isReasonCode(value: string): value is NotSentReasonCode {
  return (NOT_SENT_REASON_CODES as readonly string[]).includes(value);
}

/**
 * The banned-phrase list, one per line or comma-separated.
 *
 * Deduplicated case-insensitively but stored in the CLIENT'S OWN CASING, because
 * the step-08 sweep quotes the phrase back in its refusal and a client reading
 * their own rule in the wrong case has to stop and work out whether it is theirs.
 */
function parseBannedPhrases(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const phrase = part.trim();
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= MAX_BANNED_PHRASES) break;
  }
  return out;
}

/**
 * The chosen send day, or null.
 *
 * NULL IS A REAL ANSWER and the parse has to preserve that. The framework
 * records three existing files all asserting Tuesday, contradicting the standing
 * decision that the weekday belongs to the client — so "" means the client has
 * not chosen, and it must reach the run as "not chosen" rather than as a default.
 * Anything unparseable is treated the same way: inventing a day is the failure.
 */
function parseWeekday(raw: string): number | null {
  const day = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : null;
}

/* ─────────────────────────── the form ─────────────────────────── */

/**
 * Every answer is OPTIONAL, and saving the form — even empty — is what satisfies
 * the first rung of the run gate. Same deliberate portal policy as the other
 * three families: the run dialog renders this form inline, so pressing Run the
 * first time IS the form, and an empty save is a client who read it and had
 * nothing to add. The SECOND rung (has setup produced an issue index) is the one
 * that actually decides whether a writer run can start.
 */
export async function saveNewsletterCompanyIntakeAction(input: {
  clientId: string;
  /** "" = no day chosen yet, which is a real answer. Otherwise "0".."6". */
  preferredWeekday: string;
  /** The platform they send from. Recorded, never a gate. */
  espName: string;
  /** Who the issue is for, in their words. */
  audienceNote: string;
  /** Phrases we may never print, on top of the house rules. */
  bannedPhrases: string;
  /** A standing legal question they have not answered. */
  openComplianceNote: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  for (const value of [
    input.espName,
    input.audienceNote,
    input.bannedPhrases,
    input.openComplianceNote,
  ]) {
    if (value.length > MAX_TEXT) {
      return { error: "Please keep each answer under 2,000 characters." };
    }
  }

  const preferredWeekday = parseWeekday(input.preferredWeekday);
  const bannedRaw = input.bannedPhrases.trim();
  const bannedPhrases = parseBannedPhrases(input.bannedPhrases);
  // An answer we cannot read is a misunderstanding, not a blank — and silently
  // keeping none of a BINDING banned-phrase list is how a phrase the client's
  // own lawyers forbade ends up in an email to their whole list.
  if (bannedRaw && bannedPhrases.length === 0) {
    return {
      error:
        "We could not read a phrase in that list. Write one per line, or separate them with commas.",
    };
  }

  // The upsert MERGES, so an answer the client CLEARED would otherwise keep
  // steering every future issue. Each condition keys on the raw input being
  // blank, never on a parse result: keying the phrase list on its parsed length
  // would turn an answer we failed to read into a delete, and the guard above
  // only holds while it and this drop agree on what "cleared" means.
  //
  // `preferredWeekday` is deliberately NOT in this list. Clearing it writes an
  // explicit null, because "no day chosen" is an answer the run has to be told;
  // deleting the field would make it indistinguishable from a client who has
  // never seen the form.
  const existing = await getAgentIntake(input.clientId, "newsletter", null);
  if (existing) {
    const drop: Array<"espName" | "audienceNote" | "bannedPhrases" | "openComplianceNote"> = [];
    if (!input.espName.trim() && existing.espName) drop.push("espName");
    if (!input.audienceNote.trim() && existing.audienceNote) drop.push("audienceNote");
    if (!bannedRaw && existing.bannedPhrases?.length) drop.push("bannedPhrases");
    if (!input.openComplianceNote.trim() && existing.openComplianceNote) {
      drop.push("openComplianceNote");
    }
    await clearAgentIntakeFields(existing.id, drop);
  }

  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "newsletter",
    seatId: null,
    // Newsletter has no platform account and no engagement roster. Both are
    // spelled rather than omitted so the shared document never carries another
    // family's leftovers on a client who runs more than one agent.
    handle: null,
    roster: [],
    preferredWeekday,
    ...(input.espName.trim() ? { espName: input.espName.trim() } : {}),
    ...(input.audienceNote.trim() ? { audienceNote: input.audienceNote.trim() } : {}),
    ...(bannedPhrases.length > 0 ? { bannedPhrases } : {}),
    ...(input.openComplianceNote.trim()
      ? { openComplianceNote: input.openComplianceNote.trim() }
      : {}),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/newsletter-agent`);
  // The agents page renders this form inline in the run dialog and derives the
  // run gate from the same document, so it goes stale on every write here.
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ──────────────────── per-issue feedback (the loop) ───────────────── */

/**
 * One row of the newsletter learning log.
 *
 * The action set is narrower than the other three families' on purpose — see
 * `NewsletterDraftFeedback` in types.ts. Nothing here sends anything: "sent"
 * records that a human sent it from their own email platform.
 */
export async function addNewsletterDraftFeedbackAction(input: {
  clientId: string;
  jobId?: string;
  assetId?: string;
  /** The issue this is about, as the run numbered it. */
  issueNumber?: string;
  action: "sent" | "sent_with_edits" | "not_sent" | "note" | "edit_request";
  finalText?: string;
  reason?: string;
  reasonCode?: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (input.action === "sent_with_edits" && !input.finalText?.trim()) {
    return { error: "Paste the issue you actually sent." };
  }
  if (input.action === "not_sent") {
    if (!input.reasonCode || !isReasonCode(input.reasonCode)) {
      return { error: "Pick a reason. That is what teaches the agent." };
    }
    if (!input.reason?.trim()) {
      return { error: "Add a line about why. That is what teaches the agent." };
    }
  }
  if (input.action === "note" && !input.reason?.trim()) {
    return { error: "Write the feedback. As much detail as you like." };
  }
  if (input.action === "edit_request" && !input.reason?.trim()) {
    return { error: "Tell us what to change about this issue." };
  }
  if ((input.finalText?.trim().length ?? 0) > MAX_ISSUE_TEXT) {
    return { error: "That issue is too long to store. Paste the body without the raw HTML." };
  }
  if ((input.reason?.length ?? 0) > MAX_TEXT) {
    return { error: "Please keep the answer under 2,000 characters." };
  }

  await addNewsletterDraftFeedback({
    clientId: input.clientId,
    account: "company",
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.issueNumber?.trim() ? { issueNumber: input.issueNumber.trim() } : {}),
    action: input.action,
    ...(input.finalText?.trim() ? { finalText: input.finalText.trim() } : {}),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    ...(input.action === "not_sent" && input.reasonCode && isReasonCode(input.reasonCode)
      ? { reasonCode: input.reasonCode }
      : {}),
    createdBy: user.uid,
    createdAt: Date.now(),
  });
  revalidatePath(`/clients/${input.clientId}/newsletter-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ─────────────────────────── the setup run ─────────────────────────── */

function setupPrompt(clientName: string): string {
  return [
    `Set up the newsletter agent for ${clientName}.`,
    "",
    "Run the setup skill end to end: read their onboarding documents and their past",
    "newsletters, write the content foundation, distil the voice card from their own",
    "writing, seed the topic pool and the niche watch-list, and stand up the issue",
    "index the weekly runs claim their numbers in.",
    "",
    "If an issue index already exists and holds rows, VERIFY it — never re-seed it.",
    "Those rows are issues that have already gone out to a real mailing list, and",
    "re-seeding would erase them and hand the next run a number that is already used.",
    "",
    "Do not draft or deliver an issue in this run. This is the setup.",
  ].join("\n");
}

/**
 * Fire v2 setup for a client.
 *
 * Its own action rather than the client-agent launch flow, for the same reason
 * `runLinkedInSetupAction` is: setup is a DIFFERENT SKILL in a different
 * directory from the writer, and that flow fires one agent doc and refuses a
 * second launch with "already live". Re-running setup is a normal act here — the
 * framework is written around a re-run that verifies rather than re-seeds.
 *
 * Staff-and-client reachable, like the run dialog. Billing follows the usual
 * rule: `isBillableClientActor` decides inside the submit core.
 */
export async function runNewsletterSetupAction(input: {
  clientId: string;
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const agent = await getCustomAgentByKey(NEWSLETTER_SETUP_V2_KEY);
  if (!agent || !agent.enabled) {
    return { error: "The newsletter setup agent is not available. Your Karos team can enable it." };
  }
  // The submit core's own gate would also catch this, but its sentence explains
  // a gate rather than naming the one thing the reader has to do, and the form
  // is on the same page as the button they just pressed.
  if (!(await getAgentIntake(input.clientId, "newsletter", null))) {
    return { error: "Save your newsletter details below first, so setup knows your rules." };
  }

  const result = await submitCustomAgentJob(user, {
    agentId: agent.id,
    clientId: input.clientId,
    prompt: setupPrompt(client.name),
    runType: "launch",
  });

  if (result.jobId && !result.error) {
    revalidatePath(`/clients/${input.clientId}/newsletter-agent`);
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
