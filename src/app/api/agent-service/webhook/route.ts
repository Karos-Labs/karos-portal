import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import {
  claimExternalJobCompletion,
  createAsset,
  getJob,
  getJobByExternalServiceId,
  updateJob,
} from "@/lib/data";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyAgentServiceSignature,
} from "@/lib/agent-service/verify";
import { agentServiceFetchHeaders } from "@/lib/agent-service/client";
import type { AgentServiceArtifact, AgentServiceWebhookPayload } from "@/lib/agent-service/types";
import type { AssetType, ExternalJobArtifact, JobStatus } from "@/lib/types";
import { uploadBytes } from "@/lib/storage";
import { recommendedScheduleFields } from "@/lib/scheduling";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { orderKeyForCreatedAt } from "@/lib/post-chain";
import { reflowClientChain } from "@/lib/chain";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { autoCompleteTasksByTrigger, syncTaskForJobOutcome } from "@/lib/task-sync";
import { logger } from "@/services/logger";

export const maxDuration = 120;

const REHOST_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
const REHOST_TOTAL_LIMIT_BYTES = 150 * 1024 * 1024;
const CONTENT_CHAR_CAP = 100_000;

const STATUS_MAP: Record<AgentServiceWebhookPayload["status"], JobStatus> = {
  done: "review",
  failed: "failed",
  dead_letter: "failed",
  cancelled: "failed",
};

const ASSET_TYPE_MAP = {
  social_post: "social_post",
  newsletter_issue: "email",
  blog_article: "article",
  landing_page: "note",
  custom: "note",
} as const satisfies Record<
  "social_post" | "newsletter_issue" | "blog_article" | "landing_page" | "custom",
  AssetType
>;

/**
 * Custom agents can produce anything, so we infer the library bucket from the
 * deliverables: images ⇒ a schedulable social post (so it auto-places on the
 * calendar), a long-form .md/.html ⇒ an article, everything else ⇒ a note.
 */
function inferAssetType(hasImages: boolean, primaryTextName?: string): AssetType {
  if (hasImages) return "social_post";
  if (primaryTextName && /\.(md|html?)$/i.test(primaryTextName)) return "article";
  return "note";
}

// Asset types a custom job may request via metadata.asset_type (whitelist — a
// hint is only honored if it's one of these, otherwise we fall back to "note").
const VALID_HINT_TYPES = new Set<AssetType>(["social_post", "instagram_post", "email", "article", "note"]);

const TEXT_EXTENSIONS = [".md", ".html", ".txt"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

/**
 * Structural validation of the (signature-verified) webhook body. The HMAC proves the
 * sender, not the shape — a malformed-but-signed payload previously reached `.map`/`.reduce`
 * on `artifacts`/`usage.models` and could throw mid-handler after the job was claimed.
 * Required fields are the ones the handler routes on; secondary fields stay lenient (with
 * defaults) so a valid delivery is never rejected over an optional field.
 */
const artifactSchema = z.object({
  name: z.string(),
  path: z.string().default(""),
  bytes: z.number().default(0),
  sha256: z.string().default(""),
  content_type: z.string().optional(),
  client_facing: z.boolean().default(false),
  url: z.string(),
});
const usageSchema = z.object({
  totalCostUsd: z.number().optional(),
  numTurns: z.number().optional(),
  models: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number().default(0),
        outputTokens: z.number().default(0),
        cacheReadInputTokens: z.number().default(0),
        cacheCreationInputTokens: z.number().default(0),
        costUsd: z.number().optional(),
      }),
    )
    .default({}),
});
const webhookPayloadSchema = z.object({
  event: z.literal("job.completed"),
  job_id: z.string().min(1),
  status: z.enum(["done", "failed", "cancelled", "dead_letter"]),
  task_type: z.enum(["social_post", "newsletter_issue", "blog_article", "landing_page", "custom"]),
  client_id: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  artifacts: z.array(artifactSchema).default([]),
  usage: usageSchema.optional(),
  agents_repo_sha: z.string().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  transcript_url: z.string().optional(),
  attempt: z.number().default(0),
});

function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/**
 * Agent-service webhook receiver. Verifies the HMAC signature (fail-closed:
 * without AGENT_WEBHOOK_SECRET every request is rejected), updates the
 * mirrored `jobs` doc, re-hosts client-facing artifacts into the platform's
 * own storage, creates a reviewable asset, and records token usage/cost.
 */
export async function POST(req: NextRequest) {
  const secretsEnv = process.env.AGENT_WEBHOOK_SECRET;
  if (!secretsEnv) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  const rawBody = await req.text();
  const valid = verifyAgentServiceSignature({
    secrets: secretsEnv.split(",").map((s) => s.trim()).filter(Boolean),
    signatureHeader: req.headers.get(SIGNATURE_HEADER),
    timestampHeader: req.headers.get(TIMESTAMP_HEADER),
    rawBody,
  });
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = webhookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Unsupported payload", detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  let job = await getJobByExternalServiceId(payload.job_id);
  if (!job) {
    // Submission race: the action may not have persisted external.serviceJobId
    // yet — fall back to the platform job id echoed through metadata.
    const platformJobId = payload.metadata?.platform_job_id;
    if (platformJobId) {
      const candidate = await getJob(platformJobId);
      if (
        candidate &&
        candidate.clientId === payload.client_id &&
        (!candidate.external || candidate.external.serviceJobId === payload.job_id)
      ) {
        job = {
          ...candidate,
          external: candidate.external ?? { serviceJobId: payload.job_id, taskType: payload.task_type },
        };
      }
    }
  }
  if (!job || !job.external) {
    // Unknown job — 404 so the service's delivery queue retries: the write
    // race window closes long before the retry schedule runs out.
    return NextResponse.json({ error: "No matching platform job" }, { status: 404 });
  }

  const status = STATUS_MAP[payload.status] ?? "failed";

  // Client-charged runs (custom agents fired by CLIENT_USERs) get their
  // credits back when the run dies without deliverables. This MUST happen
  // before the claim below: the claim is single-use, so a refund attempted
  // after it has no retry if the write fails or the instance dies in between.
  // Failing the delivery instead (503) keeps it in the service's retry queue,
  // and the deterministic refund_<chargeEntryId> ledger id makes redelivery
  // safe after a half-applied attempt. No-op for staff-fired runs (never
  // charged) and for already-refunded redeliveries.
  let refund: { refunded: boolean; amount?: number } = { refunded: false };
  if (payload.status !== "done") {
    try {
      refund = await refundJobCharge(
        job.id,
        `Auto-refund · run ${payload.status} · ${job.agentName}`.slice(0, 120),
      );
    } catch {
      return NextResponse.json({ error: "Refund write failed — retry delivery" }, { status: 503 });
    }
  }

  // Atomic claim — makes redelivery (sender retries on timeout) idempotent:
  // exactly one delivery flips the job out of queued/running and runs the
  // side effects (asset creation, usage logging).
  const claimed = await claimExternalJobCompletion(job.id, status);
  if (!claimed) {
    return NextResponse.json({ ok: true, skipped: true, reason: "Already processed" });
  }
  const now = Date.now();
  const events = [...job.events];

  const artifacts: ExternalJobArtifact[] = [];
  const assetIds: string[] = [...job.assetIds];
  let rehostedTotal = 0;
  // Captured for the Task Map sync below (the run may have been dispatched by
  // a board task — its ticket gets the deliverable for client preview).
  let createdAssetId: string | null = null;
  let taskArtifactContent = "";
  let taskArtifactImage: string | null = null;

  if (payload.status === "done") {
    let primaryText: { artifact: AgentServiceArtifact; content: string } | null = null;
    // A post is a multi-slide carousel: collect EVERY image, not just the
    // first. Keyed by artifact name so we can restore slide order (slide-2
    // before slide-10) regardless of artifact arrival order.
    const imageEntries: { name: string; url: string }[] = [];

    for (const artifact of payload.artifacts) {
      const entry: ExternalJobArtifact = {
        name: artifact.name,
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        clientFacing: artifact.client_facing,
        ...(artifact.content_type ? { contentType: artifact.content_type } : {}),
        url: artifact.url,
      };
      const withinBudget =
        artifact.bytes <= REHOST_FILE_LIMIT_BYTES &&
        rehostedTotal + artifact.bytes <= REHOST_TOTAL_LIMIT_BYTES;
      if (artifact.client_facing && artifact.url && withinBudget) {
        try {
          const res = await fetch(artifact.url, {
            headers: agentServiceFetchHeaders(artifact.url),
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) {
            events.push({
              at: Date.now(),
              level: "error",
              message: `Could not re-host ${artifact.name} (HTTP ${res.status}) - keeping service URL`,
            });
          }
          if (res.ok) {
            const bytes = Buffer.from(await res.arrayBuffer());
            rehostedTotal += bytes.length;
            const hosted = await uploadBytes({
              bytes,
              path: `agent-service/${job.id}/${artifact.sha256.slice(0, 12)}-${artifact.name}`,
              contentType: artifact.content_type ?? "application/octet-stream",
            });
            entry.url = hosted.url;
            const ext = extension(artifact.name);
            if (TEXT_EXTENSIONS.includes(ext)) {
              const content = bytes.toString("utf8");
              if (!primaryText || content.length > primaryText.content.length) {
                primaryText = { artifact, content };
              }
            } else if (IMAGE_EXTENSIONS.includes(ext)) {
              imageEntries.push({ name: artifact.name, url: hosted.url });
            }
          }
        } catch {
          events.push({ at: Date.now(), level: "error", message: `Could not re-host ${artifact.name}` });
        }
      }
      artifacts.push(entry);
    }

    // Natural-sort by filename so slide-2 precedes slide-10, then expose each
    // image as a carousel slide the asset card can page through.
    const orderedImageUrls = imageEntries
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((e) => e.url);
    const slides =
      orderedImageUrls.length > 1
        ? orderedImageUrls.map((url) => ({ imageUrl: url }))
        : undefined;

    const clientFacingCount = artifacts.filter((a) => a.clientFacing).length;
    if (clientFacingCount > 0) {
      // Custom agents (e.g. the LinkedIn generators) produce any asset shape, so
      // "note" is the safe default — but the submitter can hint the real type +
      // platform through metadata, which lands the draft as a schedulable post
      // with the right recommended window instead of a slot-less library note.
      const hintedType = payload.metadata?.asset_type as AssetType | undefined;
      const assetType =
        payload.task_type === "custom" && hintedType && VALID_HINT_TYPES.has(hintedType)
          ? hintedType
          : (ASSET_TYPE_MAP[payload.task_type] ?? "note");
      const platform = payload.metadata?.platform || undefined;
      // job.title is `${job.agentName} — ${clientName}` (submit-managed.ts /
      // custom-agent-actions.ts). Strip only that exact appended " — <client>"
      // suffix — never a blind split on " — " (agent/client names may contain
      // legitimate em-dashes). The job doc keeps its full title.
      const clientSuffix = " — ";
      const assetTitle =
        job.agentName && job.title.startsWith(job.agentName + clientSuffix)
          ? job.agentName
          : job.title;
      // Only real catalog products get a template chip; "custom" runs have no
      // managed product (getManagedProduct would fall back to the first one).
      const managedProduct = MANAGED_PRODUCTS.find((p) => p.taskType === payload.task_type);
      const assetId = await createAsset({
        clientId: job.clientId,
        jobId: job.id,
        agentId: "agent-service",
        type: assetType,
        title: assetTitle,
        content: primaryText ? primaryText.content.slice(0, CONTENT_CHAR_CAP) : "",
        meta: {
          taskType: payload.task_type,
          agentsRepoSha: payload.agents_repo_sha,
          artifacts: artifacts.filter((a) => a.clientFacing),
          ...(slides ? { slides } : {}),
        },
        imageUrl: orderedImageUrls[0] ?? null,
        ...(platform ? { channels: [platform] } : {}),
        status: "draft",
        ...(managedProduct
          ? { templateKey: payload.task_type, templateName: managedProduct.name }
          : {}),
        orderKey: orderKeyForCreatedAt(now, job.id),
        ...recommendedScheduleFields(assetType, 0, platform),
        createdBy: "agent-service",
        createdAt: now,
        updatedAt: now,
      });
      assetIds.push(assetId);
      createdAssetId = assetId;
      // Auto-assign the new post its one-per-day chain date. Best-effort: the
      // job is already claimed (single delivery), so a reflow failure must not
      // fail the webhook — it self-heals on the next import/webhook/staff reflow.
      await reflowClientChain(job.clientId).catch(() =>
        events.push({
          at: Date.now(),
          level: "error",
          message: "Calendar reflow failed - run the staff reflow action",
        }),
      );
    }
    taskArtifactContent = primaryText ? primaryText.content.slice(0, CONTENT_CHAR_CAP) : "";
    taskArtifactImage = orderedImageUrls[0] ?? null;
    events.push({
      at: now,
      level: "success",
      message: `Agent run complete - ${clientFacingCount} client-facing deliverable(s), attempt ${payload.attempt}`,
    });
  } else {
    events.push({
      at: now,
      level: "error",
      message:
        payload.status === "cancelled"
          ? "Job cancelled"
          : `Job ${payload.status.replace("_", " ")}: ${payload.error ?? "unknown error"}`,
    });
    if (refund.refunded) {
      events.push({
        at: now,
        level: "info",
        message: `Refunded ${refund.amount} credit${refund.amount === 1 ? "" : "s"} for the failed run`,
      });
    }
  }

  const inputTokens = Object.values(payload.usage?.models ?? {}).reduce((s, m) => s + m.inputTokens, 0);
  const outputTokens = Object.values(payload.usage?.models ?? {}).reduce((s, m) => s + m.outputTokens, 0);

  await updateJob(job.id, {
    status,
    assetIds,
    events,
    error: payload.status === "done" ? null : (payload.error ?? payload.status),
    external: {
      ...job.external,
      ...(payload.agents_repo_sha ? { agentsRepoSha: payload.agents_repo_sha } : {}),
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.usage?.totalCostUsd !== undefined ? { totalCostUsd: payload.usage.totalCostUsd } : {}),
      inputTokens,
      outputTokens,
      artifacts,
      ...(payload.transcript_url ? { transcriptUrl: payload.transcript_url } : {}),
    },
    updatedAt: now,
  });

  // ── Task Map sync ──
  // 1. A run dispatched BY a board task lands its deliverable on the ticket
  //    for client preview + approve/re-run; failures release the task and
  //    refund the execution charge. Matched by metadata.externalJobId with
  //    the karos_task_id echo as the race-proof fallback.
  // 2. INDEPENDENT successful runs (not dispatched by a task) auto-complete
  //    pending "watch" tasks whose completionTrigger matches this product,
  //    scoped to the run's platform — a task-dispatched run must not close
  //    sibling tasks of the same product, and an Instagram run must not close
  //    a TikTok watcher.
  // Best-effort: the job is already claimed, so a sync error must not fail the
  // delivery (redelivery would be skipped as already-processed anyway).
  try {
    const dispatchingTaskId = payload.metadata?.karos_task_id;
    if (payload.status === "done") {
      const taskSynced = await syncTaskForJobOutcome(
        job.id,
        job.clientId,
        {
          ok: true,
          assetId: createdAssetId,
          content: taskArtifactContent,
          imageUrl: taskArtifactImage,
        },
        dispatchingTaskId,
      );
      if (!taskSynced && !dispatchingTaskId) {
        await autoCompleteTasksByTrigger(
          job.clientId,
          `product_run:${payload.task_type}`,
          `Auto-completed - ${job.agentName} run delivered`,
          { platform: typeof job.input?.platform === "string" ? job.input.platform : undefined },
        );
      }
    } else {
      await syncTaskForJobOutcome(
        job.id,
        job.clientId,
        {
          ok: false,
          error: payload.error ?? `Agent run ${payload.status.replace("_", " ")}`,
        },
        dispatchingTaskId,
      );
    }
  } catch (e) {
    console.error("[webhook] task sync failed:", e);
  }

  const jobId = job.id;
  const clientId = job.clientId;
  const agentName = job.agentName;
  after(() => {
    for (const [modelName, usage] of Object.entries(payload.usage?.models ?? {})) {
      logger.logUsage({
        clientId,
        agentId: "agent-service",
        agentName,
        modelName,
        operation: "managed_job",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        jobId,
      });
    }
  });

  return NextResponse.json({ ok: true, job_id: job.id, status });
}

// Health check for wiring the callback URL.
export async function GET() {
  return NextResponse.json({ ok: true, service: "agent-service-webhook" });
}
