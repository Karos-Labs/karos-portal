"use server";

import { revalidatePath } from "next/cache";
import {
  createPlannedScheduledRun,
  deletePlannedScheduledRun,
  getClient,
  getCustomAgent,
  getPlannedScheduledRun,
  updatePlannedScheduledRun,
} from "@/lib/data";
import { computeNextRun } from "@/lib/scheduled-runs";
import type { PlannedRunCadence } from "@/lib/types";
import { logActivity, requireStaff } from "./_shared";

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

/** Pause, resume, or cancel a scheduled run. Staff-only. */
export async function setPlannedRunStatusAction(
  id: string,
  status: "active" | "paused" | "completed",
): Promise<{ error?: string }> {
  const run = await getPlannedScheduledRun(id);
  if (!run) return { error: "Scheduled run not found." };
  const auth = await authorizeClient(run.clientId);
  if ("error" in auth) return { error: auth.error };

  const patch: Record<string, unknown> = { status, updatedAt: Date.now() };
  // Resuming a recurring run: re-anchor its next fire to the future so a stale
  // cursor doesn't fire immediately.
  if (status === "active" && run.cadence !== "once") {
    patch.nextRunAt = computeNextRun({
      cadence: run.cadence,
      hour: run.hour,
      minute: run.minute,
      weekday: run.weekday,
      dayOfMonth: run.dayOfMonth,
      from: Date.now(),
    });
  }
  await updatePlannedScheduledRun(id, patch);
  revalidatePath("/calendar");
  return {};
}

/** Deletes a scheduled run outright. Staff-only. */
export async function deletePlannedRunAction(id: string): Promise<{ error?: string }> {
  const run = await getPlannedScheduledRun(id);
  if (!run) return { error: "Scheduled run not found." };
  const auth = await authorizeClient(run.clientId);
  if ("error" in auth) return { error: auth.error };
  await deletePlannedScheduledRun(id);
  revalidatePath("/calendar");
  return {};
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}
