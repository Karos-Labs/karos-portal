"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { upsertClientSettings } from "@/lib/data";
import { runAutopilotBatch } from "@/lib/execution-engine";

/**
 * Toggle the Autopilot Mode flag for a client.
 * When enabled, immediately schedules a batch execution of all pending
 * karos_managed tasks via after() so the response returns instantly.
 */
export async function updateAutopilotAction(
  clientId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();

  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  await upsertClientSettings(clientId, { autopilot: enabled, updatedAt: Date.now() });

  if (enabled) {
    after(() => runAutopilotBatch(clientId).catch(console.error));
  }

  revalidatePath("/tasks");
  return { ok: true };
}
