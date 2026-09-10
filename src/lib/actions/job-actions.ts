"use server";

import { revalidatePath } from "next/cache";
import { deleteJob, getJob } from "@/lib/data";
import { cancelAgentServiceJob } from "@/lib/agent-service/client";
import { requireAdmin } from "./_shared";

/**
 * Admin-only: permanently removes a job (agent run) record.
 * Assets the run produced are kept — they live independently on /assets.
 * A still-running managed job is cancelled on the agent service first so
 * deleting the record doesn't leave an orphan run burning tokens.
 */
export async function deleteJobAction(jobId: string): Promise<{ error?: string }> {
  await requireAdmin();
  const job = await getJob(jobId);
  if (!job) return {}; // already gone

  const inProgress = job.status === "running" || job.status === "queued";
  if (inProgress && job.external?.serviceJobId) {
    try {
      await cancelAgentServiceJob(job.external.serviceJobId);
    } catch {
      // Best effort — don't block deletion on the service being unreachable.
    }
  }

  await deleteJob(jobId);
  revalidatePath("/jobs");
  revalidatePath(`/clients/${job.clientId}`);
  return {};
}
