import { type NextRequest, NextResponse } from "next/server";
import {
  listStuckLocalJobs,
  listStuckTaskExecutions,
  reconcileStuckJob,
  reconcileStuckTaskExecution,
  type ReconcileResult,
} from "@/lib/credit-reconcile";
import {
  UNSETTLED_AFTER_MS,
  listUnsettledHolds,
  markHoldSwept,
  settleJobCharge,
} from "@/lib/credit-settle";
import { archiveStaleCompletedTasks } from "@/lib/data";
import { findDispatchingTask } from "@/lib/task-sync";
import { isCreditsPlanV2Enabled } from "@/lib/credits";
import { requireCronSecret } from "@/lib/cron-auth";

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
  const denied = requireCronSecret(req);
  if (denied) return denied;

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

  // ── Unsettled holds (credits rework, 2026-09) ──
  //
  // The webhook settles inline, AFTER its single-use claim — so a crash between
  // the two loses the settlement and webhook redelivery cannot recover it (a
  // redelivery short-circuits at "Already processed"). This is that retry, and
  // it is the reason the settlement is allowed to sit after the claim at all.
  //
  // Safe to run forever and safe to overlap with itself or with the webhook:
  // the settlement doc id is `settle_<chargeEntryId>` written with tx.create(),
  // so a duplicate aborts rather than pays, and a charge that was refunded in
  // the meantime is declined inside the same transaction.
  //
  // GATED ON THE FLAG, and the gate covers the LISTING and the BOOKMARK as well
  // as the settlement itself. `settleJobCharge` refuses on its own while the
  // rework is dark, but `markHoldSwept` is a production write to the `jobs`
  // collection, and performing it for a feature that is switched off is exactly
  // the contract `isCreditsPlanV2Enabled` promises not to break — worse, it
  // would bookmark every delivered job as "decided" before a single settlement
  // could run, so flipping the flag on later would find an empty candidate set.
  const settleBefore = Date.now() - UNSETTLED_AFTER_MS;
  let settled = 0;
  let settledJobs = 0;
  let holdsChecked = 0;
  if (isCreditsPlanV2Enabled()) {
    let candidates: Awaited<ReturnType<typeof listUnsettledHolds>> = [];
    try {
      candidates = await listUnsettledHolds(settleBefore);
    } catch (e) {
      console.error("[reconcile] unsettled-hold listing failed:", e);
    }
    holdsChecked = candidates.length;
    for (const job of candidates) {
      // PER CANDIDATE, not around the loop. A settlement racing the webhook
      // aborts with ALREADY_EXISTS by design — that is the deterministic id
      // doing its job — and a single such race must not abandon every remaining
      // candidate, which is what a try around the whole loop did.
      try {
        // BOTH PAIRING KEYS, exactly as the webhook passes them. A board-task
        // dispatch is charged under the TASK id before the job exists, and the
        // job itself is submitted by the non-billable task engine, so nothing
        // is ever filed under `job.id` for it. Sweeping on the job id alone
        // found no hold for the ordinary way a client spends agent credits —
        // and then, before the fix below, bookmarked the job as decided.
        const task = await findDispatchingTask(job.id, job.clientId).catch(() => null);
        const r = await settleJobCharge(
          [job.id, task?.id],
          job.external?.totalCostUsd,
          job.agentName,
          job.id,
        );
        if (r.settled) {
          settledJobs += 1;
          settled += r.delta ?? 0;
        }
        // ONLY when the hold's fate is decided — settled, refunded, already
        // settled, or exempt. "No hold found" is not a verdict, it is a lookup
        // that came back empty, and bookmarking on it is how a stranded hold
        // becomes permanently unreachable.
        if (r.definitive) await markHoldSwept(job.id);
      } catch (e) {
        console.error(`[reconcile] settlement failed for job ${job.id}:`, e);
      }
    }
  }

  // Task-board archiving sweep rides the same maintenance cron: the active
  // view already hides tasks Done ≥7d at query level (listClientTasks), so
  // this just catches the stored documents up — detached from any page load.
  let archived = 0;
  try {
    archived = await archiveStaleCompletedTasks();
  } catch (e) {
    console.error("[reconcile] archive sweep failed:", e);
  }

  return NextResponse.json({
    checked: { tasks: tasks.length, jobs: jobs.length },
    creditsRefunded: refunded,
    // Signed: positive means holds were over-estimates and credits went back.
    holdsChecked,
    holdsSettled: settledJobs,
    creditsSettled: settled,
    tasksArchived: archived,
    results,
  });
}
