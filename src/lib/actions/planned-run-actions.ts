"use server";

import { revalidatePath } from "next/cache";
import {
  createPlannedScheduledRun,
  deletePlannedScheduledRun,
  getClient,
  getCustomAgent,
  getPlannedScheduledRun,
  listJobs,
  listPlannedScheduledRuns,
  updatePlannedScheduledRun,
} from "@/lib/data";
import { CREDIT_COSTS, isBillableClientActor, scheduledAgentWeeklyCost } from "@/lib/credits";
import { canViewClient } from "@/lib/client-visibility";
import { selectAgentSchedule } from "@/lib/agent-schedule-selection";
import {
  computeNextRun,
  scheduleLimitsFor,
  weeklyCadenceDays,
} from "@/lib/scheduled-runs";
import { isValidTimeZone, runtimeTimeZone } from "@/lib/run-cadence";
import { clientAgentRunRefusal } from "@/lib/client-agent-gate";
import { unfireableScheduleReason } from "@/lib/jobs/schedule-gate";
import type { PlannedRunCadence } from "@/lib/types";
import { logActivity, requireClientAccess, requireStaff } from "./_shared";

const MAX_PROMPT_CHARS = 4_000;

export interface PlannedRunInput {
  clientId: string;
  /** The repo-imported custom agent to fire. */
  customAgentId: string;
  /** Free-text request handed to the agent each run. */
  prompt: string;
  cadence: PlannedRunCadence;
  /** Recurring cadences: local time of day. */
  hour?: number;
  minute?: number;
  /** weekly: 0=Sun … 6=Sat. */
  weekday?: number;
  /** monthly: 1–31. */
  dayOfMonth?: number;
  /** "once" cadence: explicit target time (epoch millis). */
  runAt?: number;
  /**
   * IANA zone the hour/minute are meant in — send the browser's
   * (`Intl.DateTimeFormat().resolvedOptions().timeZone`) so the form's preview
   * and the stored fire time are the same clock. Falls back to the server's own
   * zone, which is what happened implicitly before.
   */
  timeZone?: string;
}

export interface ClientAgentScheduleInput {
  clientId: string;
  customAgentId: string;
  postsPerWeek: number;
  outputsPerRun: number;
  prompt: string;
  hour?: number;
  minute?: number;
  /** IANA zone the hour/minute are meant in — see PlannedRunInput.timeZone. */
  timeZone?: string;
}

/** The zone a schedule's wall clock is stored in: the caller's, else this runtime's. */
function resolveTimeZone(requested: string | undefined): string {
  return isValidTimeZone(requested) ? requested : runtimeTimeZone();
}

/**
 * Staff can act on a client only if admin, or an employee assigned to it.
 *
 * Asks `canViewClient` rather than re-reading `assignedEmployeeIds`, which is
 * what this did: the assignment relationship is recorded on TWO documents (see
 * canViewClient) and a site that reads one of them fences out every employee
 * assigned through the other. That is exactly the drift the shared predicate
 * exists to prevent, and this was the site still drifting.
 *
 * The role test stays where it is — `requireStaff` throws for a CLIENT_USER
 * before the predicate is reached, so the "own client" arm of canViewClient
 * cannot let one in here.
 */
async function authorizeClient(clientId: string) {
  const user = await requireStaff();
  const client = await getClient(clientId);
  if (!client) return { error: "Client not found." as const };
  if (!canViewClient(user, client)) {
    return { error: "You are not assigned to this client." as const };
  }
  return { user, client };
}

/** Creates a planned agent run. Staff-only; any enabled repo agent is schedulable. */
export async function createPlannedRunAction(
  input: PlannedRunInput,
): Promise<{ id?: string; error?: string }> {
  const auth = await authorizeClient(input.clientId);
  if ("error" in auth) return { error: auth.error };

  const agent = await getCustomAgent(input.customAgentId);
  if (!agent || !agent.enabled) return { error: "Agent not found." };
  const blocked = await unfireableScheduleReason(auth.client, agent);
  if (blocked) return { error: blocked };

  const prompt = input.prompt.trim();
  if (!prompt) return { error: "Describe what you want the agent to produce." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).` };
  }

  const now = Date.now();
  const timeZone = resolveTimeZone(input.timeZone);
  let nextRunAt: number;
  let hour: number;
  let minute: number;
  let weekday: number | undefined;
  let dayOfMonth: number | undefined;

  if (input.cadence === "once") {
    if (!input.runAt || input.runAt <= now) {
      return { error: "Pick a future date and time for a one-off run." };
    }
    nextRunAt = input.runAt;
    // A one-off already carries the right instant (the browser resolved the
    // datetime-local field). Only the PRINTED hour was wrong before, because it
    // was re-derived here in the server's zone; read it back in the caller's.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(input.runAt));
    const at = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    hour = at("hour") % 24;
    minute = at("minute");
  } else {
    hour = clampInt(input.hour ?? 9, 0, 23);
    minute = clampInt(input.minute ?? 0, 0, 59);
    if (input.cadence === "weekly") weekday = clampInt(input.weekday ?? 1, 0, 6);
    if (input.cadence === "monthly") dayOfMonth = clampInt(input.dayOfMonth ?? 1, 1, 31);
    nextRunAt = computeNextRun({
      cadence: input.cadence,
      hour,
      minute,
      weekday,
      dayOfMonth,
      from: now,
      timeZone,
    });
  }

  const id = await createPlannedScheduledRun({
    clientId: input.clientId,
    customAgentId: agent.id,
    agentName: agent.name,
    agentIcon: agent.icon,
    agentColor: agent.color,
    prompt,
    cadence: input.cadence,
    hour,
    minute,
    timeZone,
    ...(weekday != null ? { weekday } : {}),
    ...(dayOfMonth != null ? { dayOfMonth } : {}),
    nextRunAt,
    status: "active",
    // Record the billing intent AT CREATION, beside createdBy, the way the
    // client-facing pace dialog does. This path is `requireStaff`, so the
    // answer is always false — but writing it makes the row's intent explicit
    // rather than leaving the cron to infer it from whoever happens to sit in
    // createdBy. An absent flag is the legacy shape the cron still tolerates;
    // a new row should never add to that pile.
    billClientCredits: isBillableClientActor(auth.user),
    createdBy: auth.user.uid,
    createdAt: now,
    updatedAt: now,
  });

  void logActivity({
    clientId: input.clientId,
    timestamp: now,
    type: "CAMPAIGN_CREATED",
    title: `Scheduled ${agent.name} (${input.cadence})`,
    actor: auth.user.name,
    actorRole: "staff",
    metadata: { scheduledRunId: id, customAgentId: agent.id },
  });

  revalidatePath("/calendar");
  revalidatePath(`/clients/${input.clientId}`);
  return { id };
}

/**
 * Creates or updates the single always-on weekly schedule shown on a client's
 * AI Agents card. Client users may configure only agents that have already
 * completed a successful run for their workspace (or were explicitly granted).
 */
export async function configureClientAgentScheduleAction(
  input: ClientAgentScheduleInput,
): Promise<{ id?: string; weeklyCredits?: number; error?: string }> {
  const user = await requireClientAccess(input.clientId);
  const [client, agent] = await Promise.all([
    getClient(input.clientId),
    getCustomAgent(input.customAgentId),
  ]);
  if (!client) return { error: "Client not found." };
  if (!agent || !agent.enabled) return { error: "Agent not found." };

  if (user.role === "CLIENT_USER" && !(client.customAgentIds ?? []).includes(agent.id)) {
    const successful = new Set(["review", "approved", "delivered"]);
    const jobs = await listJobs({ clientId: input.clientId });
    const activated = jobs.some(
      (job) =>
        job.external?.taskType === "custom" &&
        successful.has(job.status) &&
        (job.customAgentId === agent.id || (!job.customAgentId && job.agentName === agent.name)),
    );
    if (!activated) return { error: "Agent not found." };
  }

  // §2 guard rail: setting a pace for an umbrella-bound agent is the client's
  // to do once the agent is live, not before. A schedule written against a
  // not-yet-launched umbrella would start firing paid runs of an agent whose
  // template set nobody has confirmed — and it would do it from a card that is
  // simultaneously telling the client the agent is still being set up.
  const blocked = await clientAgentRunRefusal({
    user,
    clientId: input.clientId,
    customAgentId: input.customAgentId,
  });
  if (blocked) return { error: blocked };

  // The other half of the pair (his layer): a schedule whose agent cannot fire
  // at all — missing intake, an instance bound to another client's slug — must
  // not be written as live either. Complementary, not redundant: the umbrella
  // gate above is about launch state, this one about whether a fire could ever
  // produce anything.
  const unfireable = await unfireableScheduleReason(client, agent);
  if (unfireable) return { error: unfireable };

  const schedules = await listPlannedScheduledRuns({ clientId: input.clientId });
  /**
   * THE ROW THE CARD SHOWED, asked of the same selector the card asks.
   *
   * This matched `cadence === "weekly"` while the read paths were widened to
   * surface daily rows too, and the seam between them was worth real money: the
   * card rendered a daily schedule, so the dialog said "Save pace" and prefilled
   * 7 — but `existing` came back undefined here, Save took the CREATE branch, and
   * the client ended up with a NEW active weekly row beside a daily row that kept
   * firing. Seven billed fires a week became fourteen. `selectAgentSchedule` then
   * preferred the weekly row, so the runaway daily one dropped off the card and
   * could not be paused from it either.
   *
   * `agent-schedule-selection.ts` predicted this exactly ("revisit the moment
   * that action accepts more than weekly") — the two halves were written by
   * different passes and neither owned the join. One selector, two callers, is
   * what makes "the card names the row Save will write" true by construction
   * rather than by two predicates agreeing.
   *
   * The stored `cadence` becomes weekly on save because weekly is the only pace
   * this dialog can express; that CONVERTS the row instead of duplicating it,
   * which is strictly fewer fires than before.
   */
  const selection = selectAgentSchedule(schedules, agent.id);
  const existing = selection?.schedule;

  // Clamped to exactly what the dialog offers. outputsPerRun was capped at 10
  // here while the dialog offered 5, so a stale page or a direct call could
  // schedule twice the outputs the product sells — and the scheduler bills
  // chargeMultiplier = outputsPerRun on every fire.
  //
  // F27: the Reddit agent's ceiling is lower than the generic one and is
  // enforced HERE, not only in the dialog. A reply is a post into someone
  // else's community; the product is one a day, five a week, and the generic
  // 7x5 would both bill for 35 and get the client's account treated as spam by
  // the subreddits the agent is building standing in.
  const limits = scheduleLimitsFor(agent.key);
  const postsPerWeek = clampInt(input.postsPerWeek, 1, limits.maxRunsPerWeek);

  // WHAT A CLIENT MAY CHANGE HERE: the posting days and the time of day. That
  // is the whole of "pace". Two fields are deliberately NOT theirs, and the
  // server preserves the stored values rather than trusting what was submitted:
  //
  //  · outputsPerRun — a staff setting. The client's dialog does not show it,
  //    and a client save that carried a value would rewrite it. It did: the
  //    pace dialog pinned it to 1, so one press cut a 3×5 schedule to 3×1 and
  //    the client silently lost four fifths of what they were paying for.
  //  · prompt — the operator's standing instruction to the agent, written for
  //    the model. A client rewriting it changes what every future run receives.
  //
  // Enforced here rather than only in the dialog because a server action is a
  // public HTTP surface: hiding a control is not the same as refusing a value.
  //
  // The Reddit ceiling overrides even the preserve-the-stored-value rule: a row
  // written before the cap existed (or by a staff member with an older page)
  // holds a number the product does not sell, and re-saving it would re-commit
  // to billing it. Pinned, not clamped — five answers written in one sitting is
  // a different product from one a day, and it is the one automod removes.
  const actorIsClient = user.role === "CLIENT_USER";
  const outputsPerRun = clampInt(
    actorIsClient && existing ? (existing.outputsPerRun ?? 1) : input.outputsPerRun,
    1,
    limits.maxOutputsPerRun,
  );
  const prompt =
    actorIsClient && existing?.prompt?.trim() ? existing.prompt.trim() : input.prompt.trim();
  if (!prompt) return { error: "Describe what the agent should create each time." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).` };
  }

  const hour = clampInt(input.hour ?? 9, 0, 23);
  const minute = clampInt(input.minute ?? 0, 0, 59);
  const weekdays = weeklyCadenceDays(postsPerWeek);
  const now = Date.now();
  const timeZone = resolveTimeZone(input.timeZone);
  // The day that already fired is not on offer again. Recomputing purely from
  // `now` re-arms it: a client on Mon/Wed/Fri 09:00 who opens the pace dialog at
  // 10:00 on a Monday — after that morning's post — and moves the time to 18:00
  // got a SECOND post that evening and a second charge for it. The row carries
  // `lastRunAt` (stamped by the claim transaction that advanced the cursor), so
  // the information was there and unread. `existing` is the row being edited;
  // on a create there is nothing to have fired.
  const nextRunAt = computeNextRun({
    cadence: "weekly",
    hour,
    minute,
    weekdays,
    from: now,
    timeZone,
    ...(existing?.lastRunAt != null ? { lastRunAt: existing.lastRunAt } : {}),
  });
  const weeklyCredits = scheduledAgentWeeklyCost(
    agent.creditCost ?? CREDIT_COSTS.customAgentRun,
    postsPerWeek,
    outputsPerRun,
  );

  const patch = {
    agentName: agent.name,
    agentIcon: agent.icon,
    agentColor: agent.color,
    prompt,
    cadence: "weekly" as const,
    hour,
    minute,
    timeZone,
    weekday: weekdays[0],
    weekdays,
    outputsPerRun,
    // billClientCredits is DELIBERATELY absent from the shared patch — see the
    // note on the create branch below. It is create-only.
    nextRunAt,
    status: "active" as const,
    // The schedule just cleared the setup gate, so a refusal recorded by an
    // earlier fire no longer describes it.
    lastError: null,
    lastErrorAt: null,
    updatedAt: now,
  };

  let id: string;
  if (existing) {
    id = existing.id;
    // An EDIT changes the pace, never who pays for it: `patch` carries no
    // billClientCredits, so the stored flag survives untouched.
    await updatePlannedScheduledRun(existing.id, patch);
  } else {
    id = await createPlannedScheduledRun({
      clientId: input.clientId,
      customAgentId: agent.id,
      ...patch,
      // WHO PAYS is decided ONCE, here, alongside createdBy — and the two are
      // written together so they can never disagree about money.
      //
      // /api/run-scheduled hands this flag to the submit core as the explicit
      // `bill` decision for every fire. It used to be recomputed from whoever
      // pressed Save and written on edits too, while createdBy (the actor the
      // cron resolves) stayed frozen at creation — so the pair drifted and money
      // moved both ways: a client pressing Save on a staff-set pace flipped the
      // flag to true against a staff createdBy, and staff bumping Outputs per
      // run on a client's own schedule flipped it to false while the client was
      // still being charged, at multiplier 1 for N drafts.
      //
      // Same shape as the outputsPerRun/prompt preservation above — the stored
      // value beats whatever the current save implies — with one difference:
      // this is preserved for EVERY actor, not just clients. Staff editing a
      // pace must neither start billing a client nor stop billing one.
      billClientCredits: isBillableClientActor(user),
      createdBy: user.uid,
      createdAt: now,
    });
  }

  void logActivity({
    clientId: input.clientId,
    timestamp: now,
    type: "CAMPAIGN_CREATED",
    // Pace vocabulary, one stored string for both audiences (A3/A4): the old
    // wording decomposed the batch ("3 runs per week (12 drafts)") — that shape
    // is now on the retroactive machinery patterns, and new rows say only the
    // pace. Staff read run/output detail on the schedule row itself.
    title: `Set ${agent.name}'s pace: ${postsPerWeek} posting day${postsPerWeek === 1 ? "" : "s"} a week`,
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: { scheduledRunId: id, customAgentId: agent.id, postsPerWeek, outputsPerRun },
  });

  revalidatePath("/calendar");
  revalidatePath(`/clients/${input.clientId}`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { id, weeklyCredits };
}

/**
 * Pause, resume, or retire a scheduled run.
 *
 * Clients may pause and resume their own — that is reversible, and the calendar
 * and the AI Agents page both offer it. "completed" is NOT client-callable, in
 * EITHER direction: it retires the schedule and drops it off the calendar for
 * good, which is the same irreversible outcome as a delete wearing a different
 * word — and a state only staff may enter is a state only staff may leave.
 */
export async function setPlannedRunStatusAction(
  id: string,
  status: "active" | "paused" | "completed",
): Promise<{ error?: string }> {
  const run = await getPlannedScheduledRun(id);
  if (!run) return { error: "Scheduled run not found." };
  const user = await requireClientAccess(run.clientId);
  // BOTH ends of the transition, not just the requested one. Testing only the
  // REQUESTED status let `completed → active` through for a client: retiring is
  // refused, un-retiring was not, so a client could bring back a schedule staff
  // had ended — on a state this action's own docstring calls the same
  // irreversible outcome as a delete. Staff retire, staff restart.
  if (user.role === "CLIENT_USER") {
    if (status === "completed") {
      return { error: "Ask your Karos contact to retire this schedule." };
    }
    if (run.status === "completed") {
      return { error: "Ask your Karos contact to restart this schedule." };
    }
  }

  // §2 guard rail (D2). Pausing is always allowed — a client may always stop
  // their agent, and refusing that would trap a schedule they want stopped. But
  // RE-ARMING is the same act as setting a pace in the first place: it points
  // paid, recurring fires at an agent whose template set nobody has confirmed.
  // configureClientAgentScheduleAction already refuses that; without the same
  // refusal here a client could simply pause and resume their way past it.
  if (status === "active") {
    const blocked = await clientAgentRunRefusal({
      user,
      clientId: run.clientId,
      customAgentId: run.customAgentId,
    });
    if (blocked) return { error: blocked };
  }

  // Resuming is an enable, so it clears the same gates a create does — a
  // schedule paused while its agent data was emptied, or while its agent moved
  // to another client's folder, must not go back to reading as live. Pausing and
  // cancelling are always allowed. A deleted agent or client has nothing left to
  // test, and that schedule cannot fire anyway.
  if (status === "active") {
    const [agent, client] = await Promise.all([
      getCustomAgent(run.customAgentId),
      getClient(run.clientId),
    ]);
    if (agent && client) {
      const blocked = await unfireableScheduleReason(client, agent);
      if (blocked) return { error: blocked };
    }
  }

  // The hole in the re-anchor below, and the reason it is refused rather than
  // patched: a "once" run stores one explicit instant and has no cadence to
  // re-anchor to, so re-arming one whose time has passed leaves a stale past
  // cursor on an active row — due on the very next tick. The client gets a run
  // they did not ask for now, and pays for it. Inventing a new instant would be
  // a different schedule than the one anybody agreed to, so the answer is no.
  if (status === "active" && run.cadence === "once" && run.nextRunAt <= Date.now()) {
    return {
      error:
        user.role === "CLIENT_USER"
          ? "That one-off run's time has already passed. Ask your Karos contact to schedule a new one."
          : "That one-off run's time has already passed. Create a new one-off run instead.",
    };
  }

  const patch: Record<string, unknown> = { status, updatedAt: Date.now() };
  if (status === "active") {
    patch.lastError = null;
    patch.lastErrorAt = null;
  }
  // Resuming a recurring run: re-anchor its next fire to the future so a stale
  // cursor doesn't fire immediately.
  if (status === "active" && run.cadence !== "once") {
    patch.nextRunAt = computeNextRun({
      cadence: run.cadence,
      hour: run.hour,
      minute: run.minute,
      weekday: run.weekday,
      weekdays: run.weekdays,
      dayOfMonth: run.dayOfMonth,
      from: Date.now(),
      // Re-anchor in the zone the schedule was set in, not this container's.
      ...(run.timeZone ? { timeZone: run.timeZone } : {}),
      // Same rule as the pace edit: a resume must not re-arm a day that already
      // fired and was already charged for.
      ...(run.lastRunAt != null ? { lastRunAt: run.lastRunAt } : {}),
    });
  }
  await updatePlannedScheduledRun(id, patch);
  revalidatePath("/calendar");
  return {};
}

/**
 * Deletes a scheduled run outright. STAFF ONLY — a client's undo for a deleted
 * schedule is a staff member, so the UI's client-facing controls stop at Pause
 * and the server enforces the same rule rather than trusting the button.
 */
export async function deletePlannedRunAction(id: string): Promise<{ error?: string }> {
  const run = await getPlannedScheduledRun(id);
  if (!run) return { error: "Scheduled run not found." };
  await requireStaff();
  await deletePlannedScheduledRun(id);
  revalidatePath("/calendar");
  return {};
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}
