import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { createActivityLog, getClient, getClientTask } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";
import { unmetCampaignDependencyTitles } from "@/lib/campaign-engine";
import type { ActivityLog, AppUser, Client, ClientTask } from "@/lib/types";

import { SYSTEM_AI_ACTOR_NAME, sessionSafeActor } from "@/lib/activity-actors";
import { needsOnboarding } from "@/lib/onboarding";
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

/**
 * WHAT "SCOPED TO SELF" IS ACTUALLY WORTH — the one place that says so.
 *
 * A handful of endpoints authorize by taking the SUBJECT of the write from the
 * session and checking nothing else: the profile action, the avatar route (its
 * comment said "Scoped to self — no clientId or role check needed"), the resume
 * route, the password change, and the three onboarding actions. That model has
 * exactly one assumption — the session's subject IS the actor — and
 * impersonation is the one thing in this app that breaks it. `getCurrentUser`
 * returns the TARGET user under "View as Client" (auth.ts), so every one of
 * those writes lands on the CLIENT's record while an admin is driving: their
 * display name and phone, their avatar and their CV, and the name/photo
 * mirrored onto the client's FIREBASE AUTH identity — with nothing marking the
 * write and no activity row at all.
 *
 * REFUSED, not re-attributed, and the choice matters. Re-attribution is the
 * right answer where the act is legitimate and only the byline is wrong — that
 * is `sessionSafeActor`'s job for the timeline rows below. It is the wrong
 * answer here, because there is nothing legitimate to attribute: "View as
 * Client" exists so staff can SEE what a client sees, and Karos already has a
 * proper surface for editing a person (the team page, `requireAdmin`). An
 * activity row saying an admin replaced a client's CV does not un-replace it,
 * and the Firebase Auth identity has no activity log at all. Refusing also
 * fails closed: a self-write endpoint added tomorrow is safe the moment it
 * takes its user from here, whereas an attribution rule has to be remembered.
 *
 * The three onboarding actions already refused this way, each with its own
 * inline `if (user.impersonatedBy)` and its own sentence — the rule written
 * three times, next to five siblings that did not write it at all. This is
 * that rule, once.
 *
 * NOT the same question as `isBillableClientActor` (which asks who PAYS and
 * deliberately lets the impersonated session through, free) — so both read
 * `impersonatedBy` and neither is the other's answer.
 */
export const IMPERSONATED_SELF_WRITE_MESSAGE =
  "You're viewing this workspace as another person. Exit impersonation before changing their account.";

/**
 * The session whose OWN account a self-scoped endpoint may write to.
 *
 * ONE function rather than a result form plus a throwing wrapper: half its
 * callers are Route Handlers that need a status code and half are server
 * actions that throw, and a wrapper that re-derived the status from the thrown
 * message would key a guard to a string. The three lines at each action site
 * are plumbing; the rule and the sentence live only here.
 */
export async function ownAccountSession(): Promise<
  { ok: true; user: AppUser } | { ok: false; error: string; status: 401 | 403 }
> {
  const user = await getCurrentUser();
  if (!user || user.disabled) return { ok: false, error: "Unauthorized", status: 401 };
  if (user.impersonatedBy) {
    return { ok: false, error: IMPERSONATED_SELF_WRITE_MESSAGE, status: 403 };
  }
  return { ok: true, user };
}

/**
 * WHICH CLIENT AN ALREADY-AUTHORIZED SESSION MAY ACT ON — the assignment half,
 * asked of the predicate the whole campaign asks (`canViewClient`).
 *
 * `requireStaff` and `requireClientAccess` above answer a ROLE question. Neither
 * answers "which clients", and `requireClientAccess` says so in its own comment:
 * staff pass for ANY client. That is the gap this closes at its callers — an
 * employee `notFound()`ed on `/clients/C` and refused by every `/api/clients/C`
 * route could still reach C's data through an action that only asked the role.
 *
 * Returns a message rather than throwing, because these actions return
 * `{ error }` and several render it verbatim.
 *
 * BOTH SENTENCES ADDRESS STAFF, and that is checked rather than assumed: every
 * caller resolves its user through `requireStaff` (which refuses a CLIENT_USER
 * outright) or `requireClientAccess` (which refuses a CLIENT_USER for any client
 * but their own — and their own is exactly the case `canViewClient` passes). So
 * a CLIENT_USER cannot reach either refusal today. A future caller that admits
 * one needs its own sentence, the same way TASK_NOT_IN_REVIEW_MESSAGE exists.
 *
 * TWO SENTENCES, and NOT the one-answer idiom `requireVisibleClient` uses. That
 * idiom exists so a refusal cannot be an oracle for which client ids are real,
 * and it is right where a CLIENT_USER can reach the answer. Here both readers
 * are staff, and the two conditions want opposite remedies: a missing client is
 * a stale link, while an unassigned one is a person who needs to be assigned —
 * and "You are not assigned to this client." is FALSE for an admin, who is
 * assigned to everything and can only ever be refused by the first branch. A
 * shared sentence would be false at one of the two sites, which is the whole
 * argument the TASK_* pair above makes.
 *
 * Takes the client DOCUMENT, not an id: every caller has already loaded it, and
 * a predicate that fetches its own subject hides a Firestore read inside what
 * reads as a test.
 */
export const CLIENT_NOT_FOUND_MESSAGE = "Client not found.";
export const NOT_ASSIGNED_TO_CLIENT_MESSAGE = "You are not assigned to this client.";

export function clientAccessRefusal(
  user: AppUser,
  client: Pick<Client, "id" | "assignedEmployeeIds"> | null | undefined,
): string | null {
  if (!client) return CLIENT_NOT_FOUND_MESSAGE;
  if (!canViewClient(user, client)) return NOT_ASSIGNED_TO_CLIENT_MESSAGE;
  return null;
}

/**
 * The gate for work a client account may have done FOR IT EXACTLY ONCE.
 *
 * Sits alongside requireStaff/requireAdmin because it answers the same kind of
 * question — may this session reach the work behind me — and it is the only
 * thing standing between a client and the AI provisioning pipeline. Onboarding
 * is free by design (a client should not spend credits being set up), and that
 * decision is only affordable because it cannot be replayed.
 *
 * `hasCompletedOnboarding` was already the wizard's own predicate, but only the
 * (app) layout's redirect enforced it. A redirect is not a gate: a server action
 * is network-reachable directly, so an already-onboarded client could re-post
 * `completeOnboardingAction` and re-fire the intel pipeline plus a full swarm,
 * free and unlimited, as often as they liked. The AI-processing lock does not
 * close it either — that stops CONCURRENT runs, not sequential ones.
 */
export async function requireFirstOnboarding(user: AppUser): Promise<void> {
  if (!needsOnboarding(user)) throw new Error("This workspace has already been set up.");
}

/**
 * Allows both staff (assigned to this client) and a CLIENT_USER (own client
 * only).
 *
 * D-77 (2026-08): "ANY CLIENT" USED TO BE THE WHOLE ROLE ANSWER, NOT THE
 * WHOLE RULE. An employee assigned to nobody passed this for every client in
 * the system, while the `/clients/[id]` pages `notFound()`ed them and every
 * `/api/clients/[id]` route refused them — the exact gap `clientAccessRefusal`
 * exists to close, previously paired in by hand at only 2 of this function's
 * ~30 call sites (planned-run-actions.ts). Folding the pairing in here closes
 * all of them at once, which is the point: a caller cannot forget a check it
 * never had to remember to make.
 *
 * The extra `getClient` read only runs on the STAFF branch — a CLIENT_USER's
 * own-client check needs no document, same as before this change, so that
 * path's cost and behavior are unchanged.
 */
export async function requireClientAccess(clientId: string): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff) {
    if (user.role !== "CLIENT_USER" || user.clientId !== clientId) throw new Error("Forbidden");
    return user;
  }
  const client = await getClient(clientId);
  const refusal = clientAccessRefusal(user, client);
  if (refusal) throw new Error(refusal);
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
  "This task is no longer waiting for review. It may have just been approved somewhere else. Refresh to see where it is now.";

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

/**
 * The title of a campaign dependency this task is still waiting on (e.g. the
 * newsletter waiting on the anchor blog), or null when it's clear to execute.
 * Every choke point that triggers a karos_managed run into in_progress calls
 * this before claiming, so a campaign step can never run ahead of the piece
 * it depends on — mirrors the claim-before-charge ordering those call sites
 * already use (a premature attempt costs nothing).
 */
export async function campaignDependencyBlocker(task: ClientTask): Promise<string | null> {
  if (!task.campaignId || !task.dependsOnTaskIds?.length) return null;
  const deps = await Promise.all(task.dependsOnTaskIds.map((id) => getClientTask(id)));
  const tasksById = new Map(
    deps.filter((d): d is ClientTask => !!d).map((d) => [d.id, d]),
  );
  const blockers = unmetCampaignDependencyTitles(task, tasksById);
  return blockers.length > 0 ? blockers[0] : null;
}

/**
 * Fire-and-forget activity log writer. Never throws — never blocks the caller.
 *
 * THE funnel, which is why the impersonation correction is applied here rather
 * than at each writer: fifteen call sites across nine modules build these rows,
 * every one of them reaches Firestore through this function, and the ones that
 * get the attribution wrong are precisely the ones that derive it from the
 * session. Correcting at the writers would be fifteen edits that a sixteenth
 * writer inherits none of. See sessionSafeActor for the rule and for what it
 * deliberately leaves alone.
 *
 * The session is resolved ONLY for a row claiming the client acted — the one
 * claim impersonation can falsify — so system rows, staff rows, and every
 * cron-written row cost nothing extra.
 *
 * If the session cannot be resolved the row is written as the caller built it.
 * That is not a fail-open guard, because this is attribution and not
 * authorization: the alternative is dropping a real event from the trail, and
 * `getCurrentUser` returning nothing on a row that claims a CLIENT_USER acted
 * means the request had no session to impersonate from.
 */
export async function logActivity(input: Omit<ActivityLog, "id">): Promise<void> {
  try {
    // Written as a plain forward of this function's own parameter into the
    // Firestore writer, and it has to stay one: client-copy-boundary.test.ts
    // recognises a persisting WRAPPER by exactly that shape, and it is how
    // every copy literal at the fifteen `logActivity(...)` call sites gets
    // swept at all. Folding the correction into the call argument dropped
    // `logActivity` out of that scan — silently, until four of its assertions
    // went red. Rename either binding and it reds again.
    const data = await honestlyAttributed(input);
    await createActivityLog(data);
  } catch {
    // Non-fatal
  }
}

async function honestlyAttributed(input: Omit<ActivityLog, "id">): Promise<Omit<ActivityLog, "id">> {
  if (input.actorRole !== "client") return input;
  try {
    return sessionSafeActor(input, await getCurrentUser());
  } catch {
    return input;
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
