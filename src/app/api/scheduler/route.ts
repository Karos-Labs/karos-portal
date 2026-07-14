import { type NextRequest, NextResponse } from "next/server";
import {
  claimScheduledRun,
  getClient,
  getCustomAgent,
  listDueScheduledRuns,
  updateScheduledRun,
} from "@/lib/data";
import { submitCustomAgentRun } from "@/lib/agent-service/run-custom-agent";
import { computeNextRunAt } from "@/lib/run-cadence";

export const maxDuration = 120;

/**
 * Recurring-generator cron. Every tick it fires the ScheduledRuns whose
 * nextRunAt has passed — each one submits a `custom` agent-service job (the
 * referenced CustomAgent supplies the entry skill + instructions). System-fired
 * and free: scheduled runs never charge the client's credits. Draft-first is
 * preserved downstream — the webhook lands every deliverable as a draft.
 *
 * Idempotent under redelivery/overlap: claimScheduledRun is a compare-and-set on
 * nextRunAt, so only one tick advances a given run and no window double-fires.
 */
export async function GET(req: NextRequest) {
  // Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = Date.now();
  const due = await listDueScheduledRuns({ before: now, limit: 25 });
  if (due.length === 0) {
    return NextResponse.json({ processed: 0, fired: 0, results: [] });
  }

  type RunResult = {
    scheduledRunId: string;
    status: "fired" | "skipped" | "failed" | "disabled";
    jobId?: string;
    error?: string;
  };

  const settled = await Promise.allSettled(
    due.map(async (run): Promise<RunResult> => {
      // Claim first (advancing nextRunAt to the next slot) so a concurrent tick,
      // or a submit that throws, can't fire the same window twice.
      const nextRunAt = computeNextRunAt(run.cadence, now);
      const claimed = await claimScheduledRun(run.id, run.nextRunAt, nextRunAt);
      if (!claimed) return { scheduledRunId: run.id, status: "skipped" };

      const [agent, client] = await Promise.all([
        getCustomAgent(run.agentId),
        getClient(run.clientId),
      ]);
      if (!agent || !agent.enabled || !client) {
        // The agent was deleted/disabled or the client vanished — disable the
        // row so it stops churning every tick until an admin fixes it.
        await updateScheduledRun(run.id, { enabled: false, updatedAt: Date.now() });
        return {
          scheduledRunId: run.id,
          status: "disabled",
          error: !client ? "Client not found" : "Agent missing or disabled",
        };
      }

      const result = await submitCustomAgentRun({
        agent,
        client,
        prompt: run.prompt,
        actor: { uid: "scheduler", name: "Scheduler", role: "staff" },
        extraMetadata: {
          asset_type: run.assetType,
          ...(run.platform ? { platform: run.platform } : {}),
        },
        charge: null, // system-fired runs never bill the client
      });

      if (result.error) {
        return { scheduledRunId: run.id, status: "failed", jobId: result.jobId, error: result.error };
      }
      await updateScheduledRun(run.id, { lastJobId: result.jobId ?? null, updatedAt: Date.now() });
      return { scheduledRunId: run.id, status: "fired", jobId: result.jobId };
    }),
  );

  const results: RunResult[] = settled.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { scheduledRunId: "unknown", status: "failed", error: "Unexpected rejection" },
  );

  return NextResponse.json({
    processed: due.length,
    fired: results.filter((r) => r.status === "fired").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}
