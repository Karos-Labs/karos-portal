"use server";

import { revalidatePath } from "next/cache";
import { getJob, updateJob } from "@/lib/data";
import { cancelAgentServiceJob } from "@/lib/agent-service/client";
import type { Job } from "@/lib/types";
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

async function requestJobCancellation(jobId: string, preloaded?: Job): Promise<{ error?: string }> {
  const job = preloaded ?? (await getJob(jobId));
  if (!job?.external) return { error: "Not a managed job." };
  try {
    await cancelAgentServiceJob(job.external.serviceJobId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Cancel failed" };
  }
  await updateJob(jobId, {
    events: [...job.events, { at: Date.now(), level: "info", message: "Cancellation requested" }],
    updatedAt: Date.now(),
  });
  revalidatePath(`/jobs/${jobId}`);
  return {};
}
