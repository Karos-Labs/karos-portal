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
  getCustomAgent,
  updateClientTask,
  listClientTasks,
  listEmployeeSeats,
  getClientPerformanceBenchmarks,
} from "@/lib/data";
import { sendEmail } from "@/lib/email";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { MANAGED_PRODUCTS, type ManagedProduct } from "@/lib/agent-service/products";
import { CREDIT_COSTS, taskExecutionCost } from "@/lib/credits";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { submitManagedJob } from "@/lib/jobs/submit-managed";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { buildArtifactGenerationPrompt, type EmployeeAdvocacyProfile } from "@/lib/ai/prompts/proactive-assistant";
import type { AppUser, ClientTask, CustomAgent, ManagedTaskType, TaskOwner } from "@/lib/types";
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

/* ── Task → managed product mapping ──────────────────────────────── */

/** Actor stamped on jobs the task engine dispatches without a user in scope. */
const TASK_ENGINE_ACTOR: AppUser = {
  uid: "karos_task_engine",
  email: "system@karoslabs.com",
  name: "Karos Task Engine",
  role: "KAROS_ADMIN",
  createdAt: 0,
};

/** Keyword heuristics for tasks created before productType linking existed. */
const PRODUCT_KEYWORDS: Array<{ taskType: ManagedTaskType; pattern: RegExp }> = [
  { taskType: "newsletter_issue", pattern: /newsletter/i },
  { taskType: "blog_article", pattern: /\bblog\b|\barticle\b|\bseo\b/i },
  { taskType: "landing_page", pattern: /landing\s*page/i },
  { taskType: "social_post", pattern: /instagram|tiktok|social\s*(media\s*)?post|\bcarousel\b|\breel\b/i },
];

/**
 * The credit price of executing this task, resolved against what will ACTUALLY
 * run (must mirror runTaskExecution's dispatch decision so the charge always
 * matches the run):
 *   - custom-agent task  → that agent's creditCost (or the customAgentRun default)
 *   - managed product    → that product's rate (media-heavy > text-only)
 *   - anything else       → the flat in-process baseline
 * Async because the custom-agent price lives on the CustomAgent doc. Charging
 * call sites (start, re-run, autopilot) all await this.
 */
export async function plannedTaskExecutionCost(task: ClientTask): Promise<number> {
  if (resolveTaskType(task) === "content_generation" && isAgentServiceConfigured()) {
    const customAgentId = resolveTaskCustomAgentId(task);
    if (customAgentId) {
      const agent = await getCustomAgent(customAgentId);
      return agent?.creditCost ?? CREDIT_COSTS.customAgentRun;
    }
    const product = resolveTaskProduct(task);
    if (product) return taskExecutionCost(product.taskType);
  }
  return taskExecutionCost(null);
}

/**
 * The custom agent (git-imported, allowlisted per client) bound to this task,
 * or null. Only an explicit link counts — custom agents are never inferred
 * from title keywords the way managed products are.
 */
export function resolveTaskCustomAgentId(task: ClientTask): string | null {
  const id = task.metadata?.customAgentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Map a karos_managed task to the managed product (ecosystem agent) that
 * executes it: the Copilot's explicit `metadata.productType` link first, then
 * keyword inference. Null ⇒ no product fits (research, analysis, email
 * dispatch) and the in-process engine handles it.
 */
export function resolveTaskProduct(task: ClientTask): ManagedProduct | null {
  const linked = task.metadata?.productType as ManagedTaskType | undefined;
  const byLink = linked && MANAGED_PRODUCTS.find((p) => p.taskType === linked);
  if (byLink) return byLink;

  const text = `${task.title} ${task.description ?? ""}`;
  for (const { taskType, pattern } of PRODUCT_KEYWORDS) {
    if (pattern.test(text)) {
      const product = MANAGED_PRODUCTS.find((p) => p.taskType === taskType);
      if (product) return product;
    }
  }
  return null;
}

/**
 * Build the product brief from the task. On a re-run, the client's feedback is
 * appended as an explicit revision request so the agent refines rather than
 * repeats.
 */
function buildTaskBrief(
  task: ClientTask,
  product: ManagedProduct,
  adjustmentFeedback?: string,
): Record<string, unknown> {
  const topic =
    task.description && task.description.trim()
      ? `${task.title} — ${task.description.trim()}`
      : task.title;
  const revision = adjustmentFeedback
    ? `\n\nREVISION REQUEST — a previous version was reviewed by the client; incorporate every point: "${adjustmentFeedback}"`
    : "";

  switch (product.taskType) {
    case "social_post": {
      const countMatch = task.title.match(/\b([1-9]|10)\b\s*(posts?|reels?|carousels?)/i);
      const text = `${task.title} ${task.description ?? ""}`.toLowerCase();
      const platform = text.includes("tiktok") && !text.includes("instagram")
        ? "tiktok"
        : text.includes("instagram") && !text.includes("tiktok")
          ? "instagram"
          : "both";
      return {
        count: countMatch ? Number(countMatch[1]) : 3,
        platform,
        topic: `${topic}${revision}`,
      };
    }
    case "newsletter_issue":
      return { issue_theme: `${task.title}${revision}`, must_include: task.description ?? "" };
    case "blog_article":
      return { topic: `${topic}${revision}` };
    case "landing_page":
      return { page_goal: `${task.title}${revision}`, offer: task.description ?? "" };
    default:
      return { topic: `${topic}${revision}` };
  }
}

/**
 * Free-text prompt for a custom-agent run (the agent's own system prompt lives
 * in its stored `instructions`; this is only the per-run request). On a re-run
 * the client's feedback is appended so the agent refines rather than repeats.
 */
function buildCustomAgentPrompt(task: ClientTask, adjustmentFeedback?: string): string {
  const base =
    task.description && task.description.trim()
      ? `${task.title}\n\n${task.description.trim()}`
      : task.title;
  const revision = adjustmentFeedback
    ? `\n\nREVISION REQUEST — a previous version was reviewed by the client; incorporate every point: "${adjustmentFeedback}"`
    : "";
  return `${base}${revision}`;
}

/* ── Core single-task runner ─────────────────────────────────────── */

/**
 * Executes a single karos_managed task:
 * - Content tasks that map to a managed product (the ecosystem agents) are
 *   dispatched to the agent service; the signed webhook injects the deliverable
 *   into the task ticket (review_pending) when the run lands — see task-sync.ts.
 * - Everything else (or when the service isn't configured) generates in-process
 *   via Claude (Flow A: content; Flow B: email/publish draft).
 * - On a re-run (adjustment feedback present), feeds the executor both the
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

  // ── Path 0: dispatch to a bound custom agent (git-imported lab product) ──
  // Custom agents are the dynamic half of the roster — checked before the
  // managed products so an explicit assignment always wins. Runs through the
  // agent service's generic `custom` task type via submitCustomAgentJob; the
  // webhook resolves the task by its externalJobId / karos_task_id echo, same
  // as a managed run. Same executing/refund contract on failure.
  if (taskType === "content_generation" && isAgentServiceConfigured()) {
    const customAgentId = resolveTaskCustomAgentId(task);
    if (customAgentId) {
      // Re-verify the client still has this agent allowlisted — it may have
      // been revoked between task creation and execution.
      const agent: CustomAgent | null = (client.customAgentIds ?? []).includes(customAgentId)
        ? await getCustomAgent(customAgentId)
        : null;
      if (!agent || !agent.enabled) {
        await updateClientTask(taskId, {
          status: "pending",
          metadata: {
            ...(task.metadata ?? {}),
            executing: false,
            externalJobId: null,
            executionError:
              "The assigned agent is no longer available for this client. Reassign the task or ask your Karos team.",
          },
          updatedAt: Date.now(),
        });
        await refundJobCharge(
          taskId,
          `Auto-refund · agent unavailable · ${task.title.slice(0, 80)}`,
        ).catch((e) => console.error(`[engine] custom-agent refund failed for ${taskId}:`, e));
        revalidatePath("/tasks");
        revalidatePath(`/clients/${clientId}`);
        return;
      }
      const result = await submitCustomAgentJob(TASK_ENGINE_ACTOR, {
        agentId: agent.id,
        clientId,
        prompt: buildCustomAgentPrompt(task, adjustmentFeedback),
        taskId,
      }).catch((e) => ({ jobId: undefined, error: e instanceof Error ? e.message : "submit failed" }));

      if (result.jobId && !result.error) {
        await updateClientTask(taskId, {
          metadata: {
            ...(task.metadata ?? {}),
            executing: true,
            type: "content_generation",
            customAgentId: agent.id,
            agentName: agent.name,
            externalJobId: result.jobId,
            executionError: null,
          },
          updatedAt: Date.now(),
        });
      } else {
        await updateClientTask(taskId, {
          status: "pending",
          metadata: {
            ...(task.metadata ?? {}),
            executing: false,
            externalJobId: null,
            executionError: `The ${agent.name} agent couldn't be reached — please try again. (${result.error ?? "submission failed"})`,
          },
          updatedAt: Date.now(),
        });
        await refundJobCharge(
          taskId,
          `Auto-refund · agent dispatch failed · ${task.title.slice(0, 80)}`,
        ).catch((e) => console.error(`[engine] custom-agent dispatch refund failed for ${taskId}:`, e));
      }
      revalidatePath("/tasks");
      revalidatePath(`/clients/${clientId}`);
      return;
    }
  }

  // ── Path 1: dispatch to the mapped ecosystem agent (managed product) ──
  // The task stays in_progress + executing; the webhook (or the agent-service
  // reconciler on a missed webhook) resolves it. On submission failure the
  // task is released and the charge refunded — NOT silently downgraded to the
  // in-process engine: the client paid the product rate for a product run,
  // and a retry is one click away.
  if (taskType === "content_generation" && isAgentServiceConfigured()) {
    const product = resolveTaskProduct(task);
    if (product) {
      const result = await submitManagedJob(TASK_ENGINE_ACTOR, {
        clientId,
        taskType: product.taskType,
        brief: buildTaskBrief(task, product, adjustmentFeedback),
        taskId,
      }).catch((e) => ({ jobId: undefined, error: e instanceof Error ? e.message : "submit failed" }));

      if (result.jobId && !result.error) {
        await updateClientTask(taskId, {
          metadata: {
            ...(task.metadata ?? {}),
            executing: true,
            type: "content_generation",
            productType: product.taskType,
            agentName: product.name,
            externalJobId: result.jobId,
            executionError: null,
          },
          updatedAt: Date.now(),
        });
      } else {
        await updateClientTask(taskId, {
          status: "pending",
          metadata: {
            ...(task.metadata ?? {}),
            executing: false,
            externalJobId: null,
            executionError: `The ${product.name} agent couldn't be reached — please try again. (${result.error ?? "submission failed"})`,
          },
          updatedAt: Date.now(),
        });
        await refundJobCharge(
          taskId,
          `Auto-refund · agent dispatch failed · ${task.title.slice(0, 80)}`,
        ).catch((e) => console.error(`[engine] dispatch-failure refund failed for ${taskId}:`, e));
      }
      revalidatePath("/tasks");
      revalidatePath(`/clients/${clientId}`);
      return;
    }
  }

  try {
    // If this task targets a LinkedIn employee seat, load that seat and
    // inject the employee's resume/background into the generation prompt so
    // the model writes in their authentic personal voice.
    let employeeAdvocacy: EmployeeAdvocacyProfile | undefined = undefined;
    const seatId = task.metadata?.seatId as string | undefined;
    if (seatId) {
      const seats = await listEmployeeSeats(clientId);
      const seat = seats.find((s) => s.id === seatId);
      if (seat && seat.status === "active") {
        employeeAdvocacy = {
          name: seat.employeeName,
          resumeText: seat.backgroundContext ?? null,
          resumeUrl: seat.resumeUrl ?? null,
        };
      }
    }

    // Self-improving loop (Phase 1): pull this client's measured top performers
    // from the analytics collection and inject them as "successful past content
    // examples" so new content emulates proven patterns. Non-fatal: no analytics
    // (or a read failure) simply omits the block.
    let topPerformerExamples: string | undefined;
    try {
      const benchmarks = await getClientPerformanceBenchmarks(clientId, 3);
      if (benchmarks.top.length > 0) {
        topPerformerExamples = benchmarks.top
          .map(
            (r) =>
              `- [engagement ${r.engagementScore.toFixed(1)}/100 · ${r.platform}${r.assetType ? ` · ${r.assetType}` : ""}] "${r.assetLabel ?? r.assetId}" (${(r.metrics.engagementRate * 100).toFixed(1)}% engagement, ${r.metrics.impressions.toLocaleString()} impressions)`,
          )
          .join("\n");
      }
    } catch {
      /* analytics unavailable — generate without the winners block */
    }

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
        employeeAdvocacy,
        topPerformerExamples,
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
        agentName: (task.metadata?.agentName as string | undefined) ?? "Karos AI",
        externalJobId: null,
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
        externalJobId: null,
        executionError: message,
      },
      updatedAt: Date.now(),
    });
    // Mirror the external failure path: the client paid upfront and got no
    // deliverable — refund (idempotent; no-op for staff-triggered runs).
    await refundJobCharge(
      taskId,
      `Auto-refund · execution failed · ${task.title.slice(0, 80)}`,
    ).catch((e) => console.error(`[engine] failure refund failed for ${taskId}:`, e));
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
