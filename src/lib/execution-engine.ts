/**
 * Karos Task Execution Engine — server-side only.
 * Contains the actual AI generation logic without auth guards.
 * Called by execution-actions.ts (with auth) and settings-actions.ts (via after()).
 */
import "server-only";

import { revalidatePath } from "next/cache";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import {
  getClientTask,
  getClient,
  updateClientTask,
  listClientTasks,
} from "@/lib/data";
import { sendEmail } from "@/lib/email";
import { buildArtifactGenerationPrompt } from "@/lib/ai/prompts/proactive-assistant";
import type { ClientTask, TaskOwner } from "@/lib/types";
import { logger } from "@/services/logger";
import type { ModelId } from "@/lib/constants";

/* ── Constants ───────────────────────────────────────────────────── */

const SONNET = anthropic(MODELS.SONNET);
const HAIKU = anthropic(MODELS.HAIKU);

/* ── Internal helpers ────────────────────────────────────────────── */

export function inferOwnerEngine(task: ClientTask): TaskOwner {
  return task.owner ?? (task.source === "manual" ? "client_managed" : "karos_managed");
}

export function resolveTaskType(task: ClientTask): "content_generation" | "integration_action" {
  const explicit = task.metadata?.type as string | undefined;
  if (explicit === "integration_action") return "integration_action";
  if (explicit === "content_generation") return "content_generation";

  // Heuristic: Gmail-sourced tasks whose title suggests external dispatch
  if (task.source === "gmail") {
    const dispatch = ["send", "deliver", "dispatch", "submit", "forward", "notify", "reply"];
    const title = task.title.toLowerCase();
    if (dispatch.some((kw) => title.includes(kw))) return "integration_action";
  }
  return "content_generation";
}

/** True when a task warrants the high-capability model (kept in sync with selectModel). */
function usesSonnet(task: ClientTask): boolean {
  return task.source === "content_dispatch" || task.priority === "high";
}

function selectModel(task: ClientTask) {
  return usesSonnet(task) ? SONNET : HAIKU;
}

/** The model id string for the model selectModel would pick — used for usage logging. */
function selectModelName(task: ClientTask): ModelId {
  return usesSonnet(task) ? MODELS.SONNET : MODELS.HAIKU;
}

/* ── Core single-task runner ─────────────────────────────────────── */

/**
 * Executes a single karos_managed task via Claude:
 * - Generates an artifact (Flow A: content; Flow B: email/publish draft)
 * - On a re-run (adjustment feedback present), feeds the model both the
 *   original task context AND the previous output + client feedback.
 * - Advances status to review_pending on success
 * - Records error in metadata on failure (status returns to pending)
 */
export async function runTaskExecution(clientId: string, taskId: string): Promise<void> {
  const [task, client] = await Promise.all([getClientTask(taskId), getClient(clientId)]);
  if (!task || !client) return;
  // Defense in depth: never generate with a mismatched client context.
  if (task.clientId !== clientId) return;

  const taskType = resolveTaskType(task);
  const adjustmentFeedback = task.metadata?.adjustmentFeedback as string | undefined;
  // On a re-run the prior deliverable is still on the task — it becomes the
  // revision base so the model refines rather than regenerates from scratch.
  const previousArtifact = adjustmentFeedback
    ? (task.metadata?.artifact as string | undefined)
    : undefined;

  try {
    const { text: artifact, usage } = await generateText({
      model: selectModel(task),
      prompt: buildArtifactGenerationPrompt(
        task.title,
        task.description,
        task.source,
        task.priority,
        taskType,
        client.name,
        client.industry,
        client.website,
        client.brandVoice,
        adjustmentFeedback,
        previousArtifact,
      ),
    });

    logger.logUsage({
      clientId, agentId: null, agentName: "Task Execution",
      modelName: selectModelName(task), operation: "task_execution",
      inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    });

    await updateClientTask(taskId, {
      status: "review_pending",
      metadata: {
        ...(task.metadata ?? {}),
        executing: false,
        type: taskType,
        artifact,
        adjustmentFeedback: null,
        executionError: null,
      },
      updatedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown execution error";
    await updateClientTask(taskId, {
      status: "pending",
      metadata: {
        ...(task.metadata ?? {}),
        executing: false,
        executionError: message,
      },
      updatedAt: Date.now(),
    });
  }

  revalidatePath("/tasks");
  revalidatePath(`/clients/${clientId}`);
}

/* ── Autopilot batch runner ──────────────────────────────────────── */

/**
 * Picks up all pending karos_managed tasks for a client and executes them
 * sequentially. Capped at 5 tasks per invocation to respect after() time budget.
 */
export async function runAutopilotBatch(clientId: string): Promise<void> {
  const allTasks = await listClientTasks({ clientId, status: "pending", limit: 10 });
  const pendingKaros = allTasks
    .filter((t) => inferOwnerEngine(t) === "karos_managed")
    .slice(0, 5);

  if (pendingKaros.length === 0) return;

  const now = Date.now();
  await Promise.all(
    pendingKaros.map((t) =>
      updateClientTask(t.id, {
        status: "in_progress",
        metadata: { ...(t.metadata ?? {}), executing: true, executionError: null },
        updatedAt: now,
      }),
    ),
  );

  revalidatePath("/tasks");

  for (const t of pendingKaros) {
    await runTaskExecution(clientId, t.id).catch(console.error);
  }
}

/**
 * Execute an explicit set of already-claimed tasks (status flipped to
 * in_progress + executing by claimTaskForExecution). Used by the credit-charged
 * client autopilot path so the executed batch is exactly the charged batch.
 */
export async function runClaimedTasks(clientId: string, taskIds: string[]): Promise<void> {
  revalidatePath("/tasks");
  for (const id of taskIds) {
    await runTaskExecution(clientId, id).catch(console.error);
  }
}

/* ── Integration publish helper ──────────────────────────────────── */

/**
 * Sends a task artifact via Resend to the specified recipient.
 * Returns success/failure so the caller can update Firestore accordingly.
 */
export async function dispatchArtifactEmail(
  task: ClientTask,
  clientName: string,
  recipient: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const artifact = task.metadata?.artifact as string | undefined;
  if (!artifact) return { ok: false, error: "No artifact to dispatch" };

  const subjectMatch = artifact.match(/^Subject:\s*(.+)$/im);
  const subject = subjectMatch?.[1]?.trim() ?? task.title;
  const body = subjectMatch
    ? artifact.slice(artifact.indexOf("\n", artifact.search(/^Subject:/im)) + 1).trim()
    : artifact;

  const safeBody = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeClientName = clientName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#07090b;padding:32px;color:#e8f0ec;">
      <div style="max-width:600px;margin:0 auto;background:#0d1117;border:1px solid #20303a;border-radius:16px;overflow:hidden;">
        <div style="padding:20px 28px;border-bottom:1px solid #20303a;">
          <span style="color:#FF6B2C;font-weight:700;font-size:18px;letter-spacing:0.4px;">Karos<span style="color:#e8f0ec;">CMO</span></span>
        </div>
        <div style="padding:28px;">
          <p style="color:#9c9ca3;font-size:13px;margin:0 0 12px;">Delivered by Karos on behalf of ${safeClientName}</p>
          <div style="background:#131a22;border:1px solid #20303a;border-radius:12px;padding:20px;font-size:15px;line-height:1.7;white-space:pre-wrap;color:#e8f0ec;">${safeBody}</div>
        </div>
      </div>
    </div>`;

  return sendEmail({ to: recipient, subject, html });
}
