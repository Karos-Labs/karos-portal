"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireTaskAccess } from "./_shared";
import {
  getClient,
  updateClientTask,
  createTaskComment,
  chargeClientCredits,
  claimTaskForExecution,
  releaseTaskClaim,
} from "@/lib/data";
import { CREDIT_COSTS, CreditError, isBillableClientActor } from "@/lib/credits";
import type { AppUser } from "@/lib/types";
import { sendEmail } from "@/lib/email";
import {
  runTaskExecution,
  inferOwnerEngine,
  dispatchArtifactEmail,
} from "@/lib/execution-engine";

const ALERT_EMAIL = "hello@karoslabs.com";

/**
 * Charge a client user for one task execution; staff executions (and admin
 * "View as Client" sessions) are free. Returns the denial message when the
 * charge is refused, null when it went through (or wasn't needed).
 */
async function chargeTaskExecution(
  user: AppUser,
  clientId: string,
  taskId: string,
  taskTitle: string,
  reasonPrefix: string,
): Promise<string | null> {
  if (!isBillableClientActor(user)) return null;
  try {
    await chargeClientCredits({
      clientId,
      amount: CREDIT_COSTS.taskExecution,
      operation: "task_execution",
      reason: `${reasonPrefix} · ${taskTitle.slice(0, 80)}`,
      jobId: taskId,
      actorUid: user.uid,
      actorName: user.name,
    });
    return null;
  } catch (e) {
    if (e instanceof CreditError) return e.message;
    throw e;
  }
}

/* ── Trigger: manual drag Pending → In Progress ──────────────────── */

/**
 * Called when a user drags a karos_managed card from Pending to In Progress.
 * Marks the task executing immediately and schedules background AI generation
 * so the response returns before the (potentially slow) model call begins.
 */
export async function startTaskExecutionAction(
  taskId: string,
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { user, task } = access;
  if (inferOwnerEngine(task) !== "karos_managed") {
    return { ok: false, error: "Task is not karos_managed" };
  }
  if (task.metadata?.executing === true) {
    return { ok: true }; // already running — don't double-trigger
  }

  // Atomically claim the task first (verifies ownership + pending status +
  // not already executing) so a double-fired drag or retry can't charge and
  // execute the same task twice.
  const claimed = await claimTaskForExecution(taskId, clientId, ["pending"]);
  if (!claimed) return { ok: false, error: "Task is already running or not in a runnable state" };

  const denied = await chargeTaskExecution(user, clientId, taskId, task.title, "Task execution");
  if (denied) {
    await releaseTaskClaim(taskId, claimed.status);
    return { ok: false, error: denied };
  }

  after(() => runTaskExecution(clientId, taskId).catch(console.error));
  return { ok: true };
}

/* ── Approve ─────────────────────────────────────────────────────── */

/**
 * Client or staff approves a review_pending artifact → completed.
 */
export async function approveTaskArtifactAction(
  taskId: string,
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { task } = access;
  if (task.status !== "review_pending") {
    return { ok: false, error: "Task is not in review_pending state" };
  }

  await updateClientTask(taskId, {
    status: "completed",
    completedAt: Date.now(),
    metadata: { ...(task.metadata ?? {}), failedUpload: null },
    updatedAt: Date.now(),
  });

  revalidatePath("/tasks");
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/* ── Request Adjustments / Re-run ────────────────────────────────── */

/**
 * The Review-stage "Re-run" loop: the client leaves feedback on the artifact,
 * the task returns to in_progress, and the mapped agent (or the generic
 * engine) re-executes with the original context, the previous output, and the
 * new feedback injected.
 */
export async function requestAdjustmentsAction(
  taskId: string,
  clientId: string,
  feedback: string,
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { user } = access;

  const trimmed = feedback.trim();
  if (!trimmed) return { ok: false, error: "Feedback cannot be empty" };

  // Atomic claim: verifies ownership + review_pending + not already executing,
  // and flips to in_progress — two concurrent submits can't both charge.
  const claimed = await claimTaskForExecution(taskId, clientId, ["review_pending"]);
  if (!claimed) return { ok: false, error: "Task is not in review_pending state" };

  const denied = await chargeTaskExecution(user, clientId, taskId, claimed.title, "Task adjustments");
  if (denied) {
    await releaseTaskClaim(taskId, claimed.status);
    return { ok: false, error: denied };
  }

  // Persist feedback as comment for audit trail
  await createTaskComment({
    taskId,
    clientId,
    content: `[Adjustment Request] ${trimmed}`,
    authorName: user.name,
    authorRole: user.role,
    createdAt: Date.now(),
  });

  await updateClientTask(taskId, {
    metadata: {
      ...(claimed.metadata ?? {}),
      executing: true,
      adjustmentFeedback: trimmed,
      executionError: null,
    },
    updatedAt: Date.now(),
  });

  after(() => runTaskExecution(clientId, taskId).catch(console.error));
  revalidatePath("/tasks");
  return { ok: true };
}

/* ── Publish / Send (Flow B) ─────────────────────────────────────── */

/**
 * Flow B: dispatches the generated artifact externally via Resend.
 * Success → completed. Failure → failedUpload badge + internal alert to Karos.
 */
export async function publishIntegrationAction(
  taskId: string,
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { user, task } = access;

  const client = await getClient(clientId);
  if (task.status !== "review_pending") {
    return { ok: false, error: "Task is not in review_pending state" };
  }
  if (!task.metadata?.artifact) {
    return { ok: false, error: "No artifact to publish" };
  }

  const recipient =
    (task.metadata.recipient as string | undefined) ?? client?.contactEmail;

  if (!recipient) {
    return {
      ok: false,
      error: "No recipient email — add a contact email to the client profile.",
    };
  }

  const result = await dispatchArtifactEmail(task, client?.name ?? "Your Team", recipient);

  if (!result.ok) {
    await updateClientTask(taskId, {
      metadata: {
        ...(task.metadata ?? {}),
        failedUpload: true,
        failedUploadError: result.error,
        failedUploadAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const alertHtml = `
      <p style="font-family:sans-serif;"><strong>Karos — Task Publish Failure</strong></p>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Task ID</td><td>${taskId}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Task Title</td><td>${task.title}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Client</td><td>${client?.name ?? "—"} (${clientId})</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Recipient</td><td>${recipient}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Error</td><td>${result.error}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Triggered by</td><td>${user.name} &lt;${user.email}&gt;</td></tr>
      </table>`;

    await sendEmail({
      to: ALERT_EMAIL,
      subject: `[Karos Alert] Publish failure — ${task.title.slice(0, 60)}`,
      html: alertHtml,
    });

    revalidatePath("/tasks");
    return { ok: false, error: result.error };
  }

  await updateClientTask(taskId, {
    status: "completed",
    completedAt: Date.now(),
    metadata: {
      ...(task.metadata ?? {}),
      failedUpload: null,
      publishedAt: Date.now(),
      publishedTo: recipient,
    },
    updatedAt: Date.now(),
  });

  revalidatePath("/tasks");
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
