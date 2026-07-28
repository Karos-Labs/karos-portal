import "server-only";
import { jobTitleForClient } from "@/lib/job-title";

import { createJob, getClient, getContextItem, updateJob } from "@/lib/data";
import {
  cancelAgentServiceJob,
  isAgentServiceConfigured,
  submitAgentServiceJob,
} from "@/lib/agent-service/client";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AppUser, ManagedTaskType } from "@/lib/types";
import { logActivity } from "@/lib/actions/_shared";
import { mintJobToken } from "@/lib/mcp/job-token";

/**
 * Shared core for submitting a managed (catalog) job to the external agent
 * service. Called by BOTH the web server action (`submitManagedJobAction`,
 * cookie-authed) and the MCP `submit_job` tool (token-authed) so the two can't
 * drift. Plain server function — no `"use server"`, no cookies, no
 * `revalidatePath`; the caller owns auth and cache invalidation.
 */

// The catalog products this serves; "custom" runs go through runCustomAgentAction.
type CatalogTaskType = Exclude<ManagedTaskType, "custom">;

const MANAGED_TASK_LABELS: Record<CatalogTaskType, string> = {
  social_post: "Social posts (IG/TikTok)",
  newsletter_issue: "Newsletter issue",
  blog_article: "Blog article",
  landing_page: "Landing page",
};

// Mirrors the required fields in the service's per-task-type JSON schemas so
// invalid briefs never mint a job doc (the service would 422 them anyway).
const REQUIRED_BRIEF_FIELDS: Record<CatalogTaskType, string[]> = {
  social_post: [],
  newsletter_issue: [],
  blog_article: ["topic"],
  landing_page: ["page_goal"],
};

export interface SubmitManagedJobInput {
  clientId: string;
  taskType: ManagedTaskType;
  brief: Record<string, unknown>;
  /** ContextItem ids to send along as job input files. */
  contextItemIds?: string[];
  /**
   * Task-board task that dispatched this run. Echoed back in the webhook
   * metadata (karos_task_id) so the task sync can resolve the task even if
   * the webhook outruns the dispatcher's own metadata write.
   */
  taskId?: string;
}

export async function submitManagedJob(
  user: AppUser,
  input: SubmitManagedJobInput,
): Promise<{ jobId?: string; error?: string }> {
  if (!isAgentServiceConfigured()) {
    return { error: "Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN)." };
  }
  if (input.taskType === "custom") {
    return { error: "Custom agents run through the custom-agents flow, not the product catalog." };
  }
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };

  const missing = REQUIRED_BRIEF_FIELDS[input.taskType].filter((field) => {
    const value = input.brief[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (missing.length > 0) return { error: `Missing required field: ${missing.join(", ")}` };

  // Prefer a dedicated runtime var (plain env vars are readable at runtime on
  // Cloud Run; NEXT_PUBLIC_* can get inlined at build) and don't overload the
  // OAuth-facing NEXT_PUBLIC_APP_URL. Fall back to it for local/dev.
  const appUrl = process.env.AGENT_SERVICE_CALLBACK_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return { error: "AGENT_SERVICE_CALLBACK_URL (or NEXT_PUBLIC_APP_URL) must be set for webhook callbacks." };
  }
  const origin = appUrl.replace(/\/$/, "");

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
    title: jobTitleForClient(label, client.name),
    status: "queued",
    input: inputSummary,
    assetIds: [],
    events: [{ at: now, level: "info", message: "Submitted to agent service" }],
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });

  // Job-scoped credential so the runner can call back into the MCP server
  // (`/api/mcp`) for this client's data / to upload artifacts mid-run. Null when
  // signing isn't configured — the run just proceeds without callback access.
  const jobToken = mintJobToken({ clientId: input.clientId, jobId });

  let submittedServiceJobId: string | undefined;
  try {
    const submitted = await submitAgentServiceJob({
      task_type: input.taskType,
      client_id: input.clientId,
      ...(client.agentsRepoSlug ? { client_slug: client.agentsRepoSlug } : {}),
      brief: input.brief,
      callback_url: `${origin}/api/agent-service/webhook`,
      ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
      metadata: {
        platform_job_id: jobId,
        ...(input.taskId ? { karos_task_id: input.taskId } : {}),
        ...(jobToken ? { karos_job_token: jobToken, karos_mcp_url: `${origin}/api/mcp` } : {}),
      },
    });
    submittedServiceJobId = submitted.job_id;
    await updateJob(jobId, {
      external: { serviceJobId: submitted.job_id, taskType: input.taskType },
      updatedAt: Date.now(),
    });
  } catch (e) {
    // If the run was accepted but recording it failed, stop the run rather
    // than leaving an orphan burning tokens against a job marked failed.
    if (submittedServiceJobId) {
      try {
        await cancelAgentServiceJob(submittedServiceJobId);
      } catch {
        // best effort — the webhook receiver's metadata fallback still matches
      }
    }
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
  return { jobId };
}
