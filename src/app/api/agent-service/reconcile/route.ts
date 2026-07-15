import { type NextRequest, NextResponse } from "next/server";
import { claimExternalJobCompletion, listStuckManagedJobs, updateJob } from "@/lib/data";
import { getAgentServiceJob, isAgentServiceConfigured } from "@/lib/agent-service/client";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { syncTaskForJobOutcome } from "@/lib/task-sync";
import type { JobStatus } from "@/lib/types";
import { requireCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;

/**
 * Safety net for managed jobs whose completion webhook never arrived (delivery
 * exhausted its retries during a platform outage/deploy). Polls the agent
 * service for jobs stuck queued/running past a threshold.
 *
 * Only FAILURE outcomes are terminalized here — they carry no client artifacts,
 * so flipping the record to "failed" is complete. A `done` job is deliberately
 * left alone: its deliverables are attached only by the webhook's artifact
 * re-host, and claiming it here would permanently block the webhook's durable
 * redelivery (the claim is single-use), losing the assets. A `done` job stuck
 * past the window is surfaced (not silently flipped) for monitoring.
 *
 * Idempotent with the webhook via claimExternalJobCompletion — whichever runs
 * first wins. Schedule via Cloud Scheduler (~10 min): GET, Authorization: Bearer <CRON_SECRET>.
 */
const STALE_AFTER_MS = 20 * 60 * 1000;

// Failure outcomes only — `done` is left for the webhook (see above).
const FAILURE_MAP: Record<string, JobStatus> = {
  failed: "failed",
  cancelled: "failed",
  dead_letter: "failed",
};

export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  if (!isAgentServiceConfigured()) {
    return NextResponse.json({ skipped: true, reason: "agent service not configured" });
  }

  const stuck = await listStuckManagedJobs(Date.now() - STALE_AFTER_MS);
  const results: Array<{ jobId: string; action: string }> = [];

  for (const job of stuck) {
    const serviceJobId = job.external?.serviceJobId;
    if (!serviceJobId) continue;
    try {
      const remote = await getAgentServiceJob(serviceJobId);
      if (remote.status === "done") {
        // Deliverables must come through the webhook — don't claim/flip here.
        results.push({ jobId: job.id, action: "done on service — awaiting webhook, left for redelivery" });
        continue;
      }
      const mapped = FAILURE_MAP[remote.status];
      if (!mapped) {
        results.push({ jobId: job.id, action: `still ${remote.status}` });
        continue;
      }
      // Client-charged custom-agent runs: hand the credits back when the run
      // died without deliverables (no-op for staff-fired jobs; idempotent via
      // refund_<chargeEntryId>). BEFORE the claim — the claim is single-use,
      // so a refund attempted after it has no retry path. On failure, skip
      // this job entirely: it stays stuck, and the next cron pass retries
      // both writes.
      try {
        await refundJobCharge(job.id, `Auto-refund · run ${remote.status} (webhook missed) · ${job.agentName}`.slice(0, 120));
      } catch (e) {
        results.push({
          jobId: job.id,
          action: `refund failed — left for next pass: ${e instanceof Error ? e.message : "unknown"}`,
        });
        continue;
      }
      const claimed = await claimExternalJobCompletion(job.id, mapped);
      if (!claimed) {
        results.push({ jobId: job.id, action: "already reconciled" });
        continue;
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
      // Release the board task that dispatched this run (if any) and refund
      // its execution charge — mirrors the webhook's failure path.
      await syncTaskForJobOutcome(job.id, job.clientId, {
        ok: false,
        error: `Agent run ${remote.status} (webhook missed)`,
      }).catch(() => {});
      results.push({ jobId: job.id, action: `reconciled → ${mapped}` });
    } catch (e) {
      results.push({ jobId: job.id, action: `error: ${e instanceof Error ? e.message : "unknown"}` });
    }
  }

  return NextResponse.json({ checked: stuck.length, results });
}
