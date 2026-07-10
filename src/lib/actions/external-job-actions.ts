"use server";

import { revalidatePath } from "next/cache";
import { getJob, updateJob } from "@/lib/data";
import { cancelAgentServiceJob } from "@/lib/agent-service/client";
import { requireStaff } from "./_shared";

/** Requests cancellation of a running agent-service job (managed or custom). */
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
