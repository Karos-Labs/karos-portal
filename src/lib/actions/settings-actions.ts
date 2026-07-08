"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  upsertClientSettings,
  getClientSettings,
  listClientTasks,
  chargeClientCredits,
  claimTaskForExecution,
  releaseTaskClaim,
} from "@/lib/data";
import { runAutopilotBatch, runClaimedTasks, inferOwnerEngine } from "@/lib/execution-engine";
import { CREDIT_COSTS, CreditError, isBillableClientActor } from "@/lib/credits";

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

  // Idempotent: re-sending the current state must not re-run (or re-charge) a batch.
  const settings = await getClientSettings(clientId);
  if ((settings?.autopilot ?? false) === enabled) return { ok: true };

  // Enabling autopilot as a client user immediately executes pending tasks.
  // Claim the batch atomically first, then charge exactly what was claimed —
  // so the credits taken always match the tasks that actually run, and a
  // denied charge releases the claims and refuses the toggle.
  if (enabled && isBillableClientActor(user)) {
    const pending = await listClientTasks({ clientId, status: "pending", limit: 10 });
    const batch = pending.filter((t) => inferOwnerEngine(t) === "karos_managed").slice(0, 5);
    const claimedIds: string[] = [];
    for (const t of batch) {
      const claimed = await claimTaskForExecution(t.id, clientId, ["pending"]);
      if (claimed) claimedIds.push(t.id);
    }
    if (claimedIds.length > 0) {
      try {
        await chargeClientCredits({
          clientId,
          amount: claimedIds.length * CREDIT_COSTS.taskExecution,
          operation: "task_execution",
          reason: `Autopilot batch · ${claimedIds.length} task${claimedIds.length === 1 ? "" : "s"}`,
          actorUid: user.uid,
          actorName: user.name,
        });
      } catch (e) {
        await Promise.all(claimedIds.map((id) => releaseTaskClaim(id, "pending")));
        if (e instanceof CreditError) return { ok: false, error: e.message };
        throw e;
      }
    }
    await upsertClientSettings(clientId, { autopilot: enabled, updatedAt: Date.now() });
    if (claimedIds.length > 0) {
      after(() => runClaimedTasks(clientId, claimedIds).catch(console.error));
    }
    revalidatePath("/tasks");
    return { ok: true };
  }

  await upsertClientSettings(clientId, { autopilot: enabled, updatedAt: Date.now() });

  if (enabled) {
    after(() => runAutopilotBatch(clientId).catch(console.error));
  }

  revalidatePath("/tasks");
  return { ok: true };
}
