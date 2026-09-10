import { type NextRequest, NextResponse } from "next/server";
import { listClients, listInFlightAgentEngineJobs, listUnmaterializedAgentEngineJobs } from "@/lib/data";
import { syncAgentEngineJobStatus } from "@/lib/agent-engine/reconcile";
import { syncClientKnowledgeToWorkspace } from "@/lib/agent-engine/knowledge-sync";
import { isWorkspaceWriterConfigured } from "@/lib/agent-engine/workspace-writer";
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
 *
 * TWO QUERIES, NOT ONE, because "needs reconciling" has two shapes and the
 * original only covered the first:
 *
 *  1. IN FLIGHT — `queued`/`running`. Does `job.status` know the run finished?
 *  2. UNMATERIALIZED — already at `review`, still holding no asset. The status
 *     is right and the DELIVERABLE is missing.
 *
 * The second was invisible here, and being terminal it was invisible to
 * everything else too: `syncAgentEngineJobStatus` on such a job used to hit an
 * early return, so it only ever healed if a human opened the Job page. Every
 * engine job delivered before its product had a materializer sat that way —
 * complete, "In review", nothing to review, and no path back that did not
 * involve clicking through them one at a time.
 *
 * The two sets are disjoint by construction (one is non-terminal, the other is
 * `review`), so nothing is synced twice in a tick.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const inFlight = await listInFlightAgentEngineJobs();
  const unmaterialized = await listUnmaterializedAgentEngineJobs();
  const results: Array<{ jobId: string; status: string; reason: "in_flight" | "unmaterialized" }> = [];

  for (const { job, reason } of [
    ...inFlight.map((job) => ({ job, reason: "in_flight" as const })),
    ...unmaterialized.map((job) => ({ job, reason: "unmaterialized" as const })),
  ]) {
    try {
      const synced = await syncAgentEngineJobStatus(job);
      // `assetIds.length` rather than just the status: for an unmaterialized job
      // the status was already right, so the status alone cannot say whether
      // this tick actually attached anything.
      results.push({ jobId: job.id, status: `${synced.status} (${synced.assetIds.length} asset(s))`, reason });
    } catch (e) {
      results.push({ jobId: job.id, status: `error: ${e instanceof Error ? e.message : "unknown"}`, reason });
    }
  }

  // Phase 4: the knowledge mirror rides the same tick. Cron-driven rather
  // than write-hooked BECAUSE three raw-batch writers bypass data.ts's write
  // path entirely (see knowledge-sync.ts's own doc comment) — polling every
  // engine-enabled client is the only seam that covers all of them. Cheap by
  // construction: three small docs per client, full-overwrite idempotent, and
  // skipped wholesale when no workspace bucket is configured. Best-effort per
  // client — a failed mirror must not block the job sweep's own results.
  const knowledge: Array<{ clientId: string; status: string }> = [];
  if (isWorkspaceWriterConfigured()) {
    const engineClients = (await listClients()).filter((c) => c.agentsRepoSlug);
    for (const client of engineClients) {
      try {
        const result = await syncClientKnowledgeToWorkspace(client);
        knowledge.push({
          clientId: client.id,
          status: `synced (${result.contextDocs} docs, ${result.transcripts} transcripts, ${result.assets} assets)`,
        });
      } catch (e) {
        knowledge.push({ clientId: client.id, status: `error: ${e instanceof Error ? e.message : "unknown"}` });
      }
    }
  }

  // `checked` keeps its original meaning (every job this tick looked at) so an
  // existing caller or dashboard reading it does not silently change what it
  // reports; the per-query counts are additive.
  return NextResponse.json({
    checked: inFlight.length + unmaterialized.length,
    inFlight: inFlight.length,
    unmaterialized: unmaterialized.length,
    results,
    knowledge,
  });
}
