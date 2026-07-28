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
  claimTaskCompletion,
  releaseTaskClaim,
  getAsset,
  createAsset,
  updateAsset,
  listAssets,
  listClientIntegrations,
} from "@/lib/data";
import { CreditError, isBillableClientActor } from "@/lib/credits";
import { clientTaskRunRefusal } from "@/lib/client-agent-gate";
import { integrationIsUsable } from "@/lib/integration-status";
import { recommendPublishTimeWithDensity } from "@/lib/scheduling";
import type { AppUser, Asset, AssetType, ClientTask, ManagedTaskType } from "@/lib/types";
import { sendEmail } from "@/lib/email";
import {
  runTaskExecution,
  inferOwnerEngine,
  dispatchArtifactEmail,
  plannedTaskExecutionCost,
} from "@/lib/execution-engine";

const ALERT_EMAIL = "hello@karoslabs.com";

/**
 * Charge a client user for one task execution; staff executions (and admin
 * "View as Client" sessions) are free. The amount is product-aware — resolved
 * via plannedTaskExecutionCost so media-heavy agent runs price above the
 * in-process baseline. Returns the denial message when the charge is refused,
 * null when it went through (or wasn't needed).
 */
async function chargeTaskExecution(
  user: AppUser,
  clientId: string,
  task: ClientTask,
  reasonPrefix: string,
): Promise<string | null> {
  if (!isBillableClientActor(user)) return null;
  try {
    await chargeClientCredits({
      clientId,
      amount: await plannedTaskExecutionCost(task),
      operation: "task_execution",
      reason: `${reasonPrefix} · ${task.title.slice(0, 80)}`,
      jobId: task.id,
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

  // §2 guard rail, keyed on the BILLED actor (D1). The board is a second door
  // into the same agent, and it must refuse on the same condition the agent's
  // own card does — checked before the claim so a refusal costs nothing.
  const blocked = await clientTaskRunRefusal({ user, clientId, task });
  if (blocked) return { ok: false, error: blocked };

  // Atomically claim the task first (verifies ownership + pending status +
  // not already executing) so a double-fired drag or retry can't charge and
  // execute the same task twice.
  const claimed = await claimTaskForExecution(taskId, clientId, ["pending"]);
  if (!claimed) return { ok: false, error: "Task is already running or not in a runnable state" };

  let denied: string | null;
  try {
    denied = await chargeTaskExecution(user, clientId, task, "Task execution");
  } catch (e) {
    // Unexpected (non-CreditError) charge failure — release the claim so the
    // task doesn't sit executing:true with no run behind it.
    await releaseTaskClaim(taskId, claimed.status);
    throw e;
  }
  if (denied) {
    await releaseTaskClaim(taskId, claimed.status);
    return { ok: false, error: denied };
  }

  after(() => runTaskExecution(clientId, taskId).catch(console.error));
  return { ok: true };
}

/* ── Approve → Asset → Calendar ──────────────────────────────────── */

/** Asset library bucket for each managed product (mirrors the webhook's map). */
const PRODUCT_ASSET_TYPE: Record<string, AssetType> = {
  social_post: "social_post",
  newsletter_issue: "email",
  blog_article: "article",
  landing_page: "note",
};

/** Default publish platform per asset type, used when the task names none. */
const DEFAULT_PLATFORM_FOR_ASSET: Partial<Record<AssetType, string>> = {
  instagram_post: "instagram",
  social_post: "instagram",
  article: "linkedin",
};

/**
 * Place an approved deliverable on the content calendar: pick the target
 * platform (task's own platform if its integration is active, else the type
 * default) and a density-aware optimal slot. The publish tier honors the
 * client's pre-approval intent:
 *   - autoPublish requested + the channel is fully connected (active
 *     integration with its auto-publish toggle on) → "auto": the publish cron
 *     posts it at the scheduled time.
 *   - otherwise → "manual" (on the calendar, user pushes Publish Now) when a
 *     connected channel exists, else "placeholder".
 * Falls back to a bare approval when the type has no scheduling dimension.
 */
async function scheduleFieldsForApproval(
  task: ClientTask,
  clientId: string,
  assetType: AssetType,
  opts: { recommendedAt?: number; autoPublish?: boolean } = {},
): Promise<Partial<Asset>> {
  const [allAssets, integrations] = await Promise.all([
    listAssets({ clientId }),
    listClientIntegrations(clientId),
  ]);
  const activeIntegrations = integrations.filter((i) => integrationIsUsable(i));
  const activePlatforms = new Set(activeIntegrations.map((i) => i.platform));
  const taskPlatform = task.metadata?.platform as string | undefined;
  const platform =
    taskPlatform && activePlatforms.has(taskPlatform)
      ? taskPlatform
      : DEFAULT_PLATFORM_FOR_ASSET[assetType];

  const scheduled = allAssets
    .filter((a) => a.scheduledAt != null)
    .map((a) => a.scheduledAt as number);
  const slot = recommendPublishTimeWithDensity({ assetType, platform, scheduled });
  const scheduledAt = slot?.at ?? opts.recommendedAt;
  if (!scheduledAt) return {};

  const channelConnected = !!platform && activePlatforms.has(platform);
  // absent autoPublish flag on the integration ⇒ enabled (matches the cron).
  const channelAutoEnabled =
    channelConnected &&
    activeIntegrations.find((i) => i.platform === platform)?.autoPublish !== false;

  return {
    scheduledAt,
    publishMode:
      opts.autoPublish && channelAutoEnabled ? "auto" : channelConnected ? "manual" : "placeholder",
    ...(platform ? { scheduledPlatform: platform } : {}),
    ...(slot ? { recommendedAt: slot.at, recommendedReason: slot.reason } : {}),
  };
}

/**
 * Client or staff approves a review_pending deliverable. The output
 * transitions into the Assets collection (promoting the agent-run draft when
 * one exists, else creating an asset from the inline artifact) and syncs onto
 * the content calendar at a density-aware optimal slot. Task → completed.
 */
export async function approveTaskArtifactAction(
  taskId: string,
  clientId: string,
  opts?: { autoPublish?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { user } = access;
  const autoPublish = opts?.autoPublish === true;

  // Atomic claim: flips review_pending → completed exactly once. A concurrent
  // Re-run (which claims + charges) or a second approve tab loses here, so
  // asset creation can't double-fire and a charged re-run can't be silently
  // completed out from under the client.
  const task = await claimTaskCompletion(taskId, clientId);
  if (!task) {
    return { ok: false, error: "Task is not in review_pending state" };
  }

  let approvedAssetId: string | null = null;
  const existingAssetIds = (task.metadata?.artifactAssetIds as string[] | undefined) ?? [];
  const artifact = task.metadata?.artifact as string | undefined;
  const productType = task.metadata?.productType as ManagedTaskType | undefined;

  try {
    if (existingAssetIds.length > 0) {
      // Agent-service run already created draft asset(s) — promote them.
      for (const assetId of existingAssetIds) {
        const asset = await getAsset(assetId);
        if (!asset || asset.clientId !== clientId) continue;
        const schedule = await scheduleFieldsForApproval(task, clientId, asset.type, {
          recommendedAt: asset.recommendedAt,
          autoPublish,
        });
        await updateAsset(assetId, { status: "approved", ...schedule, updatedAt: Date.now() });
        approvedAssetId = approvedAssetId ?? assetId;
      }
    } else if (artifact && task.metadata?.type !== "integration_action") {
      // In-process artifact — materialize it into the Assets library.
      const assetType = (productType && PRODUCT_ASSET_TYPE[productType]) ?? "note";
      const schedule = await scheduleFieldsForApproval(task, clientId, assetType, { autoPublish });
      approvedAssetId = await createAsset({
        clientId,
        jobId: (task.metadata?.externalJobId as string | undefined) ?? null,
        agentId: null,
        type: assetType,
        title: task.title,
        content: artifact,
        imageUrl: (task.metadata?.artifactImageUrl as string | undefined) ?? null,
        status: "approved",
        ...schedule,
        // Carry the campaign linkage onto the asset so the content calendar can
        // group it into its campaign capsule without a task join.
        ...(task.campaignId
          ? {
              campaignId: task.campaignId,
              campaignTitle: (task.metadata?.campaignTitle as string | undefined) ?? null,
            }
          : {}),
        meta: { taskId, ...(productType ? { taskType: productType } : {}) },
        createdBy: user.uid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  } catch (e) {
    // Asset/calendar sync is best-effort — approval itself must not dead-end.
    console.error("[approveTask] asset sync failed:", e);
  }

  if (approvedAssetId) {
    await updateClientTask(taskId, {
      metadata: { ...(task.metadata ?? {}), failedUpload: null, approvedAssetId },
      updatedAt: Date.now(),
    });
  }

  revalidatePath("/tasks");
  revalidatePath("/assets");
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
  const { user, task } = access;

  const trimmed = feedback.trim();
  if (!trimmed) return { ok: false, error: "Feedback cannot be empty" };

  // §2 guard rail, keyed on the BILLED actor (D1): a re-run is a run, and it
  // charges again — so it refuses on the same condition as a first run.
  const blocked = await clientTaskRunRefusal({ user, clientId, task });
  if (blocked) return { ok: false, error: blocked };

  // Atomic claim: verifies ownership + review_pending + not already executing,
  // and flips to in_progress — two concurrent submits can't both charge.
  const claimed = await claimTaskForExecution(taskId, clientId, ["review_pending"]);
  if (!claimed) return { ok: false, error: "Task is not in review_pending state" };

  let denied: string | null;
  try {
    denied = await chargeTaskExecution(user, clientId, claimed, "Task adjustments");
  } catch (e) {
    await releaseTaskClaim(taskId, claimed.status);
    throw e;
  }
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
  const { user, task: preflight } = access;

  const client = await getClient(clientId);
  if (preflight.status !== "review_pending") {
    return { ok: false, error: "Task is not in review_pending state" };
  }
  if (!preflight.metadata?.artifact) {
    return { ok: false, error: "No artifact to publish" };
  }

  const recipient =
    (preflight.metadata.recipient as string | undefined) ?? client?.contactEmail;

  if (!recipient) {
    return {
      ok: false,
      error: "No recipient email - add a contact email to the client profile.",
    };
  }

  // Atomic claim BEFORE the send: two tabs can't both dispatch the email, and
  // a concurrent Re-run can't be clobbered. On send failure the claim is
  // reverted so the task stays reviewable.
  const task = await claimTaskCompletion(taskId, clientId);
  if (!task) {
    return { ok: false, error: "Task is not in review_pending state" };
  }

  const result = await dispatchArtifactEmail(task, client?.name ?? "Your Team", recipient);

  if (!result.ok) {
    await updateClientTask(taskId, {
      status: "review_pending",
      completedAt: null,
      metadata: {
        ...(task.metadata ?? {}),
        failedUpload: true,
        failedUploadError: result.error,
        failedUploadAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const alertHtml = `
      <p style="font-family:sans-serif;"><strong>Karos - Task Publish Failure</strong></p>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Task ID</td><td>${taskId}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Task Title</td><td>${task.title}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Client</td><td>${client?.name ?? "-"} (${clientId})</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Recipient</td><td>${recipient}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Error</td><td>${result.error}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#9c9ca3;">Triggered by</td><td>${user.name} &lt;${user.email}&gt;</td></tr>
      </table>`;

    const alertResult = await sendEmail({
      to: ALERT_EMAIL,
      subject: `[Karos Alert] Publish failure - ${task.title.slice(0, 60)}`,
      html: alertHtml,
    });
    if (!alertResult.ok) {
      // The publish already failed and is recorded on the task; if the alert
      // email also fails, at least leave a server-log breadcrumb.
      console.error(
        `[execution] Publish-failure alert email failed for task ${taskId}: ${alertResult.error}`,
      );
    }

    revalidatePath("/tasks");
    return { ok: false, error: result.error };
  }

  // Status is already completed (the claim) — just record the delivery.
  await updateClientTask(taskId, {
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
