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
import {
  buildRedditAgentContextFiles,
  hasRedditAgentIntake,
  isRedditAgent,
} from "@/lib/agent-service/reddit-agent-context";
import { buildClientAgentFeedbackFiles } from "@/lib/agent-service/client-agent-feedback-context";
import { getClientAgentByKey } from "@/lib/data-client-agents";
import {
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  REDDIT_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  agentKeyMatchesClientSlug,
  perClientAgentSlug,
} from "@/lib/custom-agent-launch";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { CREDIT_COSTS, CreditError, isBillableClientActor } from "@/lib/credits";
import { logActivity } from "@/lib/actions/_shared";
import { customRunStartedTitle } from "@/lib/activity-titles";
import { mintJobToken } from "@/lib/mcp/job-token";
import type { AppUser, Client, CreditOperation, CustomAgent, JobRunType } from "@/lib/types";

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

/**
 * Metadata keys this core owns. `extraMetadata` may not set them: they carry
 * the webhook's job identity and the run's signed callback credential.
 */
const RESERVED_METADATA = new Set([
  "platform_job_id",
  "karos_job_token",
  "karos_mcp_url",
  "karos_task_id",
  "karos_run_type",
  "karos_client_agent_id",
  "karos_template_key",
]);

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
  /**
   * How this run was initiated in the launch-vs-runs model. Stamped on the job
   * doc AND echoed to the service as `karos_run_type`, so the webhook can
   * branch and the staff economics card can split launch vs recurring USD
   * without heuristics. Absent ⇒ an untyped run, exactly as before.
   */
  runType?: JobRunType;
  /** The client-agent umbrella this run belongs to (job doc + metadata echo). */
  clientAgentId?: string | null;
  /** The template stream this run produces (job doc + metadata echo). */
  templateKey?: string | null;
  /**
   * Extra `karos_*` metadata for the service to echo back (slot ids, revision
   * targets). Values must be strings — the service's schema is
   * `z.record(z.string(), z.string())`.
   */
  extraMetadata?: Record<string, string>;
  /**
   * Overrides the per-run price and ledger operation for runs that are not
   * priced per output — today only the client-billed LAUNCH, which costs
   * `CustomAgent.launchCreditCost` and lands as `agent_launch`. Charged with
   * the same jobId pairing as a normal run, so the webhook's failure refund
   * and the reconcile sweeps hand it back with no extra code.
   */
  charge?: { amount: number; operation: CreditOperation; reason: string };
}

/**
 * Whether this client may fire this agent at all: an explicit allowlist entry,
 * or an agent that already delivered a successful run for the workspace (a
 * staff run activates it).
 *
 * Extracted so the launch action's pre-flight gate can ask the SAME question
 * the submit core enforces — a card that offers a launch the core would refuse
 * with "Agent not found." is the F131 failure in its most confusing form.
 */
export async function isCustomAgentGrantedToClient(
  client: Pick<Client, "id" | "customAgentIds">,
  agent: Pick<CustomAgent, "id" | "name">,
): Promise<boolean> {
  if ((client.customAgentIds ?? []).includes(agent.id)) return true;
  // customAgentId is authoritative for new jobs; name matching keeps historic
  // completed runs useful without a migration.
  const successful = new Set(["review", "approved", "delivered"]);
  const priorRuns = await listJobs({ clientId: client.id });
  return priorRuns.some(
    (job) =>
      job.external?.taskType === "custom" &&
      successful.has(job.status) &&
      (job.customAgentId === agent.id || (!job.customAgentId && job.agentName === agent.name)),
  );
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
  if (user.role === "CLIENT_USER" && !(await isCustomAgentGrantedToClient(client, agent))) {
    // Same message as missing — don't leak which agents exist beyond the allowlist.
    return { error: "Agent not found." };
  }

  // A per-client agent instance runs an entry skill baked under the one client
  // folder its key names, so pairing it with another client would draft that
  // client's data against another company's playbook. The agents page keeps
  // mismatched cards off the list; this refuses the pair however it arrives —
  // a stale page, a saved link, an MCP call, or a scheduled run.
  if (!agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)) {
    return {
      error: `${agent.name} runs only for the client whose lab repo slug is "${perClientAgentSlug(agent.key)}", and ${client.name}'s slug is ${client.agentsRepoSlug ? `"${client.agentsRepoSlug}"` : "not set"}. Nothing has run — use this client's own agent.`,
    };
  }

  const prompt = input.prompt.trim();
  if (!prompt) return { error: "Describe what you want the agent to produce." };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { error: `Prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString()} characters).` };
  }
  // A charge override must be a real price. Clamping a bad one to 0 would run
  // the job for free AND write no ledger row at all (chargeClientCredits
  // returns before the write for amount ≤ 0), while the surface that offered
  // it still quoted a price — so the only honest handling is to refuse. Checked
  // up here with the other input validation, before any job doc exists.
  if (input.charge && (!Number.isInteger(input.charge.amount) || input.charge.amount <= 0)) {
    return { error: "This run's price is not set up correctly — your Karos team can fix it." };
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
  // no run — with a message naming where that data lives. It has to read
  // correctly both in the run dialog and in a scheduled run's error row, so it
  // names the destination rather than a click the reader may have just made.
  if (isXAgent(agent.key)) {
    if (!(await hasXAgentIntake(input.clientId))) {
      return {
        // CD-E1: this used to send clients to an "Agent-specific documents"
        // section of the rail that no longer exists — intake moved onto the
        // agent's own page. Named the way the F25-pattern gate reasons name it.
        error: `${X_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI Agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the company page form there. Nothing has run.`,
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
  //
  // KEYED (ruling 6). The Path-B master (karos-linkedin-agent) has no company
  // form of its own and gates on ANY LinkedIn intake; company-page instances
  // gate on the company form. Dropping the key collapses both onto the
  // company-only check, so a seat-only workspace reads ready on the agents page
  // (client-agent-rows.ts passes the key), passes unfireableScheduleReason
  // (schedule-gate.ts passes the key) — and then dies here with a setup notice
  // for a form the master does not have. The key argument is the whole fix.
  if (isLinkedInAgent(agent.key)) {
    if (!(await hasLinkedInAgentIntake(input.clientId, agent.key))) {
      return {
        error: `${LINKEDIN_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI Agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the company page form there. Nothing has run.`,
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

  // Reddit agent (e15): the same contract — the account we draft as, its
  // history, off-limits subreddits, the disclosure wording, the per-subreddit
  // verdicts earned from the client's own outcomes, and prior drafts for
  // anti-duplication (see reddit-agent-context.ts). Hard-gated the same way.
  if (isRedditAgent(agent.key)) {
    if (!(await hasRedditAgentIntake(input.clientId))) {
      return {
        error: `${REDDIT_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI Agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the account form there. Nothing has run.`,
      };
    }
    try {
      contextFiles.push(...(await buildRedditAgentContextFiles(input.clientId, agent.name)));
    } catch (e) {
      return {
        error: `Could not attach the client's Reddit intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  // Client-agent feedback (§5): every run of a LIVE umbrella carries the
  // client's standing direction — global first, then per-template. Launch runs
  // are excluded by construction: a setup run is what CREATES the templates, so
  // there is nothing shaped yet and nothing to shape it with.
  //
  // Resolved by the agent's stable KEY rather than its doc id, so an umbrella
  // bound before a lab re-import keeps injecting afterwards. Best-effort: a
  // storage hiccup must not turn a paid run into a refusal, so the run proceeds
  // without the file rather than failing — unlike the X/LinkedIn intake above,
  // which the agent cannot work at all without.
  if (input.runType !== "launch") {
    try {
      const umbrella = await getClientAgentByKey(input.clientId, agent.key);
      if (umbrella?.launchState === "live") {
        contextFiles.push(...(await buildClientAgentFeedbackFiles(umbrella)));
      }
    } catch (e) {
      console.error("[submit-custom] client-agent feedback attachment failed:", e);
    }
  }

  const now = Date.now();
  const jobId = await createJob({
    clientId: input.clientId,
    agentId: "agent-service",
    customAgentId: agent.id,
    ...(input.runType ? { runType: input.runType } : {}),
    ...(input.clientAgentId ? { clientAgentId: input.clientAgentId } : {}),
    ...(input.templateKey ? { templateKey: input.templateKey } : {}),
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
  const runCost = input.charge
    ? input.charge.amount
    : (agent.creditCost ?? CREDIT_COSTS.customAgentRun) * multiplier;
  if (isBillableClientActor(user)) {
    try {
      await chargeClientCredits({
        clientId: input.clientId,
        amount: runCost,
        operation: input.charge?.operation ?? "custom_agent_run",
        reason: (
          input.charge?.reason ??
          `Agent run · ${agent.name}${multiplier > 1 ? ` · ${multiplier} outputs` : ""}`
        ).slice(0, 120),
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
        // Per-step model routing (optional): only takes effect for skills whose
        // steps are named Task-tool subagents matching these keys — see
        // docs/one-pagers/x-agent-v2-integration-contract.md.
        ...(agent.stepModels && Object.keys(agent.stepModels).length > 0
          ? { step_models: agent.stepModels }
          : {}),
      },
      callback_url: `${origin}/api/agent-service/webhook`,
      ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
      metadata: {
        // Caller-supplied keys go FIRST so the core's own routing can never be
        // shadowed: platform_job_id is how the webhook recovers a job when the
        // serviceJobId write loses the race, and karos_job_token is a signed
        // credential — a caller that passed either through extraMetadata (by
        // accident or otherwise) could redirect a delivery or hand out a token
        // for someone else's job. Reserved keys are dropped, not overridden
        // silently, so the mistake is visible in the payload rather than fatal.
        ...Object.fromEntries(
          Object.entries(input.extraMetadata ?? {}).filter(([key]) => !RESERVED_METADATA.has(key)),
        ),
        platform_job_id: jobId,
        ...(input.taskId ? { karos_task_id: input.taskId } : {}),
        ...(jobToken ? { karos_job_token: jobToken, karos_mcp_url: `${origin}/api/mcp` } : {}),
        // Launch-vs-runs routing. Echoed back by the service (the
        // platform_job_id fallback proves the round-trip), which is what lets
        // the webhook branch without a second lookup.
        ...(input.runType ? { karos_run_type: input.runType } : {}),
        ...(input.clientAgentId ? { karos_client_agent_id: input.clientAgentId } : {}),
        ...(input.templateKey ? { karos_template_key: input.templateKey } : {}),
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
    title: customRunStartedTitle(agent.name),
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: { jobId, taskType: "custom", agentKey: agent.key },
  });
  return { jobId };
}
