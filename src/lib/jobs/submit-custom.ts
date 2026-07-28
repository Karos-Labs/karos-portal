import "server-only";
import { jobTitleForClient } from "@/lib/job-title";

import {
  chargeClientCredits,
  createJob,
  deleteJob,
  getClient,
  getContextItem,
  getCustomAgent,
  listJobs,
  updateJob,
} from "@/lib/data";
import {
  cancelAgentServiceJob,
  isAgentServiceConfigured,
  submitAgentServiceJob,
} from "@/lib/agent-service/client";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import { buildXAgentContextFiles, hasXAgentIntake, isXAgent } from "@/lib/agent-service/x-agent-context";
import {
  buildLinkedInAgentContextFiles,
  hasLinkedInAgentIntake,
  isLinkedInAgent,
} from "@/lib/agent-service/linkedin-agent-context";
import { LINKEDIN_SETUP_REQUIRED_PREFIX, X_SETUP_REQUIRED_PREFIX } from "@/lib/custom-agent-launch";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { CREDIT_COSTS, CreditError, isBillableClientActor } from "@/lib/credits";
import { logActivity } from "@/lib/actions/_shared";
import { mintJobToken } from "@/lib/mcp/job-token";
import type { AppUser } from "@/lib/types";

/**
 * Shared core for firing a repo-imported custom agent. Called by BOTH the web
 * action (`runCustomAgentAction`, cookie-authed) and the scheduled-run cron
 * (`/api/run-scheduled`, trusted) so the two can't drift. Plain server function
 * — no `"use server"`, no cookies, no `revalidatePath`; the caller owns auth
 * (session / cron secret) and cache invalidation.
 *
 * The CLIENT_USER allowlist gate lives here (keyed off `user.role`), so a
 * client-fired run still can't reach an agent outside its allowlist, while
 * staff- and cron-fired runs pass through.
 */

const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_KEY_CHARS = 120;
const MAX_NAME_CHARS = 200;

export interface SubmitCustomAgentInput {
  agentId: string;
  clientId: string;
  prompt: string;
  contextItemIds?: string[];
  /**
   * Task-board task that dispatched this run. Echoed in the webhook metadata
   * (karos_task_id) so the task sync resolves the task even if the webhook
   * outruns the dispatcher's own externalJobId write.
   */
  taskId?: string;
  /** Server-controlled multiplier for scheduled runs requesting multiple outputs. */
  chargeMultiplier?: number;
}

export async function submitCustomAgentJob(
  user: AppUser,
  input: SubmitCustomAgentInput,
): Promise<{ jobId?: string; error?: string }> {
  if (!isAgentServiceConfigured()) {
    return { error: "Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN)." };
  }

  const agent = await getCustomAgent(input.agentId);
  if (!agent || !agent.enabled) return { error: "Agent not found." };
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };
  if (user.role === "CLIENT_USER" && !(client.customAgentIds ?? []).includes(agent.id)) {
    // A successfully delivered staff run activates the agent for this client.
    // customAgentId is authoritative for new jobs; name matching keeps historic
    // completed runs useful without a migration.
    const successful = new Set(["review", "approved", "delivered"]);
    const priorRuns = await listJobs({ clientId: input.clientId });
    const activated = priorRuns.some(
      (job) =>
        job.external?.taskType === "custom" &&
        successful.has(job.status) &&
        (job.customAgentId === agent.id || (!job.customAgentId && job.agentName === agent.name)),
    );
    if (!activated) {
      // Same message as missing — don't leak which agents exist beyond the allowlist.
      return { error: "Agent not found." };
    }
  }

  const prompt = input.prompt.trim();
  if (!prompt) return { error: "Describe what you want the agent to produce." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).` };
  }

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

  // X agent (e13): attach the portal-collected intake, ongoing boxes, and
  // per-account learning logs as context files (see x-agent-context.ts). Lives
  // in this shared core so manual, scheduled, and MCP-fired X runs all inject.
  // Other agents skip it. The agent runs ON this data, so hard-gate: no intake,
  // no run — with a message pointing to the setup page.
  if (isXAgent(agent.key)) {
    if (!(await hasXAgentIntake(input.clientId))) {
      return {
        error: `${X_SETUP_REQUIRED_PREFIX} first. Open the "X agent data" page (under Agent-specific documents) and fill in the company page - the agent drafts from that. Nothing has run.`,
      };
    }
    try {
      contextFiles.push(...(await buildXAgentContextFiles(input.clientId, agent.name)));
    } catch (e) {
      return {
        error: `Could not attach the client's X intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  // LinkedIn agents (e10): the same contract — portal intake, the shared news
  // drop as company-updates.md, CVs, learning logs, and prior batches (see
  // linkedin-agent-context.ts). Hard-gated the same way.
  if (isLinkedInAgent(agent.key)) {
    if (!(await hasLinkedInAgentIntake(input.clientId, agent.key))) {
      return {
        error: `${LINKEDIN_SETUP_REQUIRED_PREFIX} first. Open the "LinkedIn agent data" page (under Agent-specific documents) and save the company page form - the agent drafts from that. Nothing has run.`,
      };
    }
    try {
      contextFiles.push(...(await buildLinkedInAgentContextFiles(input.clientId, agent.name)));
    } catch (e) {
      return {
        error: `Could not attach the client's LinkedIn intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  const now = Date.now();
  const jobId = await createJob({
    clientId: input.clientId,
    agentId: "agent-service",
    customAgentId: agent.id,
    agentName: agent.name,
    title: jobTitleForClient(agent.name, client.name),
    status: "queued",
    input: { agent: agent.name, prompt },
    assetIds: [],
    events: [{ at: now, level: "info", message: "Submitted to agent service" }],
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });

  // Charge upfront (billable client actors only — staff and cron never charge)
  // with jobId pairing so the webhook's failure refund and the reconcile sweeps
  // can hand the credits back.
  const multiplier = Math.max(1, Math.min(10, Math.round(input.chargeMultiplier ?? 1)));
  const runCost = (agent.creditCost ?? CREDIT_COSTS.customAgentRun) * multiplier;
  if (isBillableClientActor(user)) {
    try {
      await chargeClientCredits({
        clientId: input.clientId,
        amount: runCost,
        operation: "custom_agent_run",
        reason: `Agent run · ${agent.name}${multiplier > 1 ? ` · ${multiplier} outputs` : ""}`.slice(0, 120),
        agentId: agent.id,
        jobId,
        actorUid: user.uid,
        actorName: user.name,
      });
    } catch (e) {
      await deleteJob(jobId); // nothing submitted yet — no orphan to keep
      if (e instanceof CreditError) return { error: e.message };
      throw e;
    }
  }

  // Job-scoped credential so the runner can call back into the MCP server
  // (`/api/mcp`) for this client's data / to upload artifacts mid-run. Null when
  // signing isn't configured — the run just proceeds without callback access.
  const jobToken = mintJobToken({ clientId: input.clientId, jobId });

  let submittedServiceJobId: string | undefined;
  try {
    const submitted = await submitAgentServiceJob({
      task_type: "custom",
      client_id: input.clientId,
      ...(client.agentsRepoSlug ? { client_slug: client.agentsRepoSlug } : {}),
      brief: {
        agent_key: agent.key.slice(0, MAX_KEY_CHARS),
        label: agent.name.slice(0, MAX_NAME_CHARS),
        entry_skill_dir: agent.entrySkillDir,
        ...(agent.skillRoots.length > 0 ? { skill_roots: agent.skillRoots } : {}),
        include_client_skills: agent.includeClientSkills,
        instructions: agent.instructions.slice(0, MAX_INSTRUCTIONS_CHARS),
        prompt,
      },
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
      external: { serviceJobId: submitted.job_id, taskType: "custom" },
      updatedAt: Date.now(),
    });
  } catch (e) {
    if (submittedServiceJobId) {
      try {
        await cancelAgentServiceJob(submittedServiceJobId);
      } catch {
        // best effort — the webhook receiver's metadata fallback still matches
      }
    }
    const message = e instanceof Error ? e.message : "Agent service submission failed";
    // Refund BEFORE flipping the job to failed: the credits sweep only revisits
    // queued/running jobs, so a job marked failed with a lost refund would
    // strand the charge. If the refund write fails, leave the job queued — the
    // sweep fails AND refunds it in one transaction.
    try {
      await refundJobCharge(jobId, `Auto-refund · submission failed · ${agent.name}`.slice(0, 120));
    } catch {
      return { jobId, error: message };
    }
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
    title: `Agent run started: ${agent.name}`,
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: { jobId, taskType: "custom", agentKey: agent.key },
  });
  return { jobId };
}
