"use server";

import { revalidatePath } from "next/cache";
import { getJob, updateJob } from "@/lib/data";
import { cancelAgentServiceJob } from "@/lib/agent-service/client";
import { submitManagedJob, type SubmitManagedJobInput } from "@/lib/jobs/submit-managed";
import type { Job } from "@/lib/types";
import { requireClientAccess, requireStaff } from "./_shared";

/**
 * Submits a job to the external agent service and mirrors it as a platform
 * `jobs` doc. Progress arrives via the signed webhook
 * (/api/agent-service/webhook); the jobs UI polls the doc as usual. The actual
 * work lives in the shared `submitManagedJob` core so the MCP `submit_job` tool
 * runs the identical path — this wrapper only adds staff auth + cache busting.
 */
export async function submitManagedJobAction(
  input: SubmitManagedJobInput,
): Promise<{ jobId?: string; error?: string }> {
  const user = await requireStaff();
  const result = await submitManagedJob(user, input);
  if (result.jobId && !result.error) {
    revalidatePath("/jobs");
    revalidatePath(`/clients/${input.clientId}`);
  }
  return result;
}

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
  if (!job?.external) return { error: "Not a managed job." };
  await requireClientAccess(job.clientId);
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
