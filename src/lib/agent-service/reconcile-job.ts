import "server-only";
import { claimExternalJobCompletion, getClient, updateJob } from "@/lib/data";
import { getAgentServiceJob } from "@/lib/agent-service/client";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { syncTaskForJobOutcome } from "@/lib/task-sync";
import { notifyJobFailure } from "@/lib/job-alerts";
import { logger } from "@/services/logger";
import type { Job } from "@/lib/types";

// Failure outcomes only — a `done` job is deliberately left alone (see
// reconcileOneJob's doc comment below). Narrowed to exactly these two JobStatus
// values (not the full JobStatus union) so `mapped` below can be passed
// straight through to logger.logUsage's narrower success/failed/cancelled
// status field without a cast.
const FAILURE_MAP: Record<string, "failed" | "cancelled"> = {
  failed: "failed",
  cancelled: "cancelled",
  dead_letter: "failed",
};

/**
 * Reconcile ONE job against the agent-service's own record of it — polls,
 * terminalizes a failure/cancellation locally (refund → claim → update →
 * task sync → usage log), and reports what it did.
 *
 * Extracted from `src/app/api/agent-service/reconcile/route.ts` so the same
 * logic backs both the ~10-minute stuck-job sweep AND an on-demand single-job
 * check (`refreshJobStatusAction`, fired right after a manual Force Cancel) —
 * a client-facing cancel request only asks the agent-service to stop the run;
 * this is what actually resolves the local `Job.status` afterward, and having
 * one implementation means the manual path can't drift from the cron's.
 *
 * Idempotent with the webhook via `claimExternalJobCompletion` — whichever
 * runs first wins. A `done` job is deliberately left alone: its deliverables
 * are attached only by the webhook's artifact re-host, and claiming it here
 * would permanently block the webhook's durable redelivery (the claim is
 * single-use), losing the assets.
 */
export async function reconcileOneJob(job: Job): Promise<{ action: string }> {
  const serviceJobId = job.external?.serviceJobId;
  if (!serviceJobId) return { action: "not a managed job — nothing to reconcile" };

  const remote = await getAgentServiceJob(serviceJobId);
  if (remote.status === "done") {
    return { action: "done on service — awaiting webhook, left for redelivery" };
  }
  const mapped = FAILURE_MAP[remote.status];
  if (!mapped) {
    return { action: `still ${remote.status}` };
  }

  // Client-charged custom-agent runs: hand the credits back when the run died
  // without deliverables (no-op for staff-fired jobs; idempotent via
  // refund_<chargeEntryId>). BEFORE the claim — the claim is single-use, so a
  // refund attempted after it has no retry path. On failure, leave this job
  // stuck: the next pass (cron or another manual check) retries both writes.
  try {
    await refundJobCharge(job.id, `Auto-refund · run ${remote.status} (webhook missed) · ${job.agentName}`.slice(0, 120));
  } catch (e) {
    return { action: `refund failed — left for next pass: ${e instanceof Error ? e.message : "unknown"}` };
  }

  const claimed = await claimExternalJobCompletion(job.id, mapped);
  if (!claimed) {
    return { action: "already reconciled" };
  }

  await updateJob(job.id, {
    error: remote.error ?? remote.status,
    events: [
      ...job.events,
      {
        at: Date.now(),
        level: "error",
        message: `Reconciled from agent service: ${remote.status} (webhook missed)`,
      },
    ],
    external: {
      ...job.external!,
      ...(remote.agentsRepoSha ? { agentsRepoSha: remote.agentsRepoSha } : {}),
      ...(remote.model ? { model: remote.model } : {}),
      ...(remote.usage?.totalCostUsd !== undefined ? { totalCostUsd: remote.usage.totalCostUsd } : {}),
    },
    updatedAt: Date.now(),
  });

  // Release the board task that dispatched this run (if any) and refund its
  // execution charge — mirrors the webhook's failure path.
  await syncTaskForJobOutcome(job.id, job.clientId, {
    ok: false,
    error: `Agent run ${remote.status} (webhook missed)`,
  }).catch(() => {});

  // Alert on "failed" only — "cancelled" is a deliberate stop, not a failure.
  // This is the ONE implementation behind both the ~10-min cron sweep and the
  // on-demand refreshJobStatusAction, so this single hook covers both paths a
  // missed webhook can be recovered through.
  if (mapped === "failed") {
    const client = await getClient(job.clientId).catch(() => null);
    await notifyJobFailure(
      { ...job, status: mapped, error: remote.error ?? remote.status },
      client,
    );
  }

  // Mirror the webhook's per-model usage logging — without this, spend on a
  // run recovered here (rather than via the webhook) never reaches
  // usageLogs/analyticsSnapshot and is invisible to the leaderboard.
  // `mapped` is already "failed" or "cancelled" (FAILURE_MAP) — pass it
  // through rather than hardcoding "failed", so a deliberately cancelled run
  // recovered here doesn't inflate the failedRuns/failedCostUsd reliability
  // signal the same way a genuine breakage should (usage-log.ts).
  const models = remote.usage?.models;
  if (models && Object.keys(models).length > 0) {
    for (const [modelName, usage] of Object.entries(models)) {
      logger.logUsage({
        clientId: job.clientId,
        agentId: "agent-service",
        agentName: job.agentName,
        modelName,
        operation: "managed_job",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        jobId: job.id,
        status: mapped,
        errorMessage: remote.error ?? remote.status,
      });
    }
  } else {
    logger.logUsage({
      clientId: job.clientId,
      agentId: "agent-service",
      agentName: job.agentName,
      modelName: remote.model ?? "unknown",
      operation: "managed_job",
      inputTokens: 0,
      outputTokens: 0,
      jobId: job.id,
      status: mapped,
      errorMessage: remote.error ?? remote.status,
    });
  }

  return { action: `reconciled → ${mapped}` };
}
