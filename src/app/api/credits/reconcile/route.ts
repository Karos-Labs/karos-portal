import { type NextRequest, NextResponse } from "next/server";
import {
  listStuckLocalJobs,
  listStuckTaskExecutions,
  reconcileStuckJob,
  reconcileStuckTaskExecution,
  type ReconcileResult,
} from "@/lib/credit-reconcile";

export const maxDuration = 60;

/**
 * Safety net for client-charged background work whose deferred run died
 * (instance recycle/timeout): the charge was taken upfront, the work is stuck
 * "executing"/"running", and no refund ever happened. Sweeps
 *   - client task executions stuck past the threshold → released to pending;
 *   - platform-local jobs stuck queued/running → flipped to failed;
 * and refunds each one's unpaired charge in the same transaction. Refunds are
 * idempotent (deterministic `refund_<chargeEntryId>` ledger doc, tx.create),
 * so re-runs, overlaps, and crash-retries never double-refund — this is also
 * the retry for refund writes that failed mid-reconcile.
 *
 * Agent-service jobs the service actually accepted (serviceJobId recorded)
 * are excluded — the webhook and /api/agent-service/reconcile own those,
 * including the refund for client-charged custom-agent runs. Agent-service
 * jobs whose submit crashed before the service saw them (no serviceJobId)
 * ARE swept here, after a longer staleness — that's the only reconciler that
 * can refund their upfront charge.
 *
 * Schedule via Cloud Scheduler (~10 min): GET, Authorization: Bearer <CRON_SECRET>.
 * 30 min staleness: far beyond any live after() run, so a swept item is
 * genuinely dead, not slow.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("Authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const staleBefore = Date.now() - STALE_AFTER_MS;
  const [tasks, jobs] = await Promise.all([
    listStuckTaskExecutions(staleBefore),
    listStuckLocalJobs(staleBefore),
  ]);

  const results: Array<{ kind: "task" | "job"; id: string } & ReconcileResult> = [];
  let refunded = 0;

  for (const task of tasks) {
    try {
      const r = await reconcileStuckTaskExecution(task.id, staleBefore);
      if (r.refunded) refunded += r.amount ?? 0;
      results.push({ kind: "task", id: task.id, ...r });
    } catch (e) {
      results.push({
        kind: "task",
        id: task.id,
        action: "skipped",
        detail: `error: ${e instanceof Error ? e.message : "unknown"}`,
        refunded: false,
      });
    }
  }

  for (const job of jobs) {
    try {
      const r = await reconcileStuckJob(job.id, staleBefore);
      if (r.refunded) refunded += r.amount ?? 0;
      results.push({ kind: "job", id: job.id, ...r });
    } catch (e) {
      results.push({
        kind: "job",
        id: job.id,
        action: "skipped",
        detail: `error: ${e instanceof Error ? e.message : "unknown"}`,
        refunded: false,
      });
    }
  }

  return NextResponse.json({
    checked: { tasks: tasks.length, jobs: jobs.length },
    creditsRefunded: refunded,
    results,
  });
}
