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
 * A run the service called DONE that handed this task nothing a client can
 * open: no text, no image, no library asset. It is not the same question the
 * webhook's zero-deliverable refund asks (`deliveredCount === 0` — over the
 * artifacts whose bytes actually reached platform storage, which since #51 is a
 * narrower set than the manifest's client-facing entries) and it must not be
 * collapsed into it:
 *
 *  - a client-facing artifact that is neither text nor an image (a PDF, say)
 *    still creates an asset, so `assetId` is set and the client DID receive
 *    something — the manifest count and this predicate agree;
 *  - but a run whose asset write THREW leaves `assetId` null with no text and
 *    no image, and the manifest count says "delivered". The webhook's comment
 *    at that catch reasons that "task-sync below writes artifact:
 *    taskArtifactContent on the success path, so the client did receive the
 *    deliverable" — which is only true when there IS content. This is the case
 *    that sentence misses, and asking the ticket's own three fields is what
 *    catches it.
 *
 * `content` is trimmed: a manifest whose primary text re-hosted as whitespace
 * is nothing to review either.
 */
function deliveredNothing(outcome: Extract<JobOutcome, { ok: true }>): boolean {
  return outcome.content.trim() === "" && !outcome.assetId && !outcome.imageUrl;
}

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
 *
 * ── A THIRD OUTCOME: "done", and nothing to show for it (#32 cluster) ────────
 * The webhook calls this with `{ok: true, content: ""}` on the very delivery
 * that REFUNDS the run for producing no client-facing deliverables. The success
 * branch then wrote `review_pending` with `artifact: outcome.content ||
 * task.title` — so the client was asked to approve a deliverable that does not
 * exist, titled with the words they typed into the task, right after being
 * refunded for it. Two surfaces disagreeing about whether the run delivered.
 *
 * The refund is the truth, so a nothing-run now takes the SAME shape as a
 * failure: released back to `pending`, retryable, and refunded here too (a
 * belt-and-braces no-op when the webhook's own refund already paired the
 * charge, since the ledger id is keyed to the charge entry). The board and the
 * ticket recognise the released-with-nothing state through
 * `ranWithoutDeliverable` (task-outcome-copy.ts) and say so.
 *
 * WHAT THE CARD DOES NOT SAY, and why. It states the missing deliverable, not
 * the money. This function cannot tell "the webhook already refunded this" from
 * "there was never a charge" — both come back from `refundJobCharge` as
 * `{refunded: false}` — so any credits sentence here would be a guess. The
 * ledger is where money is stated, and it carries the refund row.
 *
 * It still returns `true`: a live dispatch WAS consumed. Returning false would
 * hand the webhook's `!taskSynced` branch a run that produced nothing and let
 * it auto-complete this client's pending watcher tasks on the strength of it.
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

  if (outcome.ok && !deliveredNothing(outcome)) {
    await updateClientTask(task.id, {
      status: "review_pending",
      metadata: {
        ...(task.metadata ?? {}),
        executing: false,
        type: "content_generation",
        // No `|| task.title` fallback: it dressed the client's own task title
        // up as the deliverable.
        //
        // THIS CAN BE "" AND THAT IS A REAL STATE, not a dead one. The truly
        // empty run is owned by `deliveredNothing` above, but a run with an
        // image or a library asset and no primary text lands HERE, on the
        // success branch, with an empty string. That is a value no writer
        // produced while the fallback existed, so any reader that treats
        // `artifact` as the test for "is there a deliverable" is wrong — the
        // deliverable may be `artifactImageUrl` or `artifactAssetIds`. The
        // ticket asks all three (task-ticket-modal.tsx ArtifactSection gate).
        artifact: outcome.content,
        artifactImageUrl: outcome.imageUrl ?? null,
        artifactAssetIds: outcome.assetId ? [outcome.assetId] : [],
        externalJobId: null,
        adjustmentFeedback: null,
        executionError: null,
        noDeliverable: null,
      },
      updatedAt: Date.now(),
    });
  } else {
    // A failure, or a "done" run that handed the ticket nothing — the client's
    // experience is identical (they asked for a deliverable and have none), so
    // the state is identical: released to pending, retryable, refunded.
    //
    // `metadata.artifact` is deliberately left alone on both. On a re-run after
    // "Adjust", the prior draft on the ticket is the revision base the next
    // prompt builds from (execution-engine's `previousArtifact`) — and it is
    // exactly what the old `|| task.title` write used to destroy.
    const nothingDelivered = outcome.ok;
    await updateClientTask(task.id, {
      status: "pending",
      metadata: {
        ...(task.metadata ?? {}),
        executing: false,
        externalJobId: null,
        // NULL on the nothing-run, and that is load-bearing rather than
        // careless. This field is the app's untrusted diagnostic bucket — it
        // can hold the agent service's own words, no client surface may render
        // it, and the board's only use of it is `Boolean(...)` ⇒ "Execution
        // failed.". A nothing-run did not fail, so leaving a diagnostic here
        // would put that sentence on the card next to the true one. The
        // narrative lives in the job's own event log, which already records the
        // zero-deliverable refund.
        executionError: nothingDelivered ? null : outcome.error,
        // Read only through `ranWithoutDeliverable` (task-outcome-copy.ts),
        // which asks whether the task is STILL in the state this describes
        // rather than trusting the flag on its own — no other writer knows to
        // clear it. Cleared here on both of the paths that do know.
        noDeliverable: nothingDelivered ? true : null,
      },
      updatedAt: Date.now(),
    });
    // The client paid for this execution upfront (jobId = task id on the
    // ledger entry); the run ended without a deliverable. A failed refund
    // write here is NOT retried by any sweep (the task is already released),
    // so it must at least be loud.
    await refundJobCharge(
      taskId,
      nothingDelivered
        ? `Auto-refund · run produced nothing · ${task.title.slice(0, 80)}`
        : `Auto-refund · agent run failed · ${task.title.slice(0, 80)}`,
    ).catch((e) => {
      console.error(`[task-sync] refund failed for task ${taskId}:`, e);
    });
  }
  return true;
}
