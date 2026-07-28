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
}

export interface ClientAgentScheduleInput {
  clientId: string;
  customAgentId: string;
  postsPerWeek: number;
  outputsPerRun: number;
  prompt: string;
  hour?: number;
  minute?: number;
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
    const d = new Date(input.runAt);
    hour = d.getHours();
    minute = d.getMinutes();
  } else {
    hour = clampInt(input.hour ?? 9, 0, 23);
    minute = clampInt(input.minute ?? 0, 0, 59);
    if (input.cadence === "weekly") weekday = clampInt(input.weekday ?? 1, 0, 6);
    if (input.cadence === "monthly") dayOfMonth = clampInt(input.dayOfMonth ?? 1, 1, 31);
    nextRunAt = computeNextRun({ cadence: input.cadence, hour, minute, weekday, dayOfMonth, from: now });
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

  // Clamped to exactly what the dialog offers. outputsPerRun was capped at 10
  // here while the dialog offered 5, so a stale page or a direct call could
  // schedule twice the outputs the product sells — and the scheduler bills
  // chargeMultiplier = outputsPerRun on every fire.
  const postsPerWeek = clampInt(input.postsPerWeek, 1, MAX_RUNS_PER_WEEK);
  const outputsPerRun = clampInt(input.outputsPerRun, 1, MAX_OUTPUTS_PER_RUN);
  const prompt = input.prompt.trim();
  if (!prompt) return { error: "Describe what the agent should create each time." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).` };
  }

  const hour = clampInt(input.hour ?? 9, 0, 23);
  const minute = clampInt(input.minute ?? 0, 0, 59);
  const weekdays = weeklyCadenceDays(postsPerWeek);
  const now = Date.now();
  const nextRunAt = computeNextRun({
    cadence: "weekly",
    hour,
    minute,
    weekdays,
    from: now,
  });
  const billClientCredits = isBillableClientActor(user);
  const weeklyCredits = scheduledAgentWeeklyCost(
    agent.creditCost ?? CREDIT_COSTS.customAgentRun,
    postsPerWeek,
    outputsPerRun,
  );

  const schedules = await listPlannedScheduledRuns({ clientId: input.clientId });
  const existing = schedules.find(
    (run) => run.customAgentId === agent.id && run.cadence === "weekly" && run.status !== "completed",
  );
  const patch = {
    agentName: agent.name,
    agentIcon: agent.icon,
    agentColor: agent.color,
    prompt,
    cadence: "weekly" as const,
    hour,
    minute,
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

/** Pause, resume, or cancel a scheduled run. Clients may control their own. */
export async function setPlannedRunStatusAction(
  id: string,
  status: "active" | "paused" | "completed",
): Promise<{ error?: string }> {
  const run = await getPlannedScheduledRun(id);
  if (!run) return { error: "Scheduled run not found." };
  await requireClientAccess(run.clientId);

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
    });
  }
  await updatePlannedScheduledRun(id, patch);
  revalidatePath("/calendar");
  return {};
}

/** Deletes a scheduled run outright. Clients may delete their own. */
export async function deletePlannedRunAction(id: string): Promise<{ error?: string }> {
  const run = await getPlannedScheduledRun(id);
  if (!run) return { error: "Scheduled run not found." };
  await requireClientAccess(run.clientId);
  await deletePlannedScheduledRun(id);
  revalidatePath("/calendar");
  return {};
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}
