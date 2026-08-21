import { type NextRequest, NextResponse } from "next/server";
import { listInFlightAgentEngineJobs } from "@/lib/data";
import { syncAgentEngineJobStatus } from "@/lib/agent-engine/reconcile";
import { requireCronSecret } from "@/lib/cron-auth";

export const maxDuration = 60;

/**
 * The Task 2 reverse-completion sweep for agent-engine-dispatched jobs —
 * the periodic half of the completion channel (the other half is the Job
 * detail page's own on-view sync, `syncAgentEngineJobStatusFromView`, for
 * whoever is actively watching a run). Catches every other case: a
 * completed run nobody happened to open the Job page for.
 *
 * Unlike `/api/agent-service/reconcile` (which polls a THIRD PARTY that
 * might never answer), this sweep reads agent-engine's own Firestore
 * records directly — there's no "the answer might not exist yet" case to
 * special-case, only "not terminal yet," which `syncAgentEngineJobStatus`
 * already treats as a no-op. Schedule via Cloud Scheduler, same convention
 * as the agent-service sweep: GET, Authorization: Bearer <CRON_SECRET>.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const inFlight = await listInFlightAgentEngineJobs();
  const results: Array<{ jobId: string; status: string }> = [];

  for (const job of inFlight) {
    try {
      const synced = await syncAgentEngineJobStatus(job);
      results.push({ jobId: job.id, status: synced.status });
    } catch (e) {
      results.push({ jobId: job.id, status: `error: ${e instanceof Error ? e.message : "unknown"}` });
    }
  }

  return NextResponse.json({ checked: inFlight.length, results });
}
