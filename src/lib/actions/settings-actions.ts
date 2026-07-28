"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  upsertClientSettings,
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
import type { ClientTask } from "@/lib/types";

/** The batch a "run pending tasks" click would execute: the same selection the
 *  runner uses (pending → karos_managed → first 5), shared so the price shown
 *  and the work started can never describe different task sets. */
async function pendingTasksBatch(clientId: string): Promise<ClientTask[]> {
  const pending = await listClientTasks({ clientId, status: "pending", limit: 10 });
  return pending.filter((t) => inferOwnerEngine(t) === "karos_managed").slice(0, 5);
}

/**
 * Run one batch of pending karos_managed tasks (max 5) for a client.
 *
 * This is a ONE-SHOT action, not a mode: nothing in the product runs a second
 * batch on its own, so no "autopilot is on" state is persisted (QA F48 — the
 * old switch stayed green forever while only ever draining a single batch).
 * Execution is scheduled via after() so the response returns instantly.
 */
export async function runPendingTasksBatchAction(
  clientId: string,
): Promise<{ ok: boolean; started?: number; error?: string }> {
  const user = await requireUser();

  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  // Running as a client user charges credits for the batch. Claim the batch
  // atomically first, then charge exactly what was claimed — so the credits
  // taken always match the tasks that actually run, and a denied charge
  // releases the claim and refuses the run.
  if (isBillableClientActor(user)) {
    const batch = await pendingTasksBatch(clientId);
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
          reason: `Task run · ${claimed.title.slice(0, 80)}`,
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
        console.error("[task-batch] charge failed unexpectedly:", e);
        break;
      }
    }
    if (claimedIds.length === 0 && firstDenial) {
      return { ok: false, error: firstDenial };
    }
    if (claimedIds.length > 0) {
      after(() => runClaimedTasks(clientId, claimedIds).catch(console.error));
    }
    revalidatePath("/tasks");
    return { ok: true, started: claimedIds.length };
  }

  // Staff (and "View as client") runs are free — no claim/charge pass.
  const staffBatch = await pendingTasksBatch(clientId);
  after(() => runAutopilotBatch(clientId).catch(console.error));

  revalidatePath("/tasks");
  return { ok: true, started: staffBatch.length };
}

/**
 * Read-only price + size preview of the batch runPendingTasksBatchAction would
 * execute right now, so the spend is announced BEFORE it happens the way the
 * run dialog and schedule modal already do (QA F58 — this was the largest
 * single-click spend in the portal and the only one with no price attached).
 * Selection mirrors the runner exactly; nothing is claimed, charged or run.
 */
export async function previewPendingTasksBatchAction(
  clientId: string,
): Promise<{ ok: boolean; count?: number; credits?: number; billable?: boolean; error?: string }> {
  const user = await requireUser();
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  const batch = await pendingTasksBatch(clientId);
  const billable = isBillableClientActor(user);
  const costs = billable ? await Promise.all(batch.map((t) => plannedTaskExecutionCost(t))) : [];
  return {
    ok: true,
    count: batch.length,
    credits: costs.reduce((sum, c) => sum + c, 0),
    billable,
  };
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
