import { type NextRequest, NextResponse } from "next/server";
import { claimExternalJobCompletion, listStuckManagedJobs, updateJob } from "@/lib/data";
import { getAgentServiceJob, isAgentServiceConfigured } from "@/lib/agent-service/client";
import type { JobStatus } from "@/lib/types";

export const maxDuration = 60;

/**
 * Safety net for managed jobs whose completion webhook never arrived (delivery
 * exhausted its retries during a platform outage/deploy). Polls the agent
 * service for jobs stuck queued/running past a threshold and syncs terminal
 * status. Idempotent with the webhook via claimExternalJobCompletion — whichever
 * runs first wins; artifact re-hosting still happens through the webhook, so
 * this only unsticks the job record (a follow-up webhook redelivery, or a manual
 * re-run, attaches assets).
 *
 * Schedule via Cloud Scheduler (every ~10 min): GET with Authorization: Bearer <CRON_SECRET>.
 */
const STALE_AFTER_MS = 20 * 60 * 1000;

const TERMINAL_MAP: Record<string, JobStatus> = {
  done: "review",
  failed: "failed",
  cancelled: "failed",
  dead_letter: "failed",
};

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("Authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
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
      const mapped = TERMINAL_MAP[remote.status];
      if (!mapped) {
        results.push({ jobId: job.id, action: `still ${remote.status}` });
        continue;
      }
      const claimed = await claimExternalJobCompletion(job.id, mapped);
      if (!claimed) {
        results.push({ jobId: job.id, action: "already reconciled" });
        continue;
      }
      await updateJob(job.id, {
        error: remote.status === "done" ? null : (remote.error ?? remote.status),
        events: [
          ...job.events,
          {
            at: Date.now(),
            level: remote.status === "done" ? "success" : "error",
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
      results.push({ jobId: job.id, action: `reconciled → ${mapped}` });
    } catch (e) {
      results.push({ jobId: job.id, action: `error: ${e instanceof Error ? e.message : "unknown"}` });
    }
  }

  return NextResponse.json({ checked: stuck.length, results });
}
