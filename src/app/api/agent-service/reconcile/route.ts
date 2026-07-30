import { type NextRequest, NextResponse } from "next/server";
import { listStuckManagedJobs } from "@/lib/data";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { reconcileOneJob } from "@/lib/agent-service/reconcile-job";
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
 * The per-job logic lives in `reconcileOneJob` (lib/agent-service/reconcile-job.ts),
 * shared with the on-demand single-job check the Control Room's Force Cancel
 * fires immediately after requesting a cancellation — one implementation for
 * both the ~10-minute sweep and the manual fast path.
 *
 * Idempotent with the webhook via claimExternalJobCompletion — whichever runs
 * first wins. Schedule via Cloud Scheduler (~10 min): GET, Authorization: Bearer <CRON_SECRET>.
 */
const STALE_AFTER_MS = 20 * 60 * 1000;

export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  if (!isAgentServiceConfigured()) {
    return NextResponse.json({ skipped: true, reason: "agent service not configured" });
  }

  const stuck = await listStuckManagedJobs(Date.now() - STALE_AFTER_MS);
  const results: Array<{ jobId: string; action: string }> = [];

  for (const job of stuck) {
    if (!job.external?.serviceJobId) continue;
    try {
      const { action } = await reconcileOneJob(job);
      results.push({ jobId: job.id, action });
    } catch (e) {
      results.push({ jobId: job.id, action: `error: ${e instanceof Error ? e.message : "unknown"}` });
    }
  }

  return NextResponse.json({ checked: stuck.length, results });
}
