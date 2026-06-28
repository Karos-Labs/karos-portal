"use server";

import { revalidatePath } from "next/cache";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { requireUser } from "@/lib/auth";
import {
  createClientTask,
  updateClientTask,
  deleteClientTask,
  getClient,
  getClientTask,
  listTaskComments,
  createTaskComment,
} from "@/lib/data";
import { buildTaskExecutionPlanPrompt } from "@/lib/ai/prompts/proactive-assistant";
import type { TaskStatus, ClientTask, TaskComment } from "@/lib/types";

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

  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5-20251001"),
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
