import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { createActivityLog, getClientTask } from "@/lib/data";
import type { ActivityLog, AppUser, ClientTask } from "@/lib/types";

import { SYSTEM_AI_ACTOR_NAME } from "@/lib/activity-actors";
export async function requireStaff(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") throw new Error("Forbidden");
  return user;
}

export async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "KAROS_ADMIN") throw new Error("Forbidden");
  return user;
}

/** Allows both staff (any client) and a CLIENT_USER (own client only). */
export async function requireClientAccess(clientId: string): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff) {
    if (user.role !== "CLIENT_USER" || user.clientId !== clientId) throw new Error("Forbidden");
  }
  return user;
}

/**
 * Two sentences, because there are two different things that happen, and one of
 * them is a LOST RACE and the other is not.
 *
 * `requireTaskAccess` below already states the rule for this whole family —
 * these strings are RETURNED and rendered verbatim, so they are client copy and
 * the status vocabulary stays in the logs. Five refusals in execution-actions.ts
 * broke that in the same way, returning the Firestore enum as prose ("Task is
 * not in review_pending state") on paths a CLIENT_USER reaches. The rule's home
 * is the module that states it, so the sentences live here.
 *
 * Neither NAMES the state. There is no client register for `TaskStatus` to
 * launder it through, and inventing a fourth status-copy module for one sentence
 * would be a second home for a rule that already has one. What the client needs
 * is what happened and what to do, which these say without the enum.
 *
 * WHY TWO. Consolidating first produced one sentence for all five sites, and it
 * was false at one of them. Three sites are genuine races: an atomic claim
 * (`claimTaskCompletion` / `claimTaskForExecution`) returned nothing, which can
 * only mean the task WAS in review and something else took it — "no longer
 * waiting for review" is exactly right. The fourth,
 * `publishIntegrationAction`'s `preflight.status !== "review_pending"`, is a
 * PREFLIGHT: it fires for a task still `pending`, or one finished last week, or
 * one that never reached review at all. "No longer" asserts a past that may
 * never have existed. A shared sentence has to be true at every site it serves,
 * so the site whose condition is different gets its own.
 */
export const TASK_LEFT_REVIEW_MESSAGE =
  "This task is no longer waiting for review — it may have just been approved somewhere else. Refresh to see where it is now.";

/** The preflight sibling: this task is not AT the review step, however it got there. */
export const TASK_NOT_IN_REVIEW_MESSAGE =
  "This task isn't at the review step, so there's nothing to send yet. Refresh to see where it is now.";

/**
 * Task-level authorization for the task-board actions. Resolves the task and
 * verifies it actually belongs to the given clientId — the browser supplies
 * both ids, so checking the user against the clientId param alone would let a
 * CLIENT_USER operate on another client's task by pairing a foreign task id
 * with their own clientId. Staff pass for any client; a CLIENT_USER only for
 * their own. Returns an error result (not a throw) to match the actions'
 * `{ ok, error }` contract.
 */
export async function requireTaskAccess(
  taskId: string,
  clientId: string,
): Promise<{ ok: true; user: AppUser; task: ClientTask } | { ok: false; error: string }> {
  // These strings are RETURNED, not thrown, so several client surfaces render
  // them verbatim in an error banner — they are client copy and are written as
  // sentences, not as HTTP words. The status vocabulary stays in the logs.
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return { ok: false, error: "Your session has expired. Sign in again to continue." };
  }

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && (user.role !== "CLIENT_USER" || user.clientId !== clientId)) {
    return { ok: false, error: "You do not have access to this task." };
  }

  const task = await getClientTask(taskId);
  // Same response for "missing" and "belongs to another client" — don't leak
  // which foreign task ids exist.
  if (!task || task.clientId !== clientId) return { ok: false, error: "This task no longer exists." };

  return { ok: true, user, task };
}

/** Fire-and-forget activity log writer. Never throws — never blocks the caller. */
export async function logActivity(data: Omit<ActivityLog, "id">): Promise<void> {
  try {
    await createActivityLog(data);
  } catch {
    // Non-fatal
  }
}

/**
 * Record a failed workspace-generation cycle.
 *
 * The client-facing banner says the team has been notified, but releasing the
 * processing lock only wrote an error string onto the client record, whose only
 * readers were that same banner and one staff page (QA F69). An activity entry
 * puts the failure on the timeline both staff and the client already read, and
 * the /clients list badges it.
 */
export async function logGenerationFailure(clientId: string, failure?: string): Promise<void> {
  if (!failure) return;
  await logActivity({
    clientId,
    timestamp: Date.now(),
    type: "INTEL_GENERATION",
    // Client copy: this row stays on a client's timeline (it is not machinery —
    // something happened to their account). "Generation" is the pipeline's word
    // for itself, not theirs. Kept GENERAL on purpose: several callers reach here
    // (onboarding, client creation, the intel regenerate and its cron, the task
    // swarm), so naming any one pipeline would be false at the others.
    // The stored rows still say "Workspace generation stopped early"; nothing
    // matches on either spelling, so both simply render as written.
    title: "Workspace update didn't finish",
    // NOT the raw error text, and not in metadata either: the whole activity
    // log crosses into the client's RSC payload (the timeline filters only
    // MANUAL_NOTE for client viewers), and these strings are stack-ish
    // internals — provider errors, model ids, payload fragments. The reason
    // stays on the client record, and toClientPortalView keeps it there: a
    // client viewer's projection carries only the `aiProcessingFailed` boolean,
    // so the readers of the string really are staff-only — the admin banner and
    // the /clients "Generation failed" badge. (It was NOT staff-only when this
    // comment was written: the projection opted the raw string into the client
    // portal view, where both readers merely tested it for truthiness.)
    description: "Your Karos team can see the details and is on it.",
    actor: SYSTEM_AI_ACTOR_NAME,
    actorRole: "system",
  });
}
