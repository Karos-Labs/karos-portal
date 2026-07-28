"use server";

import { revalidatePath } from "next/cache";

import {
  createClientAgentFeedback,
  getClientAgent,
  getClientAgentFeedback,
  listClientAgentFeedback,
  updateClientAgentFeedback,
} from "@/lib/data-client-agents";
import {
  MAX_FEEDBACK_CHARS,
  clampFeedbackText,
  validateFeedbackScope,
  type FeedbackScope,
} from "@/lib/client-agent-feedback";
import { logActivity, requireClientAccess, requireStaff } from "./_shared";
import type { AppUser, ClientAgent, ClientAgentFeedback } from "@/lib/types";

/**
 * Two-level client-agent feedback (Phase 3 §5, CD-A2).
 *
 * Global feedback shapes everything the agent makes; template feedback shapes
 * one stream. Both are stored, both are visible to client and staff, and both
 * are consumed by run-day generation through the existing context_files seam
 * (the builder is agent-service/client-agent-feedback-context.ts, attached in
 * the submit core beside the X agent's intake — one mechanism, not two).
 *
 * Authorization: writing feedback about your own agent is a CLIENT action
 * (requireClientAccess). Resolving a row is a STAFF action — "resolved" means
 * "we have addressed this", which is a claim only the people who addressed it
 * can make, and it silently stops the row being injected into runs.
 */

/**
 * Per umbrella, so one client cannot make another client's agent unwritable.
 *
 * Counted over OPEN rows only (D4). Counting every row ever written made the
 * cap a lifetime quota: an agent that had been given feedback and had all of it
 * addressed for a year would refuse new notes forever, and the only advice the
 * error could offer — resolve some — would already be done. Resolved and
 * withdrawn rows are history; they cost nothing at run time (they are not
 * injected) and they are not what the cap is defending against, which is an
 * unbounded ACTIVE set inflating every read.
 */
const MAX_OPEN_ROWS_PER_UMBRELLA = 200;

async function loadUmbrella(
  clientAgentId: string,
  clientId: string,
): Promise<{ ok: true; user: AppUser; umbrella: ClientAgent } | { ok: false; error: string }> {
  const user = await requireClientAccess(clientId);
  const umbrella = await getClientAgent(clientAgentId);
  // Same answer for "missing" and "another client's": the browser supplies both
  // ids, so a foreign umbrella id paired with an own clientId must not confirm
  // that the foreign one exists.
  if (!umbrella || umbrella.clientId !== clientId) return { ok: false, error: "Agent not found." };
  return { ok: true, user, umbrella };
}

function roleOf(user: AppUser): ClientAgentFeedback["creatorRole"] {
  return user.role === "CLIENT_USER" ? "client" : "staff";
}

/* ─────────────────────────────── create ─────────────────────────────── */

export async function addClientAgentFeedbackAction(input: {
  clientId: string;
  clientAgentId: string;
  scope: FeedbackScope;
  templateKey?: string | null;
  text: string;
}): Promise<{ id?: string; error?: string }> {
  const loaded = await loadUmbrella(input.clientAgentId, input.clientId);
  if (!loaded.ok) return { error: loaded.error };
  const { user, umbrella } = loaded;

  const text = clampFeedbackText(input.text);
  if (!text) return { error: "Write what you'd like this agent to do differently." };

  const scope = validateFeedbackScope({
    scope: input.scope,
    templateKey: input.templateKey ?? null,
    templates: umbrella.templates,
  });
  if (!scope.ok) return { error: scope.error };

  // A bound collection, not a bounded injection only: the injection cap (50)
  // stops a huge list inflating every prompt, but without a write cap the
  // active set grows forever behind it and every read pays for it.
  const open = await listClientAgentFeedback({ clientAgentId: umbrella.id, status: "active" });
  if (open.length >= MAX_OPEN_ROWS_PER_UMBRELLA) {
    // Names actions that EXIST for the person reading it: a client can withdraw
    // their own notes, staff can mark any of them resolved. The old copy told
    // clients to "resolve" — a control they have never been shown.
    return {
      error:
        user.role === "CLIENT_USER"
          ? "This agent is holding as many open notes as it can. Withdraw a few you no longer need, or ask your Karos team to close some out."
          : "This agent is holding as many open notes as it can. Mark some resolved to make room.",
    };
  }

  const now = Date.now();
  const id = await createClientAgentFeedback({
    clientId: input.clientId,
    clientAgentId: umbrella.id,
    scope: scope.templateKey ? "template" : "agent",
    templateKey: scope.templateKey,
    text,
    status: "active",
    createdBy: user.uid,
    createdByName: user.name,
    creatorRole: roleOf(user),
    createdAt: now,
    updatedAt: now,
  });

  void logActivity({
    clientId: input.clientId,
    timestamp: now,
    type: "CAMPAIGN_CREATED",
    title: scope.templateKey
      ? `Feedback on ${umbrella.displayName} · ${scope.templateKey}`
      : `Feedback on ${umbrella.displayName}`,
    actor: user.name,
    actorRole: roleOf(user),
    metadata: { clientAgentId: umbrella.id, feedbackId: id, scope: input.scope },
  });
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { id };
}

/* ─────────────────────────────── update ─────────────────────────────── */

/**
 * Edit the text of a feedback row. A client may edit their OWN rows; staff may
 * edit any — including a client's, because staff routinely tighten a note into
 * something the agent can act on and the row is a shared working record, not a
 * private message. The author and the role stay as written either way.
 */
export async function updateClientAgentFeedbackAction(input: {
  clientId: string;
  feedbackId: string;
  text: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const row = await getClientAgentFeedback(input.feedbackId);
  if (!row || row.clientId !== input.clientId) return { error: "Feedback not found." };
  if (user.role === "CLIENT_USER" && row.createdBy !== user.uid) {
    return { error: "Only the person who wrote a note can change it." };
  }
  const text = clampFeedbackText(input.text);
  // "or delete the note" advised an action that does not exist anywhere (D4):
  // there is no delete, by design — see withdrawClientAgentFeedbackAction.
  if (!text) {
    return {
      error: `Write up to ${MAX_FEEDBACK_CHARS} characters, or withdraw the note if you no longer want it applied.`,
    };
  }
  await updateClientAgentFeedback(row.id, { text });
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/**
 * Withdraw your own note: it stops shaping runs immediately and stays in the
 * list marked withdrawn.
 *
 * Not a hard delete, deliberately. A note the client wrote and then took back
 * is part of the record of what they asked for — staff may have already acted
 * on it — and the injection cap is what the withdrawal is actually for. Only
 * the author may withdraw; staff use `setClientAgentFeedbackStatusAction`,
 * which says "we addressed this" rather than "this was never said".
 *
 * It writes `withdrawn`, not `resolved` (D7). Both stop injection, so the two
 * behave identically at run time — but "resolved" is a claim that Karos acted,
 * and stamping it on the client's own retraction told them their note had been
 * handled when nobody had looked at it.
 */
export async function withdrawClientAgentFeedbackAction(input: {
  clientId: string;
  feedbackId: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const row = await getClientAgentFeedback(input.feedbackId);
  if (!row || row.clientId !== input.clientId) return { error: "Feedback not found." };
  if (row.createdBy !== user.uid) {
    return { error: "Only the person who wrote a note can withdraw it — staff can resolve it instead." };
  }
  await updateClientAgentFeedback(row.id, { status: "withdrawn" });
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/* ────────────────────────────── resolve ─────────────────────────────── */

/**
 * Staff mark a note resolved (kept in the list, no longer injected into runs)
 * or re-open it.
 *
 * The status is narrowed to the two states staff may actually author: only the
 * note's writer can withdraw, so staff cannot stamp someone's note "withdrawn"
 * — and a note the client has already withdrawn cannot be re-opened by staff
 * either, since that would put words back into every future run that the person
 * who wrote them has explicitly taken back.
 */
export async function setClientAgentFeedbackStatusAction(input: {
  feedbackId: string;
  status: Extract<ClientAgentFeedback["status"], "active" | "resolved">;
}): Promise<{ error?: string }> {
  await requireStaff();
  // The type above narrows callers we compile; this narrows callers we do not.
  // A server action is a public HTTP endpoint — the parameter types are erased
  // at runtime, so "withdrawn" (or anything else) posted directly would have
  // been written straight through to the document. Validated as an allowlist so
  // a status added later has to be opted in here deliberately.
  if (input.status !== "active" && input.status !== "resolved") {
    return { error: "A note can only be re-opened or marked resolved." };
  }
  const row = await getClientAgentFeedback(input.feedbackId);
  if (!row) return { error: "Feedback not found." };
  if (row.status === "withdrawn") {
    return { error: "The person who wrote this note withdrew it — only they can raise it again." };
  }
  await updateClientAgentFeedback(row.id, { status: input.status });
  revalidatePath(`/clients/${row.clientId}/agents`);
  return {};
}
