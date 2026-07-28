"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { generateText, generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS, MAX_ACTIVE_TASKS } from "@/lib/constants";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { requireTaskAccess } from "./_shared";
import {
  createClientTask,
  updateClientTask,
  deleteClientTask,
  getClient,
  getTaskBoardCapacity,
  listCustomAgents,
  listTaskComments,
  createTaskComment,
  chargeClientCredits,
  creditClientCredits,
  claimTaskForExecution,
  releaseTaskClaim,
} from "@/lib/data";
import { findDuplicateReason } from "@/lib/task-dedup";
import {
  runTaskExecution,
  inferOwnerEngine,
  plannedTaskExecutionCost,
} from "@/lib/execution-engine";
import {
  buildTaskExecutionPlanPrompt,
  buildTaskIngestionRoutingPrompt,
} from "@/lib/ai/prompts/proactive-assistant";
import { CREDIT_COSTS, CreditError, isBillableClientActor } from "@/lib/credits";
import { logger } from "@/services/logger";
import type { AppUser, TaskStatus, ClientTask, TaskComment, TaskOwner } from "@/lib/types";

/**
 * Charge a client user for a small Haiku task helper (plan generation,
 * custom-task classification). Staff and impersonated sessions are free.
 * Returns the denial message, or null when the charge went through.
 */
async function chargeTaskAssist(
  user: AppUser,
  clientId: string,
  reason: string,
): Promise<{ denied: string | null; chargedAt: number | null }> {
  if (!isBillableClientActor(user)) return { denied: null, chargedAt: null };
  const chargedAt = Date.now();
  try {
    await chargeClientCredits({
      clientId,
      amount: CREDIT_COSTS.taskAssist,
      operation: "task_execution",
      reason,
      actorUid: user.uid,
      actorName: user.name,
    });
    return { denied: null, chargedAt };
  } catch (e) {
    if (e instanceof CreditError) return { denied: e.message, chargedAt: null };
    throw e;
  }
}

/**
 * Hand a taskAssist charge back when the platform then refuses to create the
 * task. The charge stays where it is, BEFORE the capacity and duplicate checks:
 * the Haiku routing call it pays for has already cost real money by the time
 * those checks run, and its output is what the duplicate check compares. So a
 * refused write is refunded, not reordered (QA F61).
 */
async function refundTaskAssist(
  user: AppUser,
  clientId: string,
  chargedAt: number | null,
  reason: string,
): Promise<void> {
  if (!isBillableClientActor(user) || chargedAt == null) return;
  try {
    await creditClientCredits({
      clientId,
      amount: CREDIT_COSTS.taskAssist,
      kind: "refund",
      chargedAt,
      operation: "task_execution",
      reason,
      actorUid: user.uid,
      actorName: user.name,
    });
  } catch (e) {
    // Never turn a refusal into a crash — the task wasn't created either way.
    console.error("[task-assist] refund failed:", e);
  }
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
    return { ok: false, error: "Tasks you own go straight to Done — Review Pending is for Karos drafts." };
  }

  const triggersExecution =
    status === "in_progress" && inferOwnerEngine(task) === "karos_managed";

  if (triggersExecution) {
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
    if (isBillableClientActor(user)) {
      try {
        await chargeClientCredits({
          clientId,
          amount: await plannedTaskExecutionCost(claimed),
          operation: "task_execution",
          reason: `Task execution · ${claimed.title.slice(0, 80)}`,
          jobId: id,
          actorUid: user.uid,
          actorName: user.name,
        });
      } catch (e) {
        await releaseTaskClaim(id, claimed.status);
        if (e instanceof CreditError) return { ok: false, error: e.message };
        throw e;
      }
    }
    // Re-opening a Done card clears its completion timestamp.
    if (claimed.status === "completed" || claimed.completedAt != null) {
      await updateClientTask(id, { completedAt: null, updatedAt: Date.now() });
    }
    after(() => runTaskExecution(clientId, id).catch(console.error));
    revalidatePath("/tasks");
    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  }

  const patch: Partial<ClientTask> = { status, updatedAt: Date.now() };
  if (status === "completed") patch.completedAt = Date.now();
  if (status !== "completed") patch.completedAt = null;

  await updateClientTask(id, patch);
  revalidatePath("/tasks");
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/** Create a task manually from the Tasks page or client page. */
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

  revalidatePath("/tasks");
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
      error: "This task is currently executing - wait for the run to finish before dismissing it.",
    };
  }

  await deleteClientTask(id);
  revalidatePath("/tasks");
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

  const { denied } = await chargeTaskAssist(user, clientId, `AI plan · ${task.title.slice(0, 80)}`);
  if (denied) return { plan: "", error: denied };

  const client = await getClient(clientId);

  const { text, usage } = await generateText({
    model: anthropic(MODELS.HAIKU),
    prompt: buildTaskExecutionPlanPrompt(
      task.title,
      task.description,
      task.source,
      task.priority,
      client?.name ?? "the client",
      client?.industry,
      client?.website,
    ),
  });

  after(() =>
    logger.logUsage({
      clientId, agentId: null, agentName: "Task Plan",
      modelName: MODELS.HAIKU, operation: "task_plan",
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    }),
  );

  await updateClientTask(taskId, {
    metadata: { ...(task.metadata ?? {}), aiPlan: text },
    updatedAt: Date.now(),
  });

  revalidatePath("/tasks");
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

  const { denied, chargedAt } = await chargeTaskAssist(user, clientId, "Custom task ingestion");
  if (denied) return { ok: false, error: denied };

  // Build a brief capability summary for the routing prompt from the repo agents
  // the Karos team can run for clients.
  const agents = await listCustomAgents();
  const agentSummary = agents
    .filter((a) => a.enabled)
    .map((a) => (a.description ? `${a.name} — ${a.description}` : a.name))
    .join("; ") || "none configured";

  const routingSchema = z.object({
    title: z.string().max(120).describe("Short, action-verb task title"),
    description: z.string().max(400).describe("Context and acceptance criteria"),
    priority: z.enum(["high", "medium", "low"]),
    owner: z.enum(["karos_managed", "client_managed"]),
  });

  const { object: parsed, usage } = await generateObject({
    model: anthropic(MODELS.HAIKU),
    schema: routingSchema,
    prompt: buildTaskIngestionRoutingPrompt(
      trimmed,
      client.name,
      client.industry ?? "marketing",
      agentSummary,
    ),
  });

  after(() =>
    logger.logUsage({
      clientId, agentId: null, agentName: "Task Ingestion Routing",
      modelName: MODELS.HAIKU, operation: "task_ingestion",
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    }),
  );

  // The cap bounds the Karos AI execution queue only — apply it after routing,
  // once we know which owner the task landed on.
  if (parsed.owner === "karos_managed" && capacity.activeCount >= MAX_ACTIVE_TASKS) {
    await refundTaskAssist(user, clientId, chargedAt, "Refund · task queue at capacity");
    return {
      ok: false,
      error: `The Karos AI queue is at capacity (${MAX_ACTIVE_TASKS} active tasks). Complete or approve existing tasks first.`,
    };
  }

  // Three-tier dedup (exact title, near-identical wording, product scope)
  // against the same snapshot the cap was computed from.
  const dupReason = findDuplicateReason({ title: parsed.title }, capacity.tasks);
  if (dupReason) {
    await refundTaskAssist(user, clientId, chargedAt, "Refund · duplicate task not created");
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

  revalidatePath("/tasks");
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
