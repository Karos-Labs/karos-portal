"use server";

import { revalidatePath } from "next/cache";
import { createJob, getClient, getContextItem, getJob, updateJob } from "@/lib/data";
import {
  cancelAgentServiceJob,
  isAgentServiceConfigured,
  submitAgentServiceJob,
} from "@/lib/agent-service/client";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { ManagedTaskType } from "@/lib/types";
import { logActivity, requireStaff } from "./_shared";

// "use server" files may only export async functions — keep this private.
const MANAGED_TASK_LABELS: Record<ManagedTaskType, string> = {
  social_post: "Social posts (IG/TikTok)",
  newsletter_issue: "Newsletter issue",
  blog_article: "Blog article",
  landing_page: "Landing page",
};

/**
 * Submits a job to the external agent service and mirrors it as a platform
 * `jobs` doc. Progress arrives via the signed webhook
 * (/api/agent-service/webhook); the jobs UI polls the doc as usual.
 */
export async function submitManagedJobAction(input: {
  clientId: string;
  taskType: ManagedTaskType;
  brief: Record<string, unknown>;
  /** ContextItem ids to send along as job input files. */
  contextItemIds?: string[];
}): Promise<{ jobId?: string; error?: string }> {
  const user = await requireStaff();
  if (!isAgentServiceConfigured()) {
    return { error: "Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN)." };
  }
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return { error: "NEXT_PUBLIC_APP_URL must be set for webhook callbacks." };

  const contextFiles: AgentServiceContextFile[] = [];
  for (const itemId of input.contextItemIds ?? []) {
    const item = await getContextItem(itemId);
    if (!item || item.clientId !== input.clientId) {
      return { error: "Context file not found for this client." };
    }
    contextFiles.push({
      name: item.name,
      url: item.url,
      content_type: item.mimeType,
      ...(item.note ? { description: item.note } : {}),
    });
  }

  const now = Date.now();
  const label = MANAGED_TASK_LABELS[input.taskType];
  const inputSummary = Object.fromEntries(
    Object.entries(input.brief)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, Array.isArray(v) ? v.join("; ") : String(v)]),
  );
  const jobId = await createJob({
    clientId: input.clientId,
    agentId: "agent-service",
    agentName: label,
    title: `${label} — ${client.name}`,
    status: "queued",
    input: inputSummary,
    assetIds: [],
    events: [{ at: now, level: "info", message: "Submitted to agent service" }],
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });

  try {
    const submitted = await submitAgentServiceJob({
      task_type: input.taskType,
      client_id: input.clientId,
      ...(client.agentsRepoSlug ? { client_slug: client.agentsRepoSlug } : {}),
      brief: input.brief,
      callback_url: `${appUrl.replace(/\/$/, "")}/api/agent-service/webhook`,
      ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
      metadata: { platform_job_id: jobId },
    });
    await updateJob(jobId, {
      external: { serviceJobId: submitted.job_id, taskType: input.taskType },
      updatedAt: Date.now(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Agent service submission failed";
    await updateJob(jobId, {
      status: "failed",
      error: message,
      events: [
        { at: now, level: "info", message: "Submitted to agent service" },
        { at: Date.now(), level: "error", message },
      ],
      updatedAt: Date.now(),
    });
    return { jobId, error: message };
  }

  void logActivity({
    clientId: input.clientId,
    timestamp: Date.now(),
    type: "CAMPAIGN_CREATED",
    title: `Managed job started: ${label}`,
    actor: user.name,
    actorRole: "staff",
    metadata: { jobId, taskType: input.taskType },
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${input.clientId}`);
  return { jobId };
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
