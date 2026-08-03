"use server";

import { revalidatePath } from "next/cache";
import {
  createScheduledRun,
  deleteScheduledRun,
  getClient,
  getCustomAgent,
  getScheduledRun,
  updateScheduledRun,
} from "@/lib/data";
import { unfireableScheduleReason } from "@/lib/jobs/schedule-gate";
import { computeNextRunAt, isValidCadence } from "@/lib/run-cadence";
import type { AssetType, RunCadence } from "@/lib/types";
import { requireAdmin } from "./_shared";

const MAX_PROMPT_CHARS = 4_000;
const VALID_ASSET_TYPES: readonly AssetType[] = ["social_post", "instagram_post", "email", "article", "note"];

export interface ScheduledRunInput {
  clientId: string;
  agentId: string;
  prompt: string;
  cadence: RunCadence;
  assetType: AssetType;
  platform?: string;
  enabled?: boolean;
}

function validate(input: ScheduledRunInput): string | null {
  if (!input.clientId) return "Client is required.";
  if (!input.agentId) return "Agent is required.";
  if (!input.prompt.trim()) return "A run prompt is required.";
  if (input.prompt.trim().length > MAX_PROMPT_CHARS) {
    return `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).`;
  }
  if (!VALID_ASSET_TYPES.includes(input.assetType)) return "Unknown asset type.";
  if (!isValidCadence(input.cadence)) {
    return "Pick at least one weekday and a valid time (0–23h, 0–59m) with a timezone.";
  }
  return null;
}

export async function createScheduledRunAction(
  input: ScheduledRunInput,
): Promise<{ id?: string; error?: string }> {
  const user = await requireAdmin();
  const invalid = validate(input);
  if (invalid) return { error: invalid };

  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };
  const agent = await getCustomAgent(input.agentId);
  if (!agent) return { error: "Agent not found." };
  // This card can pair any of this client's agents with any cadence, and the
  // row fires unattended through the other submit core — so the same gates a
  // client-facing schedule clears apply here, before a row exists to churn.
  const blocked = await unfireableScheduleReason(client, agent);
  if (blocked) return { error: blocked };

  const now = Date.now();
  const id = await createScheduledRun({
    clientId: input.clientId,
    agentId: agent.id,
    label: agent.name,
    entrySkillDir: agent.entrySkillDir,
    prompt: input.prompt.trim(),
    cadence: input.cadence,
    assetType: input.assetType,
    ...(input.platform ? { platform: input.platform } : {}),
    enabled: input.enabled !== false,
    nextRunAt: computeNextRunAt(input.cadence, now),
    lastRunAt: null,
    lastJobId: null,
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });
  revalidatePath(`/clients/${input.clientId}/settings`);
  return { id };
}

export async function toggleScheduledRunAction(
  id: string,
  enabled: boolean,
): Promise<{ error?: string }> {
  await requireAdmin();
  const existing = await getScheduledRun(id);
  if (!existing) return { error: "Scheduled run not found." };
  // Switching a row back on is an enable, so it clears the same gates a create
  // does. Switching it OFF is always allowed — including for a row the gates now
  // refuse, which is exactly the row someone needs to be able to turn off.
  if (enabled) {
    const [agent, client] = await Promise.all([
      getCustomAgent(existing.agentId),
      getClient(existing.clientId),
    ]);
    if (agent && client) {
      const blocked = await unfireableScheduleReason(client, agent);
      if (blocked) return { error: blocked };
    }
  }
  // Re-enabling after a lapse: bump nextRunAt to the next future slot so a
  // long-disabled run doesn't fire immediately for every window it missed.
  const nextRunAt =
    enabled && existing.nextRunAt <= Date.now()
      ? computeNextRunAt(existing.cadence)
      : existing.nextRunAt;
  await updateScheduledRun(id, { enabled, nextRunAt, updatedAt: Date.now() });
  revalidatePath(`/clients/${existing.clientId}/settings`);
  return {};
}

export async function deleteScheduledRunAction(id: string): Promise<{ error?: string }> {
  await requireAdmin();
  const existing = await getScheduledRun(id);
  if (!existing) return {};
  await deleteScheduledRun(id);
  revalidatePath(`/clients/${existing.clientId}/settings`);
  return {};
}
