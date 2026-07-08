"use server";

import { revalidatePath } from "next/cache";
import { generateText, generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import {
  createClientTask,
  updateClientTask,
  deleteClientTask,
  getClient,
  getClientTask,
  listTaskComments,
  createTaskComment,
  normalizeTitleForDedup,
  taskTitleExists,
  chargeClientCredits,
} from "@/lib/data";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import {
  buildTaskExecutionPlanPrompt,
  buildTaskIngestionRoutingPrompt,
} from "@/lib/ai/prompts/proactive-assistant";
import { CREDIT_COSTS, CreditError, isBillableClientActor } from "@/lib/credits";
import type { AppUser, TaskStatus, ClientTask, TaskComment, TaskOwner } from "@/lib/types";

/**
 * Charge a client user for a small Haiku task helper (plan generation,
 * custom-task classification). Staff and impersonated sessions are free.
 * Returns the denial message, or null when the charge went through.
 */
async function chargeTaskAssist(user: AppUser, clientId: string, reason: string): Promise<string | null> {
  if (!isBillableClientActor(user)) return null;
  try {
    await chargeClientCredits({
      clientId,
      amount: CREDIT_COSTS.taskAssist,
      operation: "task_execution",
      reason,
      actorUid: user.uid,
      actorName: user.name,
    });
    return null;
  } catch (e) {
    if (e instanceof CreditError) return e.message;
    throw e;
  }
}

/** Update a task's status. Accessible to the owning client user and staff. */
export async function updateTaskStatusAction(
  id: string,
  status: TaskStatus,
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();

  // CLIENT_USER may only update tasks for their own client
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
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

/** Delete a task. Staff-only from the UI; clients can only update status. */
export async function deleteTaskAction(
  id: string,
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  void user; // authorization handled by requireUser role check

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
  const user = await requireUser();
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { comments: [], error: "Forbidden" };
  }
  const comments = await listTaskComments(taskId);
  return { comments };
}

/** Add a comment to a task ticket. */
export async function addTaskCommentAction(
  taskId: string,
  clientId: string,
  content: string,
): Promise<{ ok: boolean; comment?: TaskComment; error?: string }> {
  const user = await requireUser();
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }
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
  const user = await requireUser();
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { plan: "", error: "Forbidden" };
  }

  const [task, client] = await Promise.all([getClientTask(taskId), getClient(clientId)]);
  if (!task) return { plan: "", error: "Task not found" };
  if (task.clientId !== clientId) return { plan: "", error: "Forbidden" };

  // Serve the persisted plan when one exists — no model call, no charge.
  const cached = task.metadata?.aiPlan;
  if (typeof cached === "string" && cached.trim()) return { plan: cached };

  const denied = await chargeTaskAssist(user, clientId, `AI plan · ${task.title.slice(0, 80)}`);
  if (denied) return { plan: "", error: denied };

  const { text } = await generateText({
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
 * Respects normalizeTitleForDedup() to prevent duplicates.
 */
export async function ingestCustomUserTaskAction(
  clientId: string,
  text: string,
): Promise<{ ok: boolean; taskId?: string; owner?: TaskOwner; error?: string }> {
  const user = await requireUser();

  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return { ok: false, error: "Forbidden" };
  }

  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Task description cannot be empty" };
  if (trimmed.length > 1000) return { ok: false, error: "Task description is too long" };

  const client = await getClient(clientId);
  if (!client) return { ok: false, error: "Client not found" };

  const denied = await chargeTaskAssist(user, clientId, "Custom task ingestion");
  if (denied) return { ok: false, error: denied };

  // Build a brief capability summary for the routing prompt from the managed
  // product catalog (the karos-agents lab products the Karos team can run).
  const agentSummary = MANAGED_PRODUCTS
    .map((p) => `${p.name} (${p.taskType})`)
    .join(", ") || "none configured";

  const routingSchema = z.object({
    title: z.string().max(120).describe("Short, action-verb task title"),
    description: z.string().max(400).describe("Context and acceptance criteria"),
    priority: z.enum(["high", "medium", "low"]),
    owner: z.enum(["karos_managed", "client_managed"]),
  });

  const { object: parsed } = await generateObject({
    model: anthropic(MODELS.HAIKU),
    schema: routingSchema,
    prompt: buildTaskIngestionRoutingPrompt(
      trimmed,
      client.name,
      client.industry ?? "marketing",
      agentSummary,
    ),
  });

  // Dedup check against the AI-extracted title
  const normalizedTitle = normalizeTitleForDedup(parsed.title);
  const exists = await taskTitleExists(clientId, normalizedTitle);
  if (exists) {
    return { ok: false, error: "A similar task already exists on your board" };
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
  return { ok: true, taskId, owner: parsed.owner };
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
