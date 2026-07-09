"use server";

import { revalidatePath } from "next/cache";
import { getJob, updateJob } from "@/lib/data";
import { cancelAgentServiceJob } from "@/lib/agent-service/client";
import { submitManagedJob, type SubmitManagedJobInput } from "@/lib/jobs/submit-managed";
import { requireStaff } from "./_shared";

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

/** Requests cancellation of a running managed job. */
export async function cancelManagedJobAction(jobId: string): Promise<{ error?: string }> {
  await requireStaff();
  const job = await getJob(jobId);
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
