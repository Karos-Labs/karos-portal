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
import {
  computeNextRun,
  MAX_OUTPUTS_PER_RUN,
  MAX_RUNS_PER_WEEK,
  weeklyCadenceDays,
} from "@/lib/scheduled-runs";
import { isValidTimeZone, runtimeTimeZone } from "@/lib/run-cadence";
import { clientAgentRunRefusal } from "@/lib/client-agent-gate";
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

/** Staff can act on a client only if admin, or an employee assigned to it. */
async function authorizeClient(clientId: string) {
  const user = await requireStaff();
  const client = await getClient(clientId);
  if (!client) return { error: "Client not found." as const };
  if (user.role === "KAROS_EMPLOYEE" && !(client.assignedEmployeeIds ?? []).includes(user.uid)) {
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

  const schedules = await listPlannedScheduledRuns({ clientId: input.clientId });
  const existing = schedules.find(
    (run) => run.customAgentId === agent.id && run.cadence === "weekly" && run.status !== "completed",
  );

  // Clamped to exactly what the dialog offers. outputsPerRun was capped at 10
  // here while the dialog offered 5, so a stale page or a direct call could
  // schedule twice the outputs the product sells — and the scheduler bills
  // chargeMultiplier = outputsPerRun on every fire.
  const postsPerWeek = clampInt(input.postsPerWeek, 1, MAX_RUNS_PER_WEEK);

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
  const actorIsClient = user.role === "CLIENT_USER";
  const outputsPerRun =
    actorIsClient && existing
      ? (existing.outputsPerRun ?? 1)
      : clampInt(input.outputsPerRun, 1, MAX_OUTPUTS_PER_RUN);
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
  const nextRunAt = computeNextRun({
    cadence: "weekly",
    hour,
    minute,
    weekdays,
    from: now,
    timeZone,
  });
  const billClientCredits = isBillableClientActor(user);
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
    billClientCredits,
    nextRunAt,
    status: "active" as const,
    updatedAt: now,
  };

  let id: string;
  if (existing) {
    id = existing.id;
    await updatePlannedScheduledRun(existing.id, patch);
  } else {
    id = await createPlannedScheduledRun({
      clientId: input.clientId,
      customAgentId: agent.id,
      ...patch,
      createdBy: user.uid,
      createdAt: now,
    });
  }

  void logActivity({
    clientId: input.clientId,
    timestamp: now,
    type: "CAMPAIGN_CREATED",
    // Runs, not posts: postsPerWeek counts the days the agent fires, and each
    // fire produces outputsPerRun items. The field name is persisted and read
    // in several places, so only the wording moves.
    title:
      `Set ${agent.name} to ${postsPerWeek} run${postsPerWeek === 1 ? "" : "s"} per week ` +
      `(${postsPerWeek * outputsPerRun} draft${postsPerWeek * outputsPerRun === 1 ? "" : "s"})`,
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
 * and the AI Agents page both offer it. "completed" is NOT client-callable:
 * it retires the schedule and drops it off the calendar for good, which is the
 * same irreversible outcome as a delete wearing a different word.
 */
export async function setPlannedRunStatusAction(
  id: string,
  status: "active" | "paused" | "completed",
): Promise<{ error?: string }> {
  const run = await getPlannedScheduledRun(id);
  if (!run) return { error: "Scheduled run not found." };
  const user = await requireClientAccess(run.clientId);
  if (user.role === "CLIENT_USER" && status !== "paused" && status !== "active") {
    return { error: "Ask your Karos contact to retire this schedule." };
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

  const patch: Record<string, unknown> = { status, updatedAt: Date.now() };
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
