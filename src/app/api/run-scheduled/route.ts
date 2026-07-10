import { type NextRequest, NextResponse } from "next/server";
import { getUser, listDueScheduledRuns, updateScheduledRun } from "@/lib/data";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { computeNextRun } from "@/lib/scheduled-runs";
import type { AppUser, ScheduledRun } from "@/lib/types";

export const maxDuration = 120;

/**
 * Scheduled-run cron. Every tick it drains active ScheduledRuns whose nextRunAt
 * has passed and fires the custom agent via the same core the web action uses
 * (submitCustomAgentJob) — so a scheduled run is indistinguishable from a manual
 * one once it fires. One-off runs complete; recurring runs advance to their next
 * slot. The actor is the staff creator, so runs never charge client credits.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = Date.now();
  const due = await listDueScheduledRuns(now, 25);
  if (due.length === 0) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  // The run's creator is the acting user (for provenance / activity logs).
  // Fall back to a synthetic system actor if that account is gone.
  const actorCache = new Map<string, AppUser>();
  async function actorFor(run: ScheduledRun): Promise<AppUser> {
    const cached = actorCache.get(run.createdBy);
    if (cached) return cached;
    const user = (await getUser(run.createdBy)) ?? ({ uid: run.createdBy || "scheduler", name: "Scheduler" } as AppUser);
    actorCache.set(run.createdBy, user);
    return user;
  }

  type RunResult = { runId: string; status: "submitted" | "failed"; jobId?: string; error?: string };

  // Sequential (not concurrent) — each submission is a network round-trip to the
  // agent service, and a tick's batch is capped at 25, so ordering keeps the
  // service's queue predictable without risking a timeout.
  const results: RunResult[] = [];
  for (const run of due) {
    try {
      const actor = await actorFor(run);
      const { jobId, error } = await submitCustomAgentJob(actor, {
        clientId: run.clientId,
        agentId: run.customAgentId,
        prompt: run.prompt,
      });

      const advance: Partial<ScheduledRun> = {
        lastRunAt: now,
        ...(jobId ? { lastJobId: jobId } : {}),
        updatedAt: Date.now(),
      };
      if (run.cadence === "once") {
        advance.status = "completed";
      } else {
        advance.nextRunAt = computeNextRun({
          cadence: run.cadence,
          hour: run.hour,
          minute: run.minute,
          weekday: run.weekday,
          dayOfMonth: run.dayOfMonth,
          from: now,
        });
      }
      await updateScheduledRun(run.id, advance);

      results.push(error ? { runId: run.id, status: "failed", error, jobId } : { runId: run.id, status: "submitted", jobId });
    } catch (e) {
      // Leave the run active so the next tick retries; record nothing destructive.
      results.push({ runId: run.id, status: "failed", error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return NextResponse.json({
    processed: due.length,
    submitted: results.filter((r) => r.status === "submitted").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}
