"use server";

import { revalidatePath } from "next/cache";
import { getJob, updateJob } from "@/lib/data";
import { cancelAgentServiceJob } from "@/lib/agent-service/client";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { reconcileOneJob } from "@/lib/agent-service/reconcile-job";
import type { Job, JobStatus } from "@/lib/types";
import { requireClientAccess, requireStaff } from "./_shared";

/*
 * submitManagedJobAction was removed with the managed-product run UI (F39/F45):
 * its only caller was managed-products.tsx, which nothing imported. The
 * submitManagedJob CORE is untouched — execution-engine.ts calls it when a
 * content_generation task resolves to a catalog product, so Social posts,
 * Newsletter issue, Blog article and Landing page still run from the client's
 * task board. There is NO MCP entry point to that core: the twelve tools in
 * src/lib/mcp/tools.ts start work only through `run_agent` (QA F118).
 */

/**
 * ONE line for every outcome a caller is not entitled to tell apart: the job
 * does not exist, belongs to another client, or is not a managed run. Distinct
 * messages here are an existence oracle over a global id space.
 */
const NOT_FOUND = "This run could not be found.";

/** Requests cancellation of a running agent-service job (managed or custom). */
export async function cancelManagedJobAction(jobId: string): Promise<{ error?: string }> {
  await requireStaff();
  return requestJobCancellation(jobId);
}

/**
 * The same cancellation, reachable by the client who is paying for the run.
 *
 * cancelManagedJobAction is requireStaff and lives on the staff-only run-detail
 * page, so a client who mis-fired a twenty-five-minute billable run had no way
 * to stop it and no way to reach the only page that could. Authorization is on
 * the JOB's own clientId — never a clientId supplied by the browser — and the
 * refund is already handled: refundJobCharge runs for every non-done outcome.
 */
export async function cancelClientAgentJobAction(jobId: string): Promise<{ error?: string }> {
  const job = await getJob(jobId);
  // AUTHORIZE BEFORE ANSWERING ABOUT EXISTENCE. This used to return "Not a
  // managed job." for an unknown id and only THEN authorize — so the two
  // outcomes had different shapes, and a client could walk job ids and learn
  // which ones exist on other clients' accounts from the difference. Every
  // path a caller is not entitled to see now returns the same line, whether
  // the job is missing, belongs to someone else, or is not a managed run.
  if (!job) return { error: NOT_FOUND };
  try {
    await requireClientAccess(job.clientId);
  } catch (e) {
    // A missing/disabled SESSION is the caller's own problem and says nothing
    // about anyone else's data, so it keeps its own message. "Forbidden" — the
    // foreign-client case — collapses into the not-found shape.
    if (e instanceof Error && e.message === "Unauthorized") return { error: "Unauthorized" };
    return { error: NOT_FOUND };
  }
  if (!job.external) return { error: NOT_FOUND };
  if (job.status !== "queued" && job.status !== "running") {
    return { error: "This run has already finished." };
  }
  const result = await requestJobCancellation(jobId, job);
  if (!result.error) revalidatePath(`/clients/${job.clientId}/agents`);
  return result;
}

/**
 * Re-submit a failed custom-agent run with the same agent/client/prompt (staff
 * only — item 4's execution transparency asked for a retry trigger, and today
 * there is none; a failed run otherwise requires firing a brand-new run by
 * hand). Reconstructs from what the job doc actually persisted — `input.prompt`
 * (see submitCustomAgentJob, which stamps `input: { agent, prompt }`) plus the
 * run-type/umbrella/template fields already on the job. `contextItemIds` were
 * never persisted past the original submission, so a retry can't reattach the
 * exact context files the first attempt used — an acceptable gap for a retry
 * button versus building new context-recovery plumbing for it.
 */
export async function retryJobAction(jobId: string): Promise<{ jobId?: string; error?: string }> {
  const user = await requireStaff();
  const job = await getJob(jobId);
  if (!job) return { error: NOT_FOUND };
  if (job.status !== "failed") return { error: "Only a failed run can be retried." };
  if (!job.customAgentId) return { error: "This run has no retryable agent reference." };
  const prompt = job.input?.prompt;
  if (!prompt) return { error: "Original prompt not found for this run." };

  const result = await submitCustomAgentJob(user, {
    agentId: job.customAgentId,
    clientId: job.clientId,
    prompt,
    runType: job.runType,
    clientAgentId: job.clientAgentId,
    templateKey: job.templateKey,
  });
  if (result.jobId) {
    revalidatePath(`/clients/${job.clientId}/agents`);
    revalidatePath("/jobs");
  }
  return result;
}

/**
 * On-demand single-job reconcile (staff only) — the Control Room calls this
 * right after Force Cancel requests a cancellation, since `cancelAgentServiceJob`
 * only asks the remote service to stop the run: locally, `Job.status` stays
 * `queued`/`running` until a webhook arrives or the ~10-minute reconcile cron
 * happens to sweep it (`src/app/api/agent-service/reconcile/route.ts`). This
 * runs the SAME per-job logic (`reconcileOneJob`) immediately instead, so a
 * cancelled run's status reflects reality in seconds rather than up to the
 * cron's full interval.
 */
export async function refreshJobStatusAction(
  jobId: string,
): Promise<{ status?: JobStatus; action?: string; error?: string }> {
  await requireStaff();
  const job = await getJob(jobId);
  if (!job) return { error: NOT_FOUND };
  try {
    const { action } = await reconcileOneJob(job);
    const fresh = await getJob(jobId);
    revalidatePath(`/jobs/${jobId}`);
    if (fresh) revalidatePath(`/clients/${fresh.clientId}/agents`);
    return { status: fresh?.status, action };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't refresh this run's status." };
  }
}

async function requestJobCancellation(jobId: string, preloaded?: Job): Promise<{ error?: string }> {
  const job = preloaded ?? (await getJob(jobId));
  if (!job?.external) return { error: "Not a managed job." };
  try {
    await cancelAgentServiceJob(job.external.serviceJobId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Cancel failed" };
  }
  /**
   * RE-READ BEFORE THE APPEND, for the same reason the webhook does.
   *
   * `job.events` was read BEFORE `cancelAgentServiceJob` — an unbounded HTTP call
   * — and `cancelClientAgentJobAction` widens the window further by preloading
   * the job and passing it in. Writing the whole array back from that base erases
   * anything appended meanwhile, and the concurrent writer is not hypothetical:
   * it is the webhook delivery this cancel is racing. Its lines are the ones a
   * reader most needs — "N client-facing deliverable(s) attached", the per-artifact
   * re-host failures, and "Refunded N credits for the failed run" — so losing them
   * leaves a job in `review` whose timeline says only that a cancel was asked for.
   *
   * The webhook fixed its own direction and this is the mirror; a read-modify-write
   * hole is only closed when BOTH writers re-read. A failed re-read falls back to
   * the array already held: stale but real, and dropping this event to punish a
   * read failure would lose more than it protects.
   *
   * NOT ATOMIC, and the residual is stated rather than implied: two writes landing
   * inside the same instant can still interleave. The atomic form needs a
   * transaction in the data layer — see the note there — and is a bigger change
   * than this hole warrants on its own.
   */
  let freshJob: Job | null = null;
  try {
    freshJob = await getJob(jobId);
  } catch (e) {
    console.error("[cancel] pre-write job re-read failed, appending to the preloaded copy:", e);
  }
  await updateJob(jobId, {
    events: [
      ...(freshJob?.events ?? job.events),
      { at: Date.now(), level: "info", message: "Cancellation requested" },
    ],
    updatedAt: Date.now(),
  });
  revalidatePath(`/jobs/${jobId}`);
  return {};
}
