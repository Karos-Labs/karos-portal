import { NextRequest, NextResponse } from "next/server";
import { createAsset, getJobByExternalServiceId, updateJob } from "@/lib/data";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyAgentServiceSignature,
} from "@/lib/agent-service/verify";
import type { AgentServiceArtifact, AgentServiceWebhookPayload } from "@/lib/agent-service/types";
import type { AssetType, ExternalJobArtifact, JobStatus, ManagedTaskType } from "@/lib/types";
import { uploadBytes } from "@/lib/storage";
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

const ASSET_TYPE_MAP: Record<ManagedTaskType, AssetType> = {
  social_post: "social_post",
  newsletter_issue: "email",
  blog_article: "article",
  landing_page: "note",
};

const TEXT_EXTENSIONS = [".md", ".html", ".txt"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

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

  let payload: AgentServiceWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as AgentServiceWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (payload.event !== "job.completed" || !payload.job_id) {
    return NextResponse.json({ error: "Unsupported payload" }, { status: 400 });
  }

  const job = await getJobByExternalServiceId(payload.job_id);
  if (!job || !job.external) {
    // Unknown job — acknowledge so the service does not retry forever.
    return NextResponse.json({ ok: true, skipped: true, reason: "No matching platform job" });
  }
  if (job.status !== "queued" && job.status !== "running") {
    return NextResponse.json({ ok: true, skipped: true, reason: "Already processed" });
  }

  const status = STATUS_MAP[payload.status] ?? "failed";
  const now = Date.now();
  const events = [...job.events];

  const artifacts: ExternalJobArtifact[] = [];
  const assetIds: string[] = [...job.assetIds];
  let rehostedTotal = 0;

  if (payload.status === "done") {
    let primaryText: { artifact: AgentServiceArtifact; content: string } | null = null;
    let primaryImageUrl: string | null = null;

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
          const res = await fetch(artifact.url, { signal: AbortSignal.timeout(60_000) });
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
            } else if (IMAGE_EXTENSIONS.includes(ext) && !primaryImageUrl) {
              primaryImageUrl = hosted.url;
            }
          }
        } catch {
          events.push({ at: Date.now(), level: "error", message: `Could not re-host ${artifact.name}` });
        }
      }
      artifacts.push(entry);
    }

    const clientFacingCount = artifacts.filter((a) => a.clientFacing).length;
    if (clientFacingCount > 0) {
      const assetId = await createAsset({
        clientId: job.clientId,
        jobId: job.id,
        agentId: "agent-service",
        type: ASSET_TYPE_MAP[payload.task_type] ?? "note",
        title: job.title,
        content: primaryText ? primaryText.content.slice(0, CONTENT_CHAR_CAP) : "",
        meta: {
          taskType: payload.task_type,
          agentsRepoSha: payload.agents_repo_sha,
          artifacts: artifacts.filter((a) => a.clientFacing),
        },
        imageUrl: primaryImageUrl,
        status: "draft",
        createdBy: "agent-service",
        createdAt: now,
        updatedAt: now,
      });
      assetIds.push(assetId);
    }
    events.push({
      at: now,
      level: "success",
      message: `Agent run complete — ${clientFacingCount} client-facing deliverable(s), attempt ${payload.attempt}`,
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

  for (const [modelName, usage] of Object.entries(payload.usage?.models ?? {})) {
    logger.logUsage({
      clientId: job.clientId,
      agentId: "agent-service",
      agentName: job.agentName,
      modelName,
      operation: "managed_job",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      jobId: job.id,
    });
  }

  return NextResponse.json({ ok: true, job_id: job.id, status });
}

// Health check for wiring the callback URL.
export async function GET() {
  return NextResponse.json({ ok: true, service: "agent-service-webhook" });
}
