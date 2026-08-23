import "server-only";
import { updateJob } from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { materializeAgentEngineDeliverable } from "./materialize";
import { readAgentEngineRun, type AgentEngineRunRecord, type AgentEngineRunView } from "./read-run";
import type { Job } from "@/lib/types";

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
      return { status: "review", error: null, heldReason: null };
    case "failed":
    case "degraded":
      return { status: "failed", error: run.failureReason ?? `agent-engine run ${run.status}`, heldReason: null };
    case "held":
      // `reason`, not `failureReason` — the run record keeps those two apart for
      // this exact reason (see `RunRecord`'s own note), and only one of them is
      // a failure.
      return { status: "held", heldReason: run.reason ?? "Run held — nothing cleared the delivery gates.", error: null };
    case "blocked_intake":
      return { status: "failed", error: run.reason ?? "Run blocked — missing client input.", heldReason: null };
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

  // Whether the STATUS write is still needed. Reads every field the transition
  // writes: it compared `job.error` alone, which was total only while every
  // terminal outcome wrote `error`; with `held` writing `heldReason` instead, an
  // error-only comparison would call a held job "already synced" the moment its
  // status matched and never store the reason at all. `?? null` on the job side
  // because an untouched doc has the field ABSENT while a transition writes an
  // explicit `null` — the same value, two spellings, and only one of them
  // compares equal.
  const statusChanged = !(
    job.status === update.status &&
    (job.error ?? null) === update.error &&
    (job.heldReason ?? null) === update.heldReason
  );

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
  const assetsChanged = assetIds !== job.assetIds;

  if (!statusChanged && !assetsChanged) return job; // already synced, nothing left to attach

  await updateJob(job.id, {
    ...(statusChanged ? update : {}),
    ...(assetsChanged ? { assetIds } : {}),
    updatedAt: Date.now(),
  });

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

  return { ...job, ...update, assetIds };
}
