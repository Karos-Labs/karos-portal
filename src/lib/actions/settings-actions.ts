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
import {
  runAutopilotBatch,
  runClaimedTasks,
  inferOwnerEngine,
  plannedTaskExecutionCost,
} from "@/lib/execution-engine";
import { CreditError, isBillableClientActor } from "@/lib/credits";

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
    // Claim + charge PER TASK with jobId = task.id — every refund mechanism
    // (webhook failure sync, stuck-execution sweep) pairs on that key, so an
    // aggregate batch charge would be unrefundable when one run dies.
    // Product-aware pricing: each task charges what will actually run it.
    let firstDenial: string | null = null;
    for (const t of batch) {
      const claimed = await claimTaskForExecution(t.id, clientId, ["pending"]);
      if (!claimed) continue;
      try {
        await chargeClientCredits({
          clientId,
          amount: await plannedTaskExecutionCost(claimed),
          operation: "task_execution",
          reason: `Autopilot · ${claimed.title.slice(0, 80)}`,
          jobId: t.id,
          actorUid: user.uid,
          actorName: user.name,
        });
        claimedIds.push(t.id);
      } catch (e) {
        // Release only the CURRENT (uncharged) claim. Earlier tasks are
        // already charged — releasing them would strand their charges, so
        // they stay claimed and run with the batch.
        await releaseTaskClaim(t.id, "pending");
        if (e instanceof CreditError) {
          // Out of credits/caps — run what was already funded.
          firstDenial = e.message;
          break;
        }
        console.error("[autopilot] charge failed unexpectedly:", e);
        break;
      }
    }
    if (claimedIds.length === 0 && firstDenial) {
      return { ok: false, error: firstDenial };
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

/**
 * Toggle the client's auto-scheduling opt-in flag. This controls whether
 * approvals and chain-assigned scheduling may mark drafts as publishMode="auto".
 */
export async function updateAutoScheduleAction(
  clientId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  // Persist the toggle.
  await upsertClientSettings(clientId, { autoScheduleEnabled: enabled, updatedAt: Date.now() });
  // Revalidate settings and calendar surfaces so the UI updates promptly.
  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/settings`);
  revalidatePath(`/assets`);
  return { ok: true };
}
