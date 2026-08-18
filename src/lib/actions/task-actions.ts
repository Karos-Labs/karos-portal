"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { generateText, generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS, MAX_ACTIVE_TASKS } from "@/lib/constants";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { requireTaskAccess, campaignDependencyBlocker } from "./_shared";
import {
  createClientTask,
  updateClientTask,
  deleteClientTask,
  getClient,
  getTaskBoardCapacity,
  listCustomAgents,
  listTaskComments,
  createTaskComment,
  claimTaskForExecution,
  releaseTaskClaim,
} from "@/lib/data";
import { findDuplicateReason } from "@/lib/task-dedup";
import { taskIsDisabled, TASK_PAUSED_MESSAGE } from "@/lib/task-disable-copy";
import {
  runTaskExecution,
  inferOwnerEngine,
  plannedTaskExecutionCost,
} from "@/lib/execution-engine";
import {
  buildTaskExecutionPlanPrompt,
  buildTaskIngestionRoutingPrompt,
} from "@/lib/ai/prompts/proactive-assistant";
import { CREDIT_COSTS } from "@/lib/credits";
import { chargeClientModelCall, withClientModelCharge } from "@/lib/client-model-charge";
import { clientTaskRunRefusal } from "@/lib/client-agent-gate";
import { logger } from "@/services/logger";
import type { AppUser, TaskStatus, ClientTask, TaskComment, TaskOwner } from "@/lib/types";
import { clientCategoryValue } from "@/lib/utils";

/**
 * The charge spec for a small Haiku task helper (plan generation, custom-task
 * classification). Staff and impersonated sessions are free — that decision,
 * and the refund pairing, belong to `withClientModelCharge`
 * (lib/client-model-charge.ts), which is the app's one way to say "a client
 * triggered a model call".
 *
 * The charge stays where it always was, BEFORE the capacity and duplicate
 * checks: the Haiku routing call it pays for has already cost real money by the
 * time those checks run, and its output is what the duplicate check compares.
 * So a refused write is refunded, not reordered (QA F61) — and now a THROWN
 * call is refunded too, which the hand-paired version never did.
 */
function taskAssistCharge(user: AppUser, clientId: string, reason: string) {
  return {
    user,
    clientId,
    amount: CREDIT_COSTS.taskAssist,
    operation: "task_execution" as const,
    reason,
  };
}

/**
 * Update a task's status. Accessible to the owning client user and staff.
 * Moving a karos_managed task into In Progress automatically triggers its
 * mapped ecosystem agent — every UI path (drag, card button, modal footer)
 * lands here, so the trigger cannot be bypassed client-side. The trigger goes
 * through the SAME atomic claim + product-aware charge as the primary
 * execution actions: dragging a Review/Done card back to In Progress is a
 * re-run and is claimed and priced like one — never a free side door.
 */
export async function updateTaskStatusAction(
  id: string,
  status: TaskStatus,
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(id, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { user, task } = access;

  // "archived" is a system state set by the archiving sweep — staff may force
  // it manually, clients may not.
  if (status === "archived" && user.role === "CLIENT_USER") {
    return { ok: false, error: "Forbidden" };
  }

  // Review Pending holds AI drafts awaiting Karos review. Client-owned work has
  // no column for it on either board, so a task landing there disappears from
  // the board while still counting in the tab total (QA F54). Refuse the move
  // server-side, whichever UI path asks for it.
  if (status === "review_pending" && inferOwnerEngine(task) === "client_managed") {
    return { ok: false, error: "Tasks you own go straight to Done. Review Pending is for Karos drafts." };
  }

  const triggersExecution =
    status === "in_progress" && inferOwnerEngine(task) === "karos_managed";

  if (triggersExecution) {
    // An admin paused this task (see task-disable-copy.ts) — refused before
    // anything else, so a paused task never reaches the umbrella check, the
    // claim or the charge either.
    if (taskIsDisabled(task)) return { ok: false, error: TASK_PAUSED_MESSAGE };

    // §2 guard rail, keyed on the BILLED actor (D1). Dragging a card to In
    // Progress is the task board's run button: same agent, same charge, so the
    // same refusal while its umbrella is not live. Evaluated before the claim.
    const blocked = await clientTaskRunRefusal({ user, clientId, task });
    if (blocked) return { ok: false, error: blocked };

    // A campaign step (e.g. the newsletter) can't run ahead of the piece it
    // depends on (the anchor blog) — there's nothing yet for it to build on.
    // Checked before the claim so a premature attempt costs nothing.
    const blocker = await campaignDependencyBlocker(task);
    if (blocker) {
      return {
        ok: false,
        error: `Waiting on "${blocker}" to finish first. This campaign step runs after it.`,
      };
    }

    // Re-opening a completed task is a NET NEW active slot (pending/review_pending
    // are already counted in the cap) — enforce the same queue cap that task
    // creation does, or a client could re-run Done cards past MAX_ACTIVE_TASKS
    // indefinitely, each one a real charge + agent dispatch.
    if (task.status === "completed") {
      const capacity = await getTaskBoardCapacity(clientId);
      if (capacity.activeCount >= MAX_ACTIVE_TASKS) {
        return {
          ok: false,
          error: `The Karos AI queue is at capacity (${MAX_ACTIVE_TASKS} active tasks). Complete or approve existing tasks first.`,
        };
      }
    }
    // Atomic claim (verifies not already executing, flips to in_progress) —
    // two tabs can't double-dispatch, and the charge matches what runs.
    const claimed = await claimTaskForExecution(id, clientId, [
      "pending",
      "review_pending",
      "completed",
    ]);
    if (!claimed) {
      return { ok: false, error: "Task is already running or not in a runnable state" };
    }
    // Through `chargeClientModelCall` like every other client-triggered model
    // call. It also no longer needs its own isBillableClientActor test — the
    // helper owns that question, and asking it twice is how the four spellings
    // of this block came to disagree.
    let denied: string | null;
    try {
      ({ denied } = await chargeClientModelCall({
        user,
        clientId,
        amount: await plannedTaskExecutionCost(claimed),
        operation: "task_execution",
        reason: `Task execution · ${claimed.title.slice(0, 80)}`,
        jobId: id,
      }));
    } catch (e) {
      await releaseTaskClaim(id, claimed.status);
      throw e;
    }
    if (denied !== null) {
      await releaseTaskClaim(id, claimed.status);
      return { ok: false, error: denied };
    }
    // Re-opening a Done card clears its completion timestamp.
    if (claimed.status === "completed" || claimed.completedAt != null) {
      await updateClientTask(id, { completedAt: null, updatedAt: Date.now() });
    }
    after(() => runTaskExecution(clientId, id).catch(console.error));
    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  }

  const patch: Partial<ClientTask> = { status, updatedAt: Date.now() };
  if (status === "completed") patch.completedAt = Date.now();
  if (status !== "completed") patch.completedAt = null;

  await updateClientTask(id, patch);
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/** Create a task manually from the client page. */
export async function createTaskAction(input: {
  clientId: string;
  title: string;
  description?: string;
  priority?: "high" | "medium" | "low";
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const user = await requireUser();

  if (user.role === "CLIENT_USER" && user.clientId !== input.clientId) {
    return { ok: false, error: "Forbidden" };
  }

  const client = await getClient(input.clientId);
  if (!client) return { ok: false, error: "Client not found" };

  // No capacity check: manual tasks infer client_managed, which is exempt
  // from the karos_managed execution-queue cap.
  const id = await createClientTask({
    clientId: input.clientId,
    title: input.title.trim(),
    description: input.description?.trim(),
    status: "pending",
    priority: input.priority ?? "medium",
    source: "manual",
    createdBy: user.uid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  revalidatePath(`/clients/${input.clientId}`);
  return { ok: true, id };
}

/**
 * Delete/dismiss a task. Staff can delete any; a client user can dismiss
 * tasks on their own board (requireTaskAccess verifies the task belongs to
 * the clientId AND the caller may act for that client).
 */
export async function deleteTaskAction(
  id: string,
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(id, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { task } = access;

  // Never delete mid-execution: the run would keep burning compute, its
  // webhook would find no task to land on, and the upfront charge could
  // never be refunded through any path. Let it finish (or fail) first.
  if (task.metadata?.executing === true) {
    return {
      ok: false,
      error: "This task is currently executing. Wait for the run to finish before dismissing it.",
    };
  }

  await deleteClientTask(id);
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/**
 * Admin-only: pause a task (or resume it), keyed to `metadata.disabled` and
 * checked at every execution-trigger door (see task-disable-copy.ts). Written
 * for the case a task's linked custom agent got turned off — left alone, the
 * task just sits active until someone drags it and pays for a run
 * execution-engine.ts refunds a moment later — but any admin may pause any
 * task, and resuming is never tied to the agent's own state coming back; it is
 * the admin's own call either way.
 *
 * Employees are refused, not just clients: `requireTaskAccess` alone would
 * let staff generally through, and this is scoped narrower than the rest of
 * the task actions on purpose.
 */
export async function setTaskDisabledAction(
  id: string,
  clientId: string,
  disabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const access = await requireTaskAccess(id, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  if (access.user.role !== "KAROS_ADMIN") return { ok: false, error: "Forbidden" };
  const { task } = access;

  await updateClientTask(id, {
    metadata: { ...(task.metadata ?? {}), disabled },
    updatedAt: Date.now(),
  });

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/** Fetch comments for a task ticket. */
export async function getTaskCommentsAction(
  taskId: string,
  clientId: string,
): Promise<{ comments: TaskComment[]; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { comments: [], error: access.error };
  const comments = await listTaskComments(taskId);
  return { comments };
}

/** Add a comment to a task ticket. */
export async function addTaskCommentAction(
  taskId: string,
  clientId: string,
  content: string,
): Promise<{ ok: boolean; comment?: TaskComment; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { ok: false, error: access.error };
  const { user } = access;
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, error: "Comment cannot be empty" };

  const now = Date.now();
  const id = await createTaskComment({
    taskId,
    clientId,
    content: trimmed,
    authorName: user.name,
    authorRole: user.role,
    createdAt: now,
  });

  return {
    ok: true,
    comment: { id, taskId, clientId, content: trimmed, authorName: user.name, authorRole: user.role, createdAt: now },
  };
}

/**
 * Generate a step-by-step AI execution plan for a task using Claude Haiku.
 * Persists the plan in task.metadata.aiPlan for caching.
 */
export async function generateTaskPlanAction(
  taskId: string,
  clientId: string,
): Promise<{ plan: string; error?: string }> {
  const access = await requireTaskAccess(taskId, clientId);
  if (!access.ok) return { plan: "", error: access.error };
  const { user, task } = access;

  // Serve the persisted plan when one exists — no model call, no charge.
  const cached = task.metadata?.aiPlan;
  if (typeof cached === "string" && cached.trim()) return { plan: cached };

  const client = await getClient(clientId);

  const taskPlanUsageMeta = {
    clientId, agentId: null, agentName: "Task Plan",
    modelName: MODELS.HAIKU, operation: "task_plan",
  };
  const outcome = await withClientModelCharge(
    taskAssistCharge(user, clientId, `AI plan · ${task.title.slice(0, 80)}`),
    async () => {
      let text: string;
      let usage: { inputTokens?: number; outputTokens?: number };
      try {
        ({ text, usage } = await generateText({
          model: anthropic(MODELS.HAIKU),
          prompt: buildTaskExecutionPlanPrompt(
            task.title,
            task.description,
            task.source,
            task.priority,
            client?.name ?? "the client",
            client ? clientCategoryValue(client) ?? undefined : undefined,
            client?.website,
          ),
        }));
      } catch (err) {
        logger.logGenerationFailure(taskPlanUsageMeta, err);
        // Rethrown, so the wrapper refunds. The client asked for a plan and got
        // an error; they are not paying for it.
        throw err;
      }

      after(() =>
        logger.logUsage({
          ...taskPlanUsageMeta,
          inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
        }),
      );

      await updateClientTask(taskId, {
        metadata: { ...(task.metadata ?? {}), aiPlan: text },
        updatedAt: Date.now(),
      });
      return text;
    },
  );
  if (!outcome.ok) return { plan: "", error: outcome.denied };
  const text = outcome.result;

  return { plan: text };
}

/**
 * Ingest a free-text task description from the user, classify it with Claude Haiku,
 * route it to the correct owner (karos_managed vs client_managed), and persist it.
 * Runs the three-tier dedup (task-dedup.ts) to prevent duplicate intents.
 */
export async function ingestCustomUserTaskAction(
  clientId: string,
  text: string,
): Promise<{
  ok: boolean;
  taskId?: string;
  owner?: TaskOwner;
  /** The routed title — the model rewrites what the user typed (QA F65). */
  title?: string;
  error?: string;
  /** The refusal is informational: an equivalent task is already on the board. */
  duplicate?: boolean;
}> {
  const user = await requireUser();

  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Task description cannot be empty" };
  if (trimmed.length > 1000) return { ok: false, error: "Task description is too long" };

  const [client, capacity] = await Promise.all([
    getClient(clientId),
    getTaskBoardCapacity(clientId),
  ]);
  if (!client) return { ok: false, error: "Client not found" };

  const outcome = await withClientModelCharge(
    taskAssistCharge(user, clientId, "Custom task ingestion"),
    ({ refund }) => ingestRoutedTask({ user, clientId, client, capacity, trimmed, refund }),
  );
  return outcome.ok ? outcome.result : { ok: false, error: outcome.denied };
}

type IngestResult = Awaited<ReturnType<typeof ingestCustomUserTaskAction>>;

/**
 * The charged half of task ingestion: the Haiku routing call and the three
 * outcomes it can lead to. Split out so the whole of it sits inside the charge
 * wrapper — a throw from `generateObject` here is refunded by the wrapper,
 * which is what the hand-paired version missed while correctly refunding the
 * two REFUSALS below it.
 */
async function ingestRoutedTask(args: {
  user: AppUser;
  clientId: string;
  client: NonNullable<Awaited<ReturnType<typeof getClient>>>;
  capacity: Awaited<ReturnType<typeof getTaskBoardCapacity>>;
  trimmed: string;
  refund: (reason: string) => Promise<void>;
}): Promise<IngestResult> {
  const { user, clientId, client, capacity, trimmed, refund } = args;

  // Build a brief capability summary for the routing prompt from the repo agents
  // the Karos team can run for clients.
  const agents = await listCustomAgents();
  const agentSummary = agents
    .filter((a) => a.enabled)
    .map((a) => (a.description ? `${a.name} · ${a.description}` : a.name))
    .join("; ") || "none configured";

  const routingSchema = z.object({
    title: z.string().max(120).describe("Short, action-verb task title"),
    description: z.string().max(400).describe("Context and acceptance criteria"),
    priority: z.enum(["high", "medium", "low"]),
    owner: z.enum(["karos_managed", "client_managed"]),
  });

  const ingestionUsageMeta = {
    clientId, agentId: null, agentName: "Task Ingestion Routing",
    modelName: MODELS.HAIKU, operation: "task_ingestion",
  };
  let parsed: z.infer<typeof routingSchema>;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    ({ object: parsed, usage } = await generateObject({
      model: anthropic(MODELS.HAIKU),
      schema: routingSchema,
      prompt: buildTaskIngestionRoutingPrompt(
        trimmed,
        client.name,
        clientCategoryValue(client) ?? "marketing",
        agentSummary,
      ),
    }));
  } catch (err) {
    logger.logGenerationFailure(ingestionUsageMeta, err);
    throw err;
  }

  after(() =>
    logger.logUsage({
      ...ingestionUsageMeta,
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    }),
  );

  // The cap bounds the Karos AI execution queue only — apply it after routing,
  // once we know which owner the task landed on.
  if (parsed.owner === "karos_managed" && capacity.activeCount >= MAX_ACTIVE_TASKS) {
    await refund("Refund · task queue at capacity");
    return {
      ok: false,
      error: `The Karos AI queue is at capacity (${MAX_ACTIVE_TASKS} active tasks). Complete or approve existing tasks first.`,
    };
  }

  // Three-tier dedup (exact title, near-identical wording, product scope)
  // against the same snapshot the cap was computed from.
  const dupReason = findDuplicateReason({ title: parsed.title }, capacity.tasks);
  if (dupReason) {
    await refund("Refund · duplicate task not created");
    // `duplicate` lets the UI render this as information, not a red failure —
    // nothing went wrong, the work is already on the board.
    return {
      ok: false,
      duplicate: true,
      error: `A similar task already exists on your board (${dupReason}).`,
    };
  }

  const now = Date.now();
  const taskId = await createClientTask({
    clientId,
    title: parsed.title,
    description: parsed.description,
    status: "pending",
    priority: parsed.priority,
    source: "custom",
    owner: parsed.owner,
    createdBy: user.uid,
    createdAt: now,
    updatedAt: now,
  });

  revalidatePath(`/clients/${clientId}`);
  return { ok: true, taskId, owner: parsed.owner, title: parsed.title };
}

/** Save Google OAuth access token for a CLIENT_USER after Google sign-in. */
export async function saveGoogleOAuthTokenAction(
  accessToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();

  // Only meaningful for client users with a linked clientId
  if (user.role !== "CLIENT_USER" || !user.clientId) {
    return { ok: true }; // no-op for staff
  }

  // Verify the token is a real Google-issued token for THIS user before storing it.
  // Without this a client could inject an arbitrary bearer that we later replay
  // server-side (Gmail fetch) — a credential-injection / SSRF-adjacent vector.
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) {
      return { ok: false, error: "Could not verify your Google sign-in. Please reconnect." };
    }
    const info = (await res.json()) as { email?: string };
    if (info.email && user.email && info.email.toLowerCase() !== user.email.toLowerCase()) {
      return { ok: false, error: "That Google account doesn't match your Karos account." };
    }
  } catch {
    return { ok: false, error: "Couldn't reach Google to verify your sign-in. Please try again." };
  }

  const { upsertClientIntegration } = await import("@/lib/data");
  await upsertClientIntegration({
    clientId: user.clientId,
    platform: "google",
    accountName: user.email,
    credentials: { access_token: accessToken },
    method: "oauth",
    status: "active",
    connectedBy: user.uid,
    connectedAt: Date.now(),
    updatedAt: Date.now(),
  });

  return { ok: true };
}
