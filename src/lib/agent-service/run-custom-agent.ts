import "server-only";

import { revalidatePath } from "next/cache";
import { createJob, deleteJob, updateJob } from "@/lib/data";
import { chargeClientCredits } from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { CreditError } from "@/lib/credits";
import { logActivity } from "@/lib/actions/_shared";
import { cancelAgentServiceJob, isAgentServiceConfigured, submitAgentServiceJob } from "./client";
import type { AgentServiceContextFile } from "./types";
import { buildXAgentContextFiles, hasXAgentIntake, isXAgent } from "./x-agent-context";
import {
  buildLinkedInAgentContextFiles,
  hasLinkedInAgentIntake,
  isLinkedInAgent,
} from "./linkedin-agent-context";
import {
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  agentKeyMatchesClientSlug,
  perClientAgentSlug,
} from "@/lib/custom-agent-launch";
import type { Client, CustomAgent } from "@/lib/types";

/* limits — mirror agent-service/src/schemas/task-types/custom.json */
const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_KEY_CHARS = 120;
const MAX_NAME_CHARS = 200;

/**
 * Shared core that fires a custom agent for a client, used by both the
 * interactive `runCustomAgentAction` (which layers auth + the allowlist +
 * billing on top) and the /api/scheduler cron (which fires it free, with no
 * user session). Creates the mirrored `jobs` doc, optionally charges the
 * client, submits to the agent service, and mirrors the failure-cleanup +
 * refund contract. Callers own authorization; this function does not check it.
 *
 * `charge` null ⇒ a free run (staff, admin "view as client", or system-fired
 * scheduled runs) — no credit ledger is touched. `extraMetadata` rides through
 * to the webhook (e.g. asset_type/platform hints for scheduled generators).
 */
export async function submitCustomAgentRun(args: {
  agent: CustomAgent;
  client: Client;
  prompt: string;
  actor: { uid: string; name: string; role: "staff" | "client" };
  contextFiles?: AgentServiceContextFile[];
  extraMetadata?: Record<string, string>;
  charge?: { amount: number } | null;
}): Promise<{ jobId?: string; error?: string }> {
  const { agent, client, actor } = args;
  if (!isAgentServiceConfigured()) {
    return { error: "Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN)." };
  }

  // The twin of the guard in lib/jobs/submit-custom.ts, for the other submit
  // core: a per-client agent instance runs an entry skill baked under the one
  // client folder its key names, so pairing it with another client would draft
  // that client's data against another company's playbook. This core is reached
  // from a stored (agentId, clientId) pair on a scheduledRuns row, which may
  // have been created while a mismatched card was still on offer, so the pair is
  // re-checked on every fire rather than trusted.
  if (!agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)) {
    return {
      error: `${agent.name} runs only for the client whose lab repo slug is "${perClientAgentSlug(agent.key)}", and ${client.name}'s slug is ${client.agentsRepoSlug ? `"${client.agentsRepoSlug}"` : "not set"}. Nothing has run — use this client's own agent.`,
    };
  }

  const prompt = args.prompt.trim();
  if (!prompt) return { error: "Describe what you want the agent to produce." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).` };
  }

  const appUrl = process.env.AGENT_SERVICE_CALLBACK_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return { error: "AGENT_SERVICE_CALLBACK_URL (or NEXT_PUBLIC_APP_URL) must be set for webhook callbacks." };
  }

  // X agent (e13): attach the portal-collected intake, ongoing boxes, and
  // per-account learning logs as context files (see x-agent-context.ts) so
  // scheduler-fired X runs read the same live client data as manual ones.
  // Other agents skip it; failing the submission beats running without data.
  const contextFiles = [...(args.contextFiles ?? [])];
  if (isXAgent(agent.key)) {
    if (!(await hasXAgentIntake(client.id))) {
      return {
        error: `${X_SETUP_REQUIRED_PREFIX} first: fill in the company page, which is what the agent drafts from. The agent data sits with the agent on the AI Agents page. Nothing has run.`,
      };
    }
    try {
      contextFiles.push(...(await buildXAgentContextFiles(client.id, agent.name)));
    } catch (e) {
      return {
        error: `Could not attach the client's X intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  // LinkedIn agents (e10): the same contract — portal intake, the shared news
  // drop as company-updates.md, CVs, learning logs, and prior batches (see
  // linkedin-agent-context.ts) — so scheduler-fired LinkedIn runs read the
  // same live client data as manual ones. Hard-gated the same way.
  if (isLinkedInAgent(agent.key)) {
    if (!(await hasLinkedInAgentIntake(client.id))) {
      return {
        error: `${LINKEDIN_SETUP_REQUIRED_PREFIX} first: save the company page form, which is what the agent drafts from. The agent data sits with the agent on the AI Agents page. Nothing has run.`,
      };
    }
    try {
      contextFiles.push(...(await buildLinkedInAgentContextFiles(client.id, agent.name)));
    } catch (e) {
      return {
        error: `Could not attach the client's LinkedIn intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  const now = Date.now();
  const jobId = await createJob({
    clientId: client.id,
    agentId: "agent-service",
    agentName: agent.name,
    title: `${agent.name} - ${client.name}`,
    status: "queued",
    input: { agent: agent.name, prompt },
    assetIds: [],
    events: [{ at: now, level: "info", message: "Submitted to agent service" }],
    createdBy: actor.uid,
    createdAt: now,
    updatedAt: now,
  });

  // Charge upfront (billable client actors only) with jobId pairing so the
  // webhook's failure refund and the reconcile sweeps can hand the credits back.
  const charged = args.charge != null;
  if (args.charge) {
    try {
      await chargeClientCredits({
        clientId: client.id,
        amount: args.charge.amount,
        operation: "custom_agent_run",
        reason: `Agent run · ${agent.name}`.slice(0, 120),
        agentId: agent.id,
        jobId,
        actorUid: actor.uid,
        actorName: actor.name,
      });
    } catch (e) {
      await deleteJob(jobId); // nothing submitted yet — no orphan to keep
      if (e instanceof CreditError) return { error: e.message };
      throw e;
    }
  }

  let submittedServiceJobId: string | undefined;
  try {
    const submitted = await submitAgentServiceJob({
      task_type: "custom",
      client_id: client.id,
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
      callback_url: `${appUrl.replace(/\/$/, "")}/api/agent-service/webhook`,
      ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
      metadata: { platform_job_id: jobId, ...(args.extraMetadata ?? {}) },
    });
    submittedServiceJobId = submitted.job_id;
    await updateJob(jobId, {
      external: { serviceJobId: submitted.job_id, taskType: "custom" },
      updatedAt: Date.now(),
    });
  } catch (e) {
    // Same cleanup contract as the interactive action, plus the charge refund.
    if (submittedServiceJobId) {
      try {
        await cancelAgentServiceJob(submittedServiceJobId);
      } catch {
        // best effort — the webhook receiver's metadata fallback still matches
      }
    }
    const message = e instanceof Error ? e.message : "Agent service submission failed";
    // Refund BEFORE flipping the job to failed (only when we charged): the
    // credits sweep only revisits queued/running jobs, so a job marked failed
    // with a lost refund would strand the charge. If the refund write fails,
    // leave the job queued so the sweep fails AND refunds it in one transaction.
    if (charged) {
      try {
        await refundJobCharge(jobId, `Auto-refund · submission failed · ${agent.name}`.slice(0, 120));
      } catch {
        return { jobId, error: message };
      }
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
    clientId: client.id,
    timestamp: Date.now(),
    type: "CAMPAIGN_CREATED",
    title: `Agent run started: ${agent.name}`,
    actor: actor.name,
    actorRole: actor.role,
    metadata: { jobId, taskType: "custom", agentKey: agent.key },
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${client.id}`);
  revalidatePath(`/clients/${client.id}/agents`);
  return { jobId };
}
