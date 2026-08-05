import "server-only";
import { jobTitleForClient } from "@/lib/job-title";

import { revalidatePath } from "next/cache";
import { createJob, deleteJob, updateJob } from "@/lib/data";
import { chargeClientCredits } from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { CreditError } from "@/lib/credits";
import { logActivity } from "@/lib/actions/_shared";
import { customRunStartedTitle } from "@/lib/activity-titles";
import { cancelAgentServiceJob, isAgentServiceConfigured, submitAgentServiceJob } from "./client";
import type { AgentServiceContextFile } from "./types";
import { buildXAgentContextFiles, hasXAgentIntake, isXAgent } from "./x-agent-context";
import {
  LI_COMPANY_IDENTITY,
  buildLinkedInAgentContextFiles,
  hasLinkedInAgentIntake,
  hasLinkedInV2Setup,
  isLinkedInAgent,
  isLinkedInSetupV2,
  isLinkedInV2Agent,
} from "./linkedin-agent-context";
import {
  buildRedditAgentContextFiles,
  hasRedditAgentIntake,
  isRedditAgent,
} from "./reddit-agent-context";
import {
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  REDDIT_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  agentKeyMatchesClientSlug,
  perClientAgentSlug,
} from "@/lib/custom-agent-launch";
import type { Client, CustomAgent, JobRunType } from "@/lib/types";

/* limits — mirror agent-service/src/schemas/task-types/custom.json */
const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_KEY_CHARS = 120;
const MAX_NAME_CHARS = 200;

/**
 * Shared core that fires a custom agent for a client. Creates the mirrored
 * `jobs` doc, optionally charges the client, submits to the agent service, and
 * mirrors the failure-cleanup + refund contract. Callers own authorization;
 * this function does not check it.
 *
 * ONE CALLER TODAY: the `/api/scheduler` cron, which fires the `scheduledRuns`
 * rows free with no user session. This note used to claim the interactive
 * `runCustomAgentAction` came through here too; it has not since that action
 * moved to lib/jobs/submit-custom.ts, and the stale claim is part of why the
 * job fields below went unnoticed — a core believed to serve the run dialog
 * looks like it must already be writing what the run dialog's rows carry.
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
  /**
   * How this run was initiated, stamped on the job doc exactly as the twin core
   * (lib/jobs/submit-custom.ts) stamps it. Everything §6 reports splits on this
   * field: the client's spend breakdown separates a schedule firing from a run
   * they started, and §6.3's launch-price calibration measures a launch against
   * scheduled + manual runs as its denominator.
   *
   * OPTIONAL, AND ABSENT MEANS ABSENT. A run through this core with no run type
   * is stamped with none and reports as an unclassified agent run — which is
   * what it is. It is deliberately not defaulted to "scheduled" on the grounds
   * that today's only caller is a scheduler: a default keyed to who happens to
   * call a function is a label that becomes a lie the moment a second caller
   * appears, and this one would be a lie about money on a client's bill.
   */
  runType?: JobRunType;
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

  const appUrl = process.env.AGENT_SERVICE_CALLBACK_URL ?? process.env.APP_URL;
  if (!appUrl) {
    return { error: "AGENT_SERVICE_CALLBACK_URL (or APP_URL) must be set for webhook callbacks." };
  }

  // X agent (e13): attach the portal-collected intake, ongoing boxes, and
  // per-account learning logs as context files (see x-agent-context.ts) so
  // scheduler-fired X runs read the same live client data as manual ones.
  // Other agents skip it; failing the submission beats running without data.
  const contextFiles = [...(args.contextFiles ?? [])];
  if (isXAgent(agent.key)) {
    if (!(await hasXAgentIntake(client.id))) {
      return {
        // CD-E1: "Agent-specific documents" was a rail section that no longer
        // exists — intake moved onto the agent's own page. Kept identical to
        // the submit core's twin; a client must not read two different routes
        // to the same form depending on which path refused.
        error: `${X_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the company page form there. Nothing has run.`,
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
  //
  // KEYED (ruling 6), matching submit-custom.ts and schedule-gate.ts: the
  // Path-B master gates on ANY LinkedIn intake, company-page instances on the
  // company form. Unkeyed here, a seat-only workspace whose schedule the gate
  // accepted would refuse on every fire — invisibly, since the refusal happens
  // before any job row is written.
  if (isLinkedInAgent(agent.key)) {
    if (!(await hasLinkedInAgentIntake(client.id, agent.key))) {
      return {
        error: `${LINKEDIN_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the company page form there. Nothing has run.`,
      };
    }
    // The v2 twin of the submit core's stood-up rung. A SCHEDULED writer run
    // needs it more than a manual one, not less: nobody is watching this fire, so
    // an un-set-up client's schedule would spend a run a week to be told the same
    // thing. Every scheduled v2 run is for the company page — a schedule row
    // carries no identity, and inventing one here would silently draft on a
    // person's profile on a cadence nobody chose for them.
    if (isLinkedInV2Agent(agent.key) && !isLinkedInSetupV2(agent.key)) {
      if (!(await hasLinkedInV2Setup(client.id))) {
        return {
          error: `${LINKEDIN_SETUP_REQUIRED_PREFIX} first. This agent has not been set up for ${client.name} yet. Press "Set it up" on the LinkedIn agent card, which stands up the lanes, the voice and the first topics. Nothing has run.`,
        };
      }
    }
    try {
      contextFiles.push(
        ...(await buildLinkedInAgentContextFiles({
          clientId: client.id,
          agentKey: agent.key,
          agentName: agent.name,
          identity: LI_COMPANY_IDENTITY,
        })),
      );
    } catch (e) {
      return {
        error: `Could not attach the client's LinkedIn intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  // Reddit agent (e15): the same contract — the account, its history,
  // off-limits subreddits, the disclosure wording, the per-subreddit verdicts
  // earned from the client's outcomes, and prior drafts (see
  // reddit-agent-context.ts) — so scheduler-fired Reddit runs read the same
  // live client data as manual ones. Hard-gated the same way. This matters more
  // for Reddit than for the others: the daily cadence means most runs arrive
  // through here, not through the run dialog.
  if (isRedditAgent(agent.key)) {
    if (!(await hasRedditAgentIntake(client.id))) {
      return {
        error: `${REDDIT_SETUP_REQUIRED_PREFIX} first. Open this agent on your AI agents page and follow "Set it up" under "What it knows about you" — the agent drafts from the account form there. Nothing has run.`,
      };
    }
    try {
      contextFiles.push(...(await buildRedditAgentContextFiles(client.id, agent.name)));
    } catch (e) {
      return {
        error: `Could not attach the client's Reddit intake data: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  const now = Date.now();
  const jobId = await createJob({
    clientId: client.id,
    agentId: "agent-service",
    // WHICH AGENT THIS RUN BELONGS TO. Omitted until 2026-08-01 while the twin
    // core always wrote it, so every job this core produced was invisible to
    // everything that joins a run to an agent by id.
    //
    // WHAT THAT ACTUALLY COST, stated narrowly because the first version of this
    // note claimed more: the STAFF economics card and the launch-price
    // calibration both filter on this field, so these runs' real Anthropic
    // dollars were missing from the very measurement that sets the setup price.
    //
    // IT DID **NOT** PUT "Removed agent" ON A CLIENT'S BILL, and saying so here
    // was a false premise dressed as a reason. This core has ONE caller —
    // /api/scheduler — and it passes `charge: null`; that route's own docstring
    // says every fire here is free to the client and absent from the credit
    // ledger. A run that never reaches the ledger cannot mis-name a row in it.
    // The client-bill symptom is real and belongs to the twin core, which
    // already stamped this field; #58 is fixed at the READER (spendAgentNames).
    customAgentId: agent.id,
    ...(args.runType ? { runType: args.runType } : {}),
    agentName: agent.name,
    title: jobTitleForClient(agent.name, client.name),
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
        // Both mirror the twin core (lib/jobs/submit-custom.ts) — missing here
        // meant a scheduler-fired run of an agent with either set ran on the
        // task type's plain default instead, silently diverging from a manual
        // run of the SAME agent through the run dialog.
        ...(agent.stepModels && Object.keys(agent.stepModels).length > 0
          ? { step_models: agent.stepModels }
          : {}),
        ...(agent.model ? { model: agent.model } : {}),
      },
      callback_url: `${appUrl.replace(/\/$/, "")}/api/agent-service/webhook`,
      ...(contextFiles.length > 0 ? { context_files: contextFiles } : {}),
      metadata: {
        // Caller keys FIRST so this core's own keys cannot be shadowed by an
        // extraMetadata entry — platform_job_id is how the webhook finds the job
        // when the serviceJobId write loses the race, and karos_agent_key is what
        // the delivery handler fences a draft-only agent's asset type on. The
        // twin core states the same rule as a reserved-key list
        // (lib/jobs/submit-custom.ts); here the ordering is the whole rule, so
        // there is no second list to keep in step.
        ...(args.extraMetadata ?? {}),
        platform_job_id: jobId,
        // WHICH AGENT PRODUCED THE RUN, echoed back by the service so the webhook
        // can ask it without a second Firestore read. It matters most on this core:
        // its one caller, the recurring-run cron, is also the only place in the tree
        // today that sends an `asset_type` hint (the schedule row's own type), and
        // that hint is exactly what could type a Reddit reply as a publishable post.
        // The agent's display NAME travels on the job doc and is the fence's
        // fallback; a rename would silence it, a key would not.
        karos_agent_key: agent.key.slice(0, MAX_KEY_CHARS),
      },
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
    title: customRunStartedTitle(agent.name),
    actor: actor.name,
    actorRole: actor.role,
    metadata: { jobId, taskType: "custom", agentKey: agent.key },
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${client.id}`);
  revalidatePath(`/clients/${client.id}/agents`);
  return { jobId };
}
