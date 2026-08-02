"use server";

/**
 * Reddit agent (e15) intake actions: the company-account form and per-draft
 * feedback. ASK-only fields per the input contract — the subreddit roster
 * proper, the answer formulas, the voice profile and the recurring-question
 * pool are all BUILT by the agent from the client's audience and category.
 * The form only collects what the agent cannot discover: which account we
 * draft as, an honest read of its history, where the client has already been
 * burned, and the disclosure wording they are comfortable with.
 *
 * Reddit has NO seats. The lab contract manages accounts per client (a founder
 * or employee account, a disclosed brand account, or both) and its voice
 * profile is per account, but the portal collects a single company-account
 * intake for now — so every write here is the seatId-null doc, which is also
 * the doc the run gate reads.
 *
 * Reddit shares no news drop: it answers recurring questions, it does not
 * broadcast company news. That is why there is deliberately no Reddit news
 * action and why these writes never revalidate the X or LinkedIn pages.
 */

import { revalidatePath } from "next/cache";
import {
  addRedditDraftFeedback,
  clearAgentIntakeFields,
  getAgentIntake,
  getClient,
  upsertAgentIntake,
} from "@/lib/data";
import {
  REDDIT_COMMENT_CAP,
  parseRedditThreadUrl,
  parseRedditUsername,
  parseSubredditList,
} from "@/lib/reddit-drafts";
import { requireClientAccess } from "./_shared";

const MAX_TEXT = 2_000;

/** The closed reason set the weekly manager aggregates per subreddit. */
const NOT_POSTED_REASON_CODES = [
  "too_promotional",
  "wrong_subreddit",
  "thread_died",
  "rules",
  "removed",
  "other",
] as const;

type NotPostedReasonCode = (typeof NOT_POSTED_REASON_CODES)[number];

function isReasonCode(value: string): value is NotPostedReasonCode {
  return (NOT_POSTED_REASON_CODES as readonly string[]).includes(value);
}

/* ─────────────────────────── the form ─────────────────────────── */

/**
 * Every answer is OPTIONAL. Saving the form — even empty — is what satisfies
 * the run gate, the same deliberate portal policy the X and LinkedIn agents
 * use: the lab contract would let a run start from onboarding alone, but this
 * portal wants a person to have seen the data first. An empty save still
 * yields a warming-mode, value-only program, which is the safe direction.
 */
export async function saveRedditCompanyIntakeAction(input: {
  clientId: string;
  /** The account we draft as (u/username). Empty = none nominated yet. */
  username: string;
  /** An honest read of that account's karma, age and prior participation. */
  accountHistory: string;
  /** Subreddits the client already participates in — a research starting point. */
  subreddits: string;
  /** Subreddits that are off-limits (burned or banned there). Binding. */
  offLimitsSubreddits: string;
  /** The disclosure wording the client is comfortable with. */
  disclosurePosture: string;
  /** Anything we must never say. */
  offLimits: string;
  /** "" = let the agent decide from the history, else the client's override. */
  mode: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (!(await getClient(input.clientId))) return { error: "Client not found." };
  for (const value of [
    input.accountHistory,
    input.disclosurePosture,
    input.offLimits,
    input.subreddits,
    input.offLimitsSubreddits,
  ]) {
    if (value.length > MAX_TEXT) return { error: "Please keep each answer under 2,000 characters." };
  }
  const username = parseRedditUsername(input.username);
  if (username !== null && typeof username === "object") return username;
  const mode = input.mode === "warming" || input.mode === "established" ? input.mode : undefined;
  const subredditsRaw = input.subreddits.trim();
  const offLimitsRaw = input.offLimitsSubreddits.trim();
  const subreddits = parseSubredditList(input.subreddits);
  const offLimitsSubreddits = parseSubredditList(input.offLimitsSubreddits);

  // An answer we cannot read is a misunderstanding, not a blank. Ask rather
  // than store nothing — silently keeping none of a BINDING off-limits list is
  // the failure that gets an account banned in a subreddit it was banned from.
  if (subredditsRaw && subreddits.length === 0) {
    return {
      error:
        "We could not read a subreddit in that list. Write them as names, like r/SaaS, r/marketing.",
    };
  }
  if (offLimitsRaw && offLimitsSubreddits.length === 0) {
    return {
      error:
        "We could not read a subreddit in the list to stay out of. Write them as names, like r/SaaS, r/marketing. You can add why after them.",
    };
  }

  // The upsert MERGES, so an answer the client cleared would otherwise keep
  // steering every future run. A stale "established" mode or a dropped
  // off-limits subreddit is the failure that gets an account banned, so the
  // deletes happen before the write.
  //
  // Every condition keys on the RAW input being blank, never on a parse result.
  // Keying the two list fields on their parsed length would turn an answer we
  // failed to parse into a delete — and the guards above only hold while they
  // and the drop below agree on what "the client cleared this" means.
  const existing = await getAgentIntake(input.clientId, "reddit", null);
  if (existing) {
    const drop: Array<
      "accountHistory" | "subreddits" | "offLimitsSubreddits" | "disclosurePosture" | "mode"
    > = [];
    if (!input.accountHistory.trim() && existing.accountHistory) drop.push("accountHistory");
    if (!subredditsRaw && existing.subreddits?.length) drop.push("subreddits");
    if (!offLimitsRaw && existing.offLimitsSubreddits?.length) drop.push("offLimitsSubreddits");
    if (!input.disclosurePosture.trim() && existing.disclosurePosture) drop.push("disclosurePosture");
    if (!mode && existing.mode) drop.push("mode");
    await clearAgentIntakeFields(existing.id, drop);
  }

  await upsertAgentIntake({
    clientId: input.clientId,
    agent: "reddit",
    seatId: null,
    handle: username,
    offLimits: input.offLimits.trim(),
    roster: [],
    ...(input.accountHistory.trim() ? { accountHistory: input.accountHistory.trim() } : {}),
    ...(subreddits.length > 0 ? { subreddits } : {}),
    ...(offLimitsSubreddits.length > 0 ? { offLimitsSubreddits } : {}),
    ...(input.disclosurePosture.trim() ? { disclosurePosture: input.disclosurePosture.trim() } : {}),
    ...(mode ? { mode } : {}),
    createdBy: user.uid,
  });
  revalidatePath(`/clients/${input.clientId}/reddit-agent`);
  // The AI Agents page renders this form inline in the agent's run dialog and
  // derives the run gate from the same doc, so it goes stale on every write here.
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ──────────────────── per-draft feedback (the loop) ───────────────── */

/**
 * The four outcome actions from the lab's portal contract, plus "note" for
 * free-form feedback. `reasonCode` is validated against the closed set because
 * the weekly manager acts on it mechanically — two "too_promotional" rows on
 * one subreddit downgrade that subreddit to value-only — and a code that
 * silently degraded to prose would break that.
 *
 * Nothing here posts to Reddit. "posted" records that a human posted.
 */
export async function addRedditDraftFeedbackAction(input: {
  clientId: string;
  /** "company" (the default), "program" (applies to every account), or a seat id. */
  account?: string;
  /** Alternative to `account`: the batch section title — Reddit has no seats, so this resolves to "company". */
  accountTitle?: string;
  jobId?: string;
  assetId?: string;
  draftRef?: string;
  action: "posted" | "posted_with_edits" | "not_posted" | "note" | "edit_request";
  finalText?: string;
  reason?: string;
  reasonCode?: string;
  subreddit?: string;
  threadUrl?: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  // Reddit collects one company-account intake and has no seats, so a section
  // title never needs resolving against clientSeats the way LinkedIn's does.
  const account = input.account ?? "company";
  if (account !== "company" && account !== "program") {
    return { error: "Account not found." };
  }
  if (input.action === "posted_with_edits" && !input.finalText?.trim()) {
    return { error: "Paste the reply you actually posted." };
  }
  if (input.action === "not_posted") {
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
    return { error: "Tell us what to change about this draft." };
  }
  if ((input.finalText?.trim().length ?? 0) > REDDIT_COMMENT_CAP) {
    return { error: "Please keep the reply under 10,000 characters (Reddit's comment cap)." };
  }
  if ((input.reason?.length ?? 0) > MAX_TEXT) {
    return { error: "Please keep the answer under 2,000 characters." };
  }
  // The thread URL arrives from parsed model output; store it only if it is
  // genuinely a reddit.com link so the audit trail cannot carry an off-site one.
  const threadUrl = input.threadUrl ? parseRedditThreadUrl(input.threadUrl) : null;

  await addRedditDraftFeedback({
    clientId: input.clientId,
    account,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.draftRef?.trim() ? { draftRef: input.draftRef.trim() } : {}),
    action: input.action,
    ...(input.finalText?.trim() ? { finalText: input.finalText.trim() } : {}),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    ...(input.action === "not_posted" && input.reasonCode && isReasonCode(input.reasonCode)
      ? { reasonCode: input.reasonCode }
      : {}),
    ...(input.subreddit?.trim() ? { subreddit: input.subreddit.trim() } : {}),
    ...(threadUrl ? { threadUrl } : {}),
    createdBy: user.uid,
    createdAt: Date.now(),
  });
  revalidatePath(`/clients/${input.clientId}/reddit-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}
