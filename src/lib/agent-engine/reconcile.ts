import "server-only";
import { after } from "next/server";
import { updateJob } from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { settleJobCharge } from "@/lib/credit-settle";
import { logger } from "@/services/logger";
import { materializeAgentEngineDeliverable } from "./materialize";
import {
  readAgentEngineRun,
  totalStepCostUsd,
  type AgentEngineRunRecord,
  type AgentEngineRunView,
} from "./read-run";
import type { Job } from "@/lib/types";

/**
 * What this run cost Karos, in USD, or undefined when the engine reported
 * nothing at all.
 *
 * THE ONE TELEMETRY GAP THE CREDITS REWORK HAD TO CLOSE (2026-09). agent-engine
 * has always known this figure and the portal has always RENDERED it live
 * (`AgentEngineRunPanel`), but `syncAgentEngineJobStatusFromView` wrote only
 * status/error/assetIds, so nothing was ever persisted onto the job — and a
 * settlement can only reconcile against a cost it can read back. Every other
 * execution path already stored one (`job.external.totalCostUsd` from the
 * agent-service webhook; `usageLogs.estimatedCostUsd` for in-app calls), so this
 * was the last product family that could not be settled at all.
 *
 * Run-level first, step-sum second: the run record's own total is authoritative
 * once the run is terminal, and the step sum is what a run that finished before
 * the total was written still has. Zero is treated as "nothing reported" rather
 * than "free" — the same rule `summarizeAgentEconomics` and the settlement path
 * both apply, because a $0 run is a measurement failure, not a gift.
 */
function engineRunCostUsd(view: AgentEngineRunView): number | undefined {
  const runTotal = view.run.totalCostUsd;
  if (typeof runTotal === "number" && Number.isFinite(runTotal) && runTotal > 0) return runTotal;
  // `?? []` because a run view can legitimately carry no step records yet (a
  // run that finished before step checkpointing, or one still writing them).
  const stepTotal = totalStepCostUsd(view.steps ?? []);
  return stepTotal > 0 ? stepTotal : undefined;
}

/**
 * The fields a terminal transition writes — spelled out so `held`'s
 * `heldReason` and a failure's `error` can never be the same slot by accident.
 *
 * BOTH ARE ALWAYS WRITTEN, one of them as `null`, and that is deliberate rather
 * than tidy. `updateJob` is `set(..., { merge: true })`, and an agent-engine run
 * is genuinely re-enterable — `RESUMABLE_FROM_STATUSES` over there admits
 * `held`, `failed` and `degraded` — so a run that was held, resumed and then
 * completed passes through this function two or three times. Writing only the
 * field that applies would leave the previous transition's text sitting on the
 * doc forever: a delivered job still carrying "topics catalog floor breached",
 * with the Job page's danger card gated on the FIELD rather than the status and
 * therefore still painting it. This mirrors, on purpose, the exact discipline
 * `WorkflowEngine.terminalPatch` already applies to `failureReason`/`reason`/
 * `pendingGateId` on the run record for the same reason.
 */
interface TerminalJobUpdate {
  status: Job["status"];
  error: string | null;
  heldReason: string | null;
  /**
   * SCRUM-404's third slot, written on every transition for exactly the reason
   * the other two are: a run that was blocked, resumed and then completed
   * would otherwise deliver with "missing client profile" still sitting on the
   * doc, and the client-facing banner is gated on the FIELD.
   */
  blockedReason: string | null;
}

/**
 * agent-engine's own run status → karosCMO's `JobStatus`, mirroring
 * `src/app/api/agent-service/webhook/route.ts`'s own `STATUS_MAP` exactly
 * where a precedent exists (`completed` → `"review"` — output ready,
 * awaiting employee/client review, same as the legacy webhook's `done`;
 * `failed`/`degraded` → `"failed"`, same as the legacy webhook's
 * `failed`/`dead_letter`).
 *
 * `held` NOW MAPS TO ITS OWN `"held"` STATUS, and the note that used to stand
 * here is worth quoting because it was the defect: it said `held` had "no
 * legacy precedent (agent-service has no equivalent concept)" and was
 * therefore "folded into `failed` with a distinguishing `job.error`, matching
 * the codebase's own existing convention". Both halves were true and the
 * conclusion still came out wrong. agent-engine's own outcome taxonomy calls
 * `held` "a legitimate, non-failure empty result" and says in as many words
 * that conflating it with `failed` "is exactly the bug this taxonomy exists to
 * prevent" — so the absence of a legacy precedent was an argument for a new
 * `JobStatus` value, not against one. What shipped instead: a working
 * guardrail ("topics catalog floor breached", "engagement lane daily cap
 * reached") rendered as a red Error card, counted in the staff Jobs list's
 * failure chip, and auto-refunded as a breakage.
 *
 * `blocked_intake` deliberately STAYS on `failed`. It is not the same kind of
 * outcome: a run that never started because the client hasn't supplied their
 * profile is a real blockage somebody must act on, and it has no
 * agent-engine-side resume that fixes itself. Giving it a soft badge would
 * bury it. That is a separate decision from this one, and left where it was.
 *
 * `running` and `awaiting_gate` both stay in-flight from the portal's
 * `job.status` point of view — `awaiting_gate`'s pending-approval UI is a job
 * of `AgentEngineRunPanel`/`AgentEngineGateApproval`, not `job.status` itself.
 */
function terminalJobUpdate(run: AgentEngineRunRecord): TerminalJobUpdate | undefined {
  switch (run.status) {
    case "completed":
      return { status: "review", error: null, heldReason: null, blockedReason: null };
    case "failed":
    case "degraded":
      return { status: "failed", error: run.failureReason ?? `agent-engine run ${run.status}`, heldReason: null, blockedReason: null };
    case "held":
      // `reason`, not `failureReason` — the run record keeps those two apart for
      // this exact reason (see `RunRecord`'s own note), and only one of them is
      // a failure.
      return { status: "held", heldReason: run.reason ?? "Run held — nothing cleared the delivery gates.", error: null, blockedReason: null };
    case "blocked_intake":
      // SCRUM-404: the status is UNCHANGED (`failed`, and it still refunds) —
      // the note above says why, and calls a dedicated `JobStatus` a separate
      // decision. What changes is that the reason is now ALSO written to its
      // own slot, so a client's own agent screen can say "we are waiting on
      // something from you" without reading `error`, which the client-facing
      // surfaces deliberately do not show them (AF-14: a failure that is ours
      // is not the client's to attend to). A blocked intake is the one
      // non-delivery that genuinely IS theirs to clear, and until now it was
      // indistinguishable from an engine fault and therefore invisible to the
      // only person who could fix it.
      return {
        status: "failed",
        error: run.reason ?? "Run blocked — missing client input.",
        heldReason: null,
        blockedReason: run.reason ?? "Run blocked — missing client input.",
      };
    case "running":
    case "awaiting_gate":
      return undefined;
  }
}

/**
 * Whether a job is still in flight, for a caller that has ALREADY fetched
 * `agentEngineView` (or knows there is none) and just needs the boolean —
 * the exact predicate the Job detail page computed inline as `inProgress` /
 * `agentEngineTerminal` before SCRUM-265 item 1, now shared with the narrow
 * status route (`/api/jobs/[id]/status`) so the two can never drift apart.
 *
 * Reuses `terminalJobUpdate` rather than re-listing agent-engine's terminal
 * statuses a second time: a run is terminal here IFF `terminalJobUpdate`
 * would have something to write for it. A dispatched run whose Firestore
 * record isn't visible YET (`agentEngineView === undefined`) counts as still
 * in progress — it hasn't reached a terminal state, it just hasn't reached
 * ANY state this reader can see.
 */
export function isJobInProgress(job: Job, agentEngineView?: AgentEngineRunView): boolean {
  if (job.agentEngineRunId) {
    return agentEngineView === undefined || terminalJobUpdate(agentEngineView.run) === undefined;
  }
  return job.status === "running" || job.status === "queued";
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

interface PendingSyncWork {
  update: TerminalJobUpdate;
  statusChanged: boolean;
  costUsd: number | undefined;
  costChanged: boolean;
  /** The run completed and this job still holds no asset. */
  needsMaterialize: boolean;
  /** Anything at all left for a sync to persist. */
  needed: boolean;
}

/**
 * The pure "what would a sync of this job still write?" question, answered
 * once so that `syncAgentEngineJobStatusFromView` (which does the writes) and
 * `scheduleAgentEngineJobStatusSync` (which decides whether to defer one at
 * all) cannot disagree. Returns undefined while the run is not terminal.
 *
 * The scheduler used to defer a full sync on EVERY render of a terminal-run
 * Job page, whether or not anything was left to do — and every one of those
 * deferred syncs held the job as it was at render time. With the page
 * auto-refreshing every 4 s around completion, prep saw up to eight
 * materializations of one run land within 16 s. Asking this question first
 * means a fully synced job schedules nothing.
 */
function pendingSyncWork(job: Job, view: AgentEngineRunView): PendingSyncWork | undefined {
  const update = terminalJobUpdate(view.run);
  if (!update) return undefined;

  // Reads every field the transition writes: it compared `job.error` alone,
  // which was total only while every terminal outcome wrote `error`; with
  // `held` writing `heldReason` instead, an error-only comparison would call a
  // held job "already synced" the moment its status matched and never store the
  // reason at all. `?? null` on the job side because an untouched doc has the
  // field ABSENT while a transition writes an explicit `null` — the same value,
  // two spellings, and only one of them compares equal.
  const statusChanged = !(
    job.status === update.status &&
    (job.error ?? null) === update.error &&
    (job.heldReason ?? null) === update.heldReason &&
    // SCRUM-404: `blockedReason` joins the comparison for the same reason
    // `heldReason` did. `blocked_intake` already mapped to `failed`, so every
    // blocked job in Firestore right now compares equal on status AND error —
    // an update that ignored this slot would call them "already synced" and
    // never backfill the reason, leaving the new banner permanently blank on
    // exactly the runs it exists for.
    (job.blockedReason ?? null) === update.blockedReason
  );

  // What the run cost us, persisted onto the job the same way the agent-service
  // webhook persists its own `usage.totalCostUsd` — see engineRunCostUsd above.
  // Compared against what is already stored so a re-entered sync does not
  // rewrite an unchanged figure, and so a run that reports nothing never clears
  // one we already have.
  const costUsd = engineRunCostUsd(view);
  const costChanged = costUsd !== undefined && costUsd !== job.external?.totalCostUsd;

  const needsMaterialize = update.status === "review" && job.assetIds.length === 0;

  return { update, statusChanged, costUsd, costChanged, needsMaterialize, needed: statusChanged || costChanged || needsMaterialize };
}

/**
 * Same sync, for a caller that already fetched the run view for its own
 * purposes (the Job detail page reads it to render `AgentEngineRunPanel`
 * regardless) — avoids a second, redundant Firestore round trip.
 */
export async function syncAgentEngineJobStatusFromView(job: Job, view: AgentEngineRunView): Promise<Job> {
  const work = pendingSyncWork(job, view);
  if (!work) return job; // still in flight — job.status already correctly says so
  const { update, statusChanged, costUsd, costChanged } = work;

  // Whether the STATUS write is still needed. Reads every field the transition
  // writes: it compared `job.error` alone, which was total only while every
  // terminal outcome wrote `error`; with `held` writing `heldReason` instead, an
  // error-only comparison would call a held job "already synced" the moment its
  // status matched and never store the reason at all. `?? null` on the job side
  // because an untouched doc has the field ABSENT while a transition writes an
  // explicit `null` — the same value, two spellings, and only one of them
  // compares equal.

  // MATERIALIZATION IS NOT GATED ON THAT TRANSITION, and it used to be — which
  // is why the fix to `materialize.ts` would have healed nothing already on
  // disk. This function returned early the moment `job.status` matched, so a
  // job that reached `"review"` back when its product had no materializer was
  // permanently asset-less: every later page view and every reconcile sweep hit
  // the early return and never asked for the deliverable again. Prep's own
  // x-agent and linkedin-agent runs were all in exactly that state — completed,
  // "In review", nothing attached, and no path back.
  //
  // Asked as "the run completed and this job still has nothing" instead. Cheap
  // to re-ask: `materializeAgentEngineDeliverable` returns immediately for a job
  // that already has an asset or a product with no known deliverable shape, so
  // the only repeated work is for a completed run whose deliverable genuinely
  // cannot be fetched — one HTTP call per view of that job, which is the same
  // cost the transition path already paid.
  //
  // Still BEFORE the status write, for the original reason: a crash between the
  // two leaves `assetIds` populated and `status` stale, which the next call
  // recovers from, rather than a synced status with a deliverable nobody will
  // ever ask for again.
  let assetIds = job.assetIds;
  if (update.status === "review") {
    const assetId = await materializeAgentEngineDeliverable(job);
    if (assetId) assetIds = [...job.assetIds, assetId];
  }

  // `assetIds` is deliberately NOT part of this patch any more. The
  // materializer attaches its asset with `attachAssetToJob` (an `arrayUnion`);
  // writing `[...job.assetIds, assetId]` from here re-introduced the stale-
  // snapshot overwrite this function is called concurrently enough to lose —
  // every duplicated prep job had exactly one id on the job and the rest orphaned.
  if (!statusChanged && !costChanged) return { ...job, assetIds }; // already synced (or only the asset moved, and that write already landed)

  await updateJob(job.id, {
    ...(statusChanged ? update : {}),
    ...(costChanged ? { external: { ...job.external, totalCostUsd: costUsd } } : {}),
    updatedAt: Date.now(),
  });

  // Mirror the webhook's own usage logging. Without it, agent-engine spend
  // reaches neither `usageLogs` nor the leaderboard, and every cross-check of
  // the settlement ledger against our real cost (scripts/dump-agent-cost-report)
  // would read this whole product family as free. One run-level row, not one per
  // step: the engine's per-step model ids are not reported through this view, so
  // a per-step row would have to invent a model name.
  //
  // GATED ON THE TERMINAL TRANSITION, not on the cost moving. An agent-engine
  // run is genuinely re-enterable — held, resumed, completed — so `costChanged`
  // fires two or three times for one run as the total climbs, and a usage row
  // per firing would bill the leaderboard for the same run twice and inflate
  // every cost dashboard that sums this collection. `statusChanged` is true
  // exactly once per transition into a terminal state, which is once per
  // OUTCOME; a resumed run that reaches `review` after a hold logs on that
  // transition, with the full cost, which is the row we actually want.
  if (costChanged && statusChanged) {
    logger.logUsage({
      clientId: job.clientId,
      agentId: "agent-engine",
      agentName: job.agentName,
      // The pair `priceFor()` would key on is not available here — the cost
      // arrives already priced by the engine — so the row carries the engine's
      // own figure and names the product as the model. `logUsage` does not
      // re-price a row that already has a cost.
      modelName: view.run.productId,
      provider: "anthropic",
      operation: "agent_engine_run",
      inputTokens: 0,
      outputTokens: 0,
      // Already priced by the engine — see UsageInput.costUsd. Passing tokens
      // here would be inventing them.
      costUsd,
      jobId: job.id,
      status: update.status === "failed" ? "failed" : "success",
    });
  }

  // A failed engine run refunds, exactly like a failed agent-service one.
  //
  // This path never did. It did not matter while agent-engine only ran the
  // managed catalog, which does not charge per run; it started mattering the
  // moment custom agents began routing here, because those charge credits at
  // submission and the legacy path refunds every non-"done" outcome. A client
  // whose run was blocked -- by a topic guardrail, say -- would otherwise keep
  // paying for output they never received.
  //
  // `update.status`, NOT `view.run.status`, is the test — and now that `held`
  // has its own portal status they are no longer interchangeable. A held run
  // does not refund: it is re-entrant on agent-engine's side and can still
  // deliver on a resume, so refunding the hold and then delivering would credit
  // work the client received. `JobStatus`'s own `"held"` note carries that
  // decision and states its residual (a hold nobody resumes leaves the charge
  // standing); `blocked_intake` still maps to `failed` and so still refunds.
  //
  // After the status write, not before: refundJobCharge is idempotent per job,
  // and a crash between the two leaves a job correctly marked failed that the
  // next reconcile will refund, rather than a refunded job still showing as
  // running.
  //
  // `statusChanged &&` is load-bearing now that this function no longer returns
  // early on an already-synced job: without it, every page view of a failed job
  // would re-attempt the refund. It is idempotent per job so nothing would be
  // double-credited, but it would mean a Firestore transaction on every view.
  if (statusChanged && update.status === "failed") {
    await refundJobCharge(job.id, `Auto-refund · agent-engine run ${view.run.status} · ${job.agentName}`.slice(0, 120));
  }

  // A DELIVERED run settles its hold to what it actually cost us (credits
  // rework, 2026-09). Only `"review"` — the outcome where the client received
  // something:
  //   - `failed` refunded on the branch above, and a charge is either refunded
  //     or settled, never both (settleJobCharge re-checks that inside its own
  //     transaction, so the ordering here is belt to that brace, not the brace);
  //   - `held` deliberately neither refunds nor settles: agent-engine can resume
  //     it, and a run that later delivers must settle against its FULL cost, not
  //     against the partial one it had while held.
  // Not gated on `statusChanged`, unlike the refund: a job whose status was
  // already synced by an earlier deploy still has an unsettled hold, and
  // `settle_<chargeEntryId>` makes the retry free. It is gated on `costChanged`
  // for the same reason the refund is gated on `statusChanged` — otherwise every
  // page view of a settled job opens a Firestore transaction to learn nothing.
  if (update.status === "review" && costChanged) {
    // Guarded like the webhook's own call: a settlement racing another writer
    // aborts by design (the deterministic `settle_<chargeEntryId>` id doing its
    // job), and this function's other work — the status write, the
    // materialized deliverable — has already landed. Throwing here would turn a
    // delivered run into a failed page render and a failed cron tick. A lost
    // settlement leaves the estimate standing, which the sweep then retries.
    try {
      await settleJobCharge(job.id, costUsd, job.agentName, job.id);
    } catch (e) {
      console.error(`[agent-engine] settlement failed for job ${job.id}:`, e);
    }
  }

  return { ...job, ...update, assetIds };
}

/**
 * SCRUM-265 item 4 — "Stop writing during render on the job page."
 *
 * The Job detail page used to `await syncAgentEngineJobStatusFromView(...)`
 * directly in its render, which means every view of an in-flight or just-
 * finished agent-engine job blocked the response on a Firestore write (and,
 * on the completing view, on `materializeAgentEngineDeliverable`'s own HTTP
 * fetch + asset write + `reflowClientChain`) before the page could render at
 * all. None of that work affects what this render needs to SHOW — the status/
 * error/heldReason fields come straight out of `view` — only what gets
 * PERSISTED for the next request.
 *
 * This is the render-safe half: it computes the same transition purely (no
 * I/O) for THIS response, and — only when there is a real transition to
 * record — schedules the full, unmodified `syncAgentEngineJobStatusFromView`
 * (status write, materialize, refund, all of it) via `after()`, so it runs
 * once the response has already been sent. `after()` requires an active
 * request scope, which is exactly why this is a SEPARATE function from
 * `syncAgentEngineJobStatusFromView` rather than an `after()` call added
 * inside it — that function is also called synchronously, outside any
 * request, by the reconcile cron sweep (`/api/agent-engine/reconcile`) and by
 * this repo's own unit tests, and it needs its result (assetIds, status) back
 * immediately in both places.
 *
 * Known, accepted trade-off: a run whose completion is caught on THIS exact
 * page view no longer shows its freshly materialized deliverable in the same
 * response — `assetIds` isn't known until `materializeAgentEngineDeliverable`
 * actually runs, and that now happens after the response, not before it. It
 * appears on the next view of the page, or via the periodic reconcile sweep,
 * whichever comes first — the same "somebody will pick this up" guarantee the
 * sweep already exists to provide (see that route's own doc comment).
 */
export function scheduleAgentEngineJobStatusSync(job: Job, view: AgentEngineRunView): Job {
  const work = pendingSyncWork(job, view);
  if (!work) return job; // still in flight — nothing to schedule
  // Nothing left to persist: no status/cost delta and the asset is already
  // attached. Scheduling anyway is what turned every view of a finished job
  // into another materialization attempt racing the ones already in flight.
  if (!work.needed) return job;

  after(() => {
    syncAgentEngineJobStatusFromView(job, view).catch((error: unknown) => {
      // Best-effort, same as the other after()-deferred side effects in this
      // codebase (see cloudbuild.promote.yaml's --no-cpu-throttling note,
      // SCRUM-265 item 2) — a dropped tick here is caught by the next page
      // view or the next reconcile sweep, neither of which this function has
      // any way to force.
      console.error(`[agent-engine] deferred status sync failed for job ${job.id}`, error);
    });
  });

  // In-memory only — NOT what gets persisted (that's the deferred call
  // above). Good enough for this render: status/error/heldReason are exactly
  // what `view` already says, and assetIds is deliberately left as whatever
  // the caller already fetched with, per the trade-off noted above.
  return { ...job, ...work.update };
}
