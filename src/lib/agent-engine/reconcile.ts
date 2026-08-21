import "server-only";
import { updateJob } from "@/lib/data";
import { readAgentEngineRun, type AgentEngineRunRecord, type AgentEngineRunView } from "./read-run";
import type { Job } from "@/lib/types";

/**
 * agent-engine's own run status → karosCMO's `JobStatus`, mirroring
 * `src/app/api/agent-service/webhook/route.ts`'s own `STATUS_MAP` exactly
 * where a precedent exists (`completed` → `"review"` — output ready,
 * awaiting employee/client review, same as the legacy webhook's `done`;
 * `failed`/`degraded` → `"failed"`, same as the legacy webhook's
 * `failed`/`dead_letter`). `held`/`blocked_intake` have no legacy
 * precedent (agent-service has no equivalent concept) — folded into
 * `"failed"` with a distinguishing `job.error`, matching the codebase's own
 * existing convention of folding "produced no real deliverable" outcomes
 * into `"failed"` rather than inventing a new `JobStatus` value (see that
 * same webhook route's own comment on a wall-clock-killed run: "this sat in
 * the same queue as a genuine [failure]... status = 'failed'"). `running`
 * and `awaiting_gate` both stay in-flight from the portal's `job.status`
 * point of view — `awaiting_gate`'s pending-approval UI is a job of
 * `AgentEngineRunPanel`/`AgentEngineGateApproval`, not `job.status` itself.
 */
function terminalJobUpdate(run: AgentEngineRunRecord): { status: Job["status"]; error?: string } | undefined {
  switch (run.status) {
    case "completed":
      return { status: "review" };
    case "failed":
    case "degraded":
      return { status: "failed", error: run.failureReason ?? `agent-engine run ${run.status}` };
    case "held":
      return { status: "failed", error: run.reason ?? "Run held — nothing cleared the delivery gates." };
    case "blocked_intake":
      return { status: "failed", error: run.reason ?? "Run blocked — missing client input." };
    case "running":
    case "awaiting_gate":
      return undefined;
  }
}

/**
 * The Task 2 "reverse completion channel": reads `agentEngineRuns/{runId}`
 * and, once it has reached a real terminal state, writes the equivalent
 * `job.status`/`job.error` onto the karosCMO `jobs` doc — the only way
 * `job.status` ever changes for a job dispatched through agent-engine
 * (there is no reverse webhook; agent-engine doesn't know karosCMO's job
 * ids or have a callback URL to hit). Idempotent and safe to call as often
 * as you like: a no-op once `job.status` already reflects the run's
 * outcome, and a no-op for a job with no `agentEngineRunId` at all.
 *
 * Called from two places, so completion is caught whether or not anyone is
 * looking: the Job detail page (`src/app/(app)/jobs/[id]/page.tsx`, so
 * opening the page while a run finishes shows the real status immediately)
 * and the periodic sweep (`src/app/api/agent-engine/reconcile/route.ts`,
 * mirroring the legacy agent-service reconcile cron for jobs nobody is
 * actively viewing).
 */
export async function syncAgentEngineJobStatus(job: Job): Promise<Job> {
  if (!job.agentEngineRunId) return job;
  const view = await readAgentEngineRun(job.agentEngineRunId);
  if (!view) return job; // dispatched, not yet visible in Firestore — nothing to sync yet
  return syncAgentEngineJobStatusFromView(job, view);
}

/**
 * Same sync, for a caller that already fetched the run view for its own
 * purposes (the Job detail page reads it to render `AgentEngineRunPanel`
 * regardless) — avoids a second, redundant Firestore round trip.
 */
export async function syncAgentEngineJobStatusFromView(job: Job, view: AgentEngineRunView): Promise<Job> {
  const update = terminalJobUpdate(view.run);
  if (!update) return job; // still in flight — job.status already correctly says so
  if (job.status === update.status && job.error === update.error) return job; // already synced

  await updateJob(job.id, { ...update, updatedAt: Date.now() });
  return { ...job, ...update };
}
