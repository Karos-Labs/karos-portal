"use server";

import { revalidatePath } from "next/cache";
import {
  MiddlewareRequestError,
  getAgent,
  listModels,
  activatePromptVersion,
  bindTemplate,
  createPromptVersion,
  promoteFeedback,
  requestModelAccess,
  setAgentStatus,
  submitFeedback,
  updateAgent,
} from "@/lib/agent-engine/middleware-admin";
import { isMiddlewareDispatchEnabled } from "@/lib/agent-engine/middleware-client";
import { dispatchAgentEngineRun } from "@/lib/agent-engine/dispatch";
import { getClient } from "@/lib/data";
import { jobTitleForClient } from "@/lib/job-title";
import { requireAdmin } from "./_shared";

/**
 * Server actions for the control-plane console (`/admin/agents/control-plane`).
 *
 * These write to `agent-middleware`, NOT to Firestore. That is the difference
 * from `dynamic-agent-actions.ts`, which is the Dynamic Agent Studio and owns
 * `dynamicAgentSpecs` documents executed by `agent-service`. The two are
 * separate systems that both happen to be called "agents", and wiring one
 * through the other would break the working one.
 *
 * ADMIN-ONLY, enforced inside every action via `requireAdmin()` and not merely
 * by hiding the page: a non-admin session can invoke a server action directly.
 * The same reasoning as the Agent Studio's own header note.
 *
 * // NOTE: no type-only re-exports from this file — Next 16's "use server"
 * transform mis-registers them as action references and they blow up at
 * runtime. Import the types from `@/lib/agent-engine/middleware-admin`.
 */

const CONSOLE_PATH = "/admin/agents/control-plane";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Turns a control-plane failure into something an admin can act on.
 *
 * The middleware's `detail` is the useful half — "content must not be empty",
 * "no active prompt" — and dropping it in favour of a generic message is what
 * makes an admin console frustrating to use.
 */
function toError(error: unknown): { ok: false; error: string } {
  if (error instanceof MiddlewareRequestError) {
    if (error.status === undefined) {
      return { ok: false, error: `The control plane is unreachable. ${error.message}` };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        ok: false,
        error:
          "The control plane rejected this portal's identity (401/403). Check that AGENT_MIDDLEWARE_AUDIENCE matches the middleware's AUTH_AUDIENCE and that this service account is in its allow-list.",
      };
    }
    if (error.status === 404) return { ok: false, error: "Not found in the control plane." };
    return { ok: false, error: error.detail || error.message };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Every action funnels through this: one auth check, one error shape, one revalidate. */
async function run<T extends Record<string, unknown>>(fn: () => Promise<T>): Promise<Result<T>> {
  await requireAdmin();
  if (!isMiddlewareDispatchEnabled()) {
    return {
      ok: false,
      error: "The control plane is not enabled in this environment (AGENT_MIDDLEWARE_URL / AGENT_MIDDLEWARE_DISPATCH_ENABLED).",
    };
  }
  try {
    const result = await fn();
    revalidatePath(CONSOLE_PATH);
    return { ok: true, ...result };
  } catch (error) {
    return toError(error);
  }
}

/* ─────────────────────────── agents ─────────────────────────── */

export async function updateAgentAction(
  agentRef: string,
  patch: { name?: string; description?: string | null; model?: string | null; tags?: string[] },
): Promise<Result<{ updatedAt: string }>> {
  return run(async () => {
    const agent = await updateAgent(agentRef, patch);
    return { updatedAt: agent.updatedAt };
  });
}

export async function setAgentStatusAction(
  agentRef: string,
  status: "active" | "disabled",
): Promise<Result<{ status: string }>> {
  return run(async () => {
    const agent = await setAgentStatus(agentRef, status);
    return { status: agent.status };
  });
}

/* ─────────────────────────── prompts ─────────────────────────── */

/**
 * Saving a prompt always creates a new VERSION — the control plane makes
 * existing versions immutable, which is what lets a run's recorded
 * `promptVersion` still mean something a month later.
 *
 * `activate: false` stores it without making it live, so a prompt can be
 * staged and reviewed before it starts affecting client output.
 */
export async function savePromptVersionAction(
  agentRef: string,
  input: { content: string; notes?: string; activate?: boolean },
): Promise<Result<{ version: number; isActive: boolean }>> {
  const content = input.content.trim();
  if (!content) return { ok: false, error: "The prompt body cannot be empty." };

  return run(async () => {
    const admin = await requireAdmin();
    const prompt = await createPromptVersion(agentRef, {
      content,
      ...(input.notes ? { notes: input.notes } : {}),
      activate: input.activate ?? true,
      // Attribution comes from the session, never from the form — a client
      // field here would let a reviewer be recorded as someone else.
      createdBy: admin.email,
    });
    return { version: prompt.version, isActive: prompt.isActive };
  });
}

export async function activatePromptVersionAction(
  agentRef: string,
  promptId: string,
): Promise<Result<{ version: number }>> {
  return run(async () => {
    const prompt = await activatePromptVersion(agentRef, promptId);
    return { version: prompt.version };
  });
}

/* ─────────────────────────── templates ─────────────────────────── */

export async function bindTemplateAction(
  agentRef: string,
  purpose: string,
  templateRef: string,
): Promise<Result> {
  if (!purpose.trim()) return { ok: false, error: "A purpose is required." };
  if (!templateRef.trim()) return { ok: false, error: "A template is required." };

  return run(async () => {
    await bindTemplate(agentRef, purpose.trim(), templateRef.trim());
    return {};
  });
}

/* ─────────────────────── two-tier feedback ─────────────────────── */

/**
 * Tier one — record a verdict on a run.
 *
 * This changes nothing about future runs on its own. That is deliberate: a
 * reviewer's reaction and a change to what the agent does are different
 * decisions, and collapsing them means every rejection quietly rewrites the
 * agent. Tier two (`promoteFeedbackAction`) is the second, explicit step.
 */
export async function submitFeedbackAction(
  agentRef: string,
  runId: string,
  input: {
    rating: number;
    status: "approved" | "rejected" | "needs_changes";
    correctionNotes?: string;
    correctedOutput?: string;
    tags?: string[];
  },
): Promise<Result<{ feedbackId: string }>> {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    return { ok: false, error: "Rating must be a whole number from 1 to 5." };
  }
  // Rejecting without saying why produces feedback nobody can act on, and
  // nothing downstream can promote.
  if (input.status !== "approved" && !input.correctionNotes?.trim() && !input.correctedOutput?.trim()) {
    return { ok: false, error: "Say what should change, or supply the corrected output." };
  }

  return run(async () => {
    const admin = await requireAdmin();
    const feedback = await submitFeedback(agentRef, runId, {
      rating: input.rating,
      status: input.status,
      ...(input.correctionNotes ? { correctionNotes: input.correctionNotes } : {}),
      ...(input.correctedOutput ? { correctedOutput: input.correctedOutput } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      reviewer: admin.email,
    });
    return { feedbackId: feedback.id };
  });
}

/**
 * Tier two — promote a verdict into an active few-shot example.
 *
 * This is the step that actually changes the agent's behaviour, so it is a
 * separate action with its own click.
 */
export async function promoteFeedbackAction(
  agentRef: string,
  feedbackId: string,
  options: { label?: string; assistantOutput?: string } = {},
): Promise<Result<{ exampleId: string }>> {
  return run(async () => {
    const example = await promoteFeedback(agentRef, feedbackId, {
      ...(options.label ? { label: options.label } : {}),
      ...(options.assistantOutput ? { assistantOutput: options.assistantOutput } : {}),
    });
    return { exampleId: example.id };
  });
}

/* ─────────────────────────── models ─────────────────────────── */

/**
 * Sets which model an agent runs on, by normalized id.
 *
 * Refuses a model the catalog does not mark selectable. The dropdown already
 * disables those, but a disabled option is a UI affordance and this is the
 * fence: a `not_enabled` model is one the engine's router will not serve, so
 * storing it would produce an agent that fails at dispatch instead of at the
 * moment someone chose it.
 */
export async function setAgentModelAction(
  agentRef: string,
  modelId: string,
): Promise<Result<{ model: string }>> {
  return run(async () => {
    const catalog = await listModels({ limit: 200 });
    const chosen = catalog.items.find((m) => m.modelId === modelId);
    if (!chosen) throw new Error(`"${modelId}" is not in the model catalog.`);
    if (chosen.availability !== "available") {
      throw new Error(
        `${chosen.displayName} is not enabled in this environment. Use "Request access" instead of selecting it.`,
      );
    }
    const agent = await updateAgent(agentRef, { model: chosen.modelId });
    return { model: agent.model ?? chosen.modelId };
  });
}

/**
 * Records a request for a model this deployment does not route.
 *
 * Deliberately does not enable anything: the engine has to route it and
 * someone has to accept its cost, so the middleware stores who asked and a
 * human decides.
 */
export async function requestModelAccessAction(
  modelId: string,
  options: { reason?: string; agentId?: string } = {},
): Promise<Result<{ requestId: string }>> {
  return run(async () => {
    const admin = await requireAdmin();
    const created = await requestModelAccess(modelId, {
      requestedBy: admin.email,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.agentId ? { agentId: options.agentId } : {}),
    });
    return { requestId: created.id };
  });
}

/* ─────────────────────── dispatch an engine agent ─────────────────────── */

/**
 * Runs a control-plane agent for a client.
 *
 * Separate from `submitCustomAgentJob` because these agents have no lab-repo
 * row: no `entrySkillDir`, no `instructions`, no skill roots. That function's
 * legacy branch needs all three, so routing them through it would submit an
 * agent-service job the runner cannot build the moment a client falls outside
 * the engine gate. These agents only ever run on agent-engine, so this path
 * only ever dispatches there.
 *
 * The credit cost comes from the agent's own record rather than from a
 * constant here: pricing belongs where pricing is set, and a second default in
 * the dispatcher is how two prices for one agent start disagreeing.
 */
export async function dispatchControlPlaneAgentAction(
  agentRef: string,
  input: { clientId: string; inputs?: Record<string, string> },
): Promise<Result<{ jobId: string }>> {
  const admin = await requireAdmin();
  if (!isMiddlewareDispatchEnabled()) {
    return { ok: false, error: "The control plane is not enabled in this environment." };
  }

  const client = await getClient(input.clientId);
  if (!client) return { ok: false, error: "Client not found." };
  if (!client.agentsRepoSlug) {
    return { ok: false, error: `${client.name} has no lab repo slug, which agent-engine resolves its workspace against.` };
  }

  let agent;
  try {
    agent = await getAgent(agentRef);
  } catch (error) {
    return toError(error);
  }
  if (agent.status !== "active") {
    return { ok: false, error: `${agent.name} is ${agent.status} in the control plane.` };
  }

  const dispatched = await dispatchAgentEngineRun({
    clientId: input.clientId,
    clientSlug: client.agentsRepoSlug,
    productId: agent.slug,
    runKind: "recurring",
    agentName: agent.name,
    title: jobTitleForClient(agent.name, client.name),
    ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
    createdBy: admin.uid,
  });
  if ("error" in dispatched) {
    return "jobId" in dispatched
      ? { ok: false, error: `${dispatched.error} (job ${dispatched.jobId})` }
      : { ok: false, error: dispatched.error };
  }

  revalidatePath(CONSOLE_PATH);
  revalidatePath("/agents");
  return { ok: true, jobId: dispatched.jobId };
}
