/**
 * Task Map ⇄ platform state synchronization.
 *
 * The task board mirrors real work that can also happen OUTSIDE the board:
 * a client connects an integration from Settings, or an agent run finishes a
 * deliverable. These hooks flip the corresponding tasks automatically so the
 * board never asks a user to drag a card for something the system already
 * observed. All functions are best-effort idempotent sweeps — safe to call
 * from webhooks, OAuth callbacks, and reconcile crons.
 *
 * Trigger contract (task.metadata.completionTrigger):
 *   "integration_connected:<platform>" — client_managed onboarding tasks
 *   "product_run:<ManagedTaskType>"    — karos_managed tasks satisfied by any
 *                                        successful run of that product
 */
import "server-only";

import {
  findTaskByExternalJobId,
  getClientTask,
  listClientTasks,
  updateClientTask,
} from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import type { ClientTask, TaskStatus } from "@/lib/types";

const ACTIVE: TaskStatus[] = ["pending", "in_progress", "review_pending"];

/** Alias sets so "Connect X (Twitter) account" matches the "twitter" platform key. */
const PLATFORM_ALIASES: Record<string, string[]> = {
  linkedin: ["linkedin"],
  facebook: ["facebook"],
  instagram: ["instagram"],
  twitter: ["twitter", "x (twitter)", " x "],
  youtube: ["youtube"],
  tiktok: ["tiktok"],
  google: ["google", "gmail", "google workspace"],
};

function completeTask(task: ClientTask, reason: string): Promise<void> {
  return updateClientTask(task.id, {
    status: "completed",
    completedAt: Date.now(),
    metadata: {
      ...(task.metadata ?? {}),
      executing: false,
      executionError: null,
      autoCompletedReason: reason,
    },
    updatedAt: Date.now(),
  });
}

/**
 * Complete active tasks carrying an explicit completionTrigger. product_run
 * triggers only fire for PENDING tasks — in_progress/review_pending tasks are
 * mid-pipeline (being executed or awaiting the client's verdict) and must not
 * be closed out from under the user by an unrelated run.
 *
 * `scope.platform` narrows product_run triggers to the run's actual target
 * channel: an Instagram run must not close a TikTok watcher of the same
 * product. A platformless watcher matches any run; a platformed watcher only
 * matches a run for that platform (or a run covering "both"/unknown).
 */
export async function autoCompleteTasksByTrigger(
  clientId: string,
  trigger: string,
  reason: string,
  scope: { platform?: string } = {},
): Promise<number> {
  const tasks = await listClientTasks({ clientId, status: ACTIVE, limit: 200 });
  const runPlatform = scope.platform?.toLowerCase();
  const platformCovers = (taskPlatform: unknown) => {
    if (typeof taskPlatform !== "string" || !taskPlatform) return true;
    if (!runPlatform || runPlatform === "both") return true;
    return taskPlatform.toLowerCase() === runPlatform;
  };
  const eligible = tasks.filter((t) => {
    if (t.metadata?.completionTrigger !== trigger) return false;
    if (trigger.startsWith("product_run:")) {
      return t.status === "pending" && platformCovers(t.metadata?.platform);
    }
    return true;
  });
  await Promise.all(eligible.map((t) => completeTask(t, reason)));
  return eligible.length;
}

/**
 * Integration-connect hook: the client linked <platform> (OAuth callback or
 * staff manual save). Completes matching client_managed onboarding tasks —
 * explicit trigger first, then a title fallback for tasks created before the
 * trigger existed ("Connect LinkedIn account to Karos").
 */
export async function autoCompleteTasksOnIntegrationConnect(
  clientId: string,
  platform: string,
): Promise<number> {
  const key = platform.toLowerCase();
  const reason = `Auto-completed - ${platform} integration connected`;
  const tasks = await listClientTasks({ clientId, status: ACTIVE, limit: 200 });
  const aliases = PLATFORM_ALIASES[key] ?? [key];

  const eligible = tasks.filter((t) => {
    if (t.metadata?.completionTrigger === `integration_connected:${key}`) return true;
    // Title fallback: client_managed "connect …" tasks naming this platform.
    const owner = t.owner ?? (t.source === "manual" ? "client_managed" : "karos_managed");
    if (owner !== "client_managed") return false;
    const title = ` ${t.title.toLowerCase()} `;
    return title.includes("connect") && aliases.some((a) => title.includes(a));
  });

  await Promise.all(eligible.map((t) => completeTask(t, reason)));
  return eligible.length;
}

/** Outcome of an agent-service run, as seen by the webhook / reconciler. */
export type JobOutcome =
  | { ok: true; assetId: string | null; content: string; imageUrl?: string | null }
  | { ok: false; error: string };

/**
 * The board task that dispatched this agent-service run, or null when the run
 * was fired directly at an agent.
 *
 * OUR OWN RECORD FIRST (`metadata.externalJobId`), the service's metadata echo
 * second: `karos_task_id` comes back through a signed payload, but it is still
 * a value that arrived over the wire naming a Firestore document, and it is
 * used to decide where a REFUND is written. So the echo is accepted only when
 * the task it names belongs to this run's client AND is not already bound to a
 * different job — which is also exactly the dispatch race it exists to cover
 * (a run that terminates before the dispatcher persisted externalJobId).
 *
 * Deliberately says nothing about whether the task is still live — that is a
 * separate question, asked by syncTaskForJobOutcome for the state write and NOT
 * asked by the refund path, which only needs the ledger key the charge was
 * filed under.
 */
export async function findDispatchingTask(
  platformJobId: string,
  clientId: string,
  fallbackTaskId?: string,
): Promise<ClientTask | null> {
  let task = await findTaskByExternalJobId(platformJobId);
  if (!task && fallbackTaskId) {
    const candidate = await getClientTask(fallbackTaskId);
    const linked = candidate?.metadata?.externalJobId;
    if (candidate && (linked == null || linked === platformJobId)) task = candidate;
  }
  if (!task || task.clientId !== clientId) return null;
  return task;
}

/**
 * Job-completion hook: the agent-service run dispatched FOR a task finished.
 * Success → the deliverable lands on the task ticket (review_pending) for the
 * client preview + approve/re-run loop. Failure → task returns to pending with
 * the error surfaced, and the upfront task-execution charge is refunded
 * (idempotent — deterministic refund ledger id keyed by the charge entry).
 *
 * `fallbackTaskId` (the karos_task_id echoed through the service metadata)
 * covers the dispatch race: a run that terminates fast can deliver its webhook
 * before the dispatcher persisted metadata.externalJobId — the echo resolves
 * the task anyway, so nothing gets stranded mid-"AI Working…".
 */
export async function syncTaskForJobOutcome(
  platformJobId: string,
  clientId: string,
  outcome: JobOutcome,
  fallbackTaskId?: string,
): Promise<boolean> {
  const task = await findDispatchingTask(platformJobId, clientId, fallbackTaskId);
  if (!task) return false;
  // Only a live dispatch consumes the outcome — re-delivered webhooks after
  // the task moved on must not clobber later state.
  if (task.status !== "in_progress" || task.metadata?.executing !== true) return false;
  const taskId = task.id;

  if (outcome.ok) {
    await updateClientTask(task.id, {
      status: "review_pending",
      metadata: {
        ...(task.metadata ?? {}),
        executing: false,
        type: "content_generation",
        artifact: outcome.content || task.title,
        artifactImageUrl: outcome.imageUrl ?? null,
        artifactAssetIds: outcome.assetId ? [outcome.assetId] : [],
        externalJobId: null,
        adjustmentFeedback: null,
        executionError: null,
      },
      updatedAt: Date.now(),
    });
  } else {
    await updateClientTask(task.id, {
      status: "pending",
      metadata: {
        ...(task.metadata ?? {}),
        executing: false,
        externalJobId: null,
        executionError: outcome.error,
      },
      updatedAt: Date.now(),
    });
    // The client paid for this execution upfront (jobId = task id on the
    // ledger entry); the run died without a deliverable. A failed refund
    // write here is NOT retried by any sweep (the task is already released),
    // so it must at least be loud.
    await refundJobCharge(
      taskId,
      `Auto-refund · agent run failed · ${task.title.slice(0, 80)}`,
    ).catch((e) => {
      console.error(`[task-sync] refund failed for task ${taskId}:`, e);
    });
  }
  return true;
}
