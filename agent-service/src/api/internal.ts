import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import path from "node:path";
import { MAX_ARTIFACT_TOTAL_BYTES, MAX_CHECKPOINT_TOTAL_BYTES, type ServerDeps } from "../server.js";
import { timingSafeStringEqual } from "../webhooks/sign.js";
import { mergeJobUsage } from "../state/usage.js";
import { appendCheckpointFile } from "../state/checkpoint.js";
import { deliverWebhook } from "../webhooks/deliver.js";
import { buildJobSpec } from "../queue/worker.js";
import type { JobRecord, JobStepProgressWebhookPayload, RunnerCompleteBody } from "../types.js";

const CHECKPOINT_PREFIX = "_checkpoint/";

const RUNNER_TOKEN_HEADER = "x-runner-token";

async function authorizeRunner(
  deps: ServerDeps,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<JobRecord | null> {
  const record = await deps.store.get(request.params.id);
  const token = request.headers[RUNNER_TOKEN_HEADER];
  if (!record || typeof token !== "string" || !timingSafeStringEqual(record.runnerToken, token)) {
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return record;
}

function sanitizeRelPath(relPath: string): string | null {
  const normalized = path.posix.normalize(relPath).replace(/^\/+/, "");
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized === "" || normalized === ".") {
    return null;
  }
  return normalized;
}

export function registerInternalRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Fetched only for jobs whose spec was too big to inline as JOB_SPEC_B64
  // (see exec/executor.ts's buildSpecEnv) — those runners start with a small
  // JOB_SPEC_REF_B64 pointer and fetch the real spec here instead. Rebuilt
  // fresh from the stored record rather than cached anywhere; buildJobSpec is
  // the SAME function the worker uses for the inline path, so both transports
  // always produce an identical JobSpec.
  app.get<{ Params: { id: string } }>("/internal/jobs/:id/spec", async (request, reply) => {
    const record = await authorizeRunner(deps, request, reply);
    if (!record) return;
    return reply.send(buildJobSpec(deps.config, record));
  });

  app.post<{ Params: { id: string }; Body: { lines: string } }>(
    "/internal/jobs/:id/transcript",
    {
      schema: {
        body: {
          type: "object",
          required: ["lines"],
          properties: { lines: { type: "string", maxLength: 4 * 1024 * 1024 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const record = await authorizeRunner(deps, request, reply);
      if (!record) return;
      await deps.artifactStore.appendTranscript(record.id, request.body.lines);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/internal/jobs/:id/artifacts", async (request, reply) => {
    const record = await authorizeRunner(deps, request, reply);
    if (!record) return;
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "file_missing" });
    const fields = part.fields as Record<string, { value?: unknown } | undefined>;
    const rawPath = typeof fields.path?.value === "string" ? fields.path.value : part.filename;
    const relPath = sanitizeRelPath(rawPath);
    if (!relPath) return reply.code(400).send({ error: "bad_path" });
    const clientFacing = fields.client_facing?.value === "true";
    const contentType =
      typeof fields.content_type?.value === "string" ? fields.content_type.value : part.mimetype;

    const hash = createHash("sha256");
    let bytes = 0;
    const tee = new PassThrough();
    part.file.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    part.file.pipe(tee);

    const stored = await deps.artifactStore.put(record.id, relPath, tee, contentType);
    if (part.file.truncated) return reply.code(413).send({ error: "artifact_too_large" });

    const totalBytes = (record.artifactBytes ?? 0) + bytes;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      return reply.code(413).send({ error: "artifact_budget_exhausted" });
    }
    await deps.store.update(record.id, (r) => ({
      ...r,
      artifactBytes: (r.artifactBytes ?? 0) + bytes,
      artifacts: [
        ...r.artifacts,
        {
          path: relPath,
          name: path.posix.basename(relPath),
          bytes,
          sha256: hash.digest("hex"),
          contentType,
          clientFacing,
          url: stored.url,
        },
      ],
    }));
    return reply.code(201).send({ stored: relPath });
  });

  // Checkpoint: the output-tree state of a failed-but-retryable attempt, so
  // the next attempt can resume instead of redoing finished work. Wholly
  // replaced per attempt (see fields.attempt below) — only the most recent
  // attempt's files are worth restoring. Read/write both live under
  // /internal (runner-token auth), not the platform-facing /v1/jobs/:id/
  // artifacts route, which only serves paths already in record.artifacts and
  // sits behind the platform's bearer token — neither of which the runner has.
  app.post<{ Params: { id: string } }>("/internal/jobs/:id/checkpoint", async (request, reply) => {
    const record = await authorizeRunner(deps, request, reply);
    if (!record) return;
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "file_missing" });
    const fields = part.fields as Record<string, { value?: unknown } | undefined>;
    const rawPath = typeof fields.path?.value === "string" ? fields.path.value : part.filename;
    const relPath = sanitizeRelPath(rawPath);
    if (!relPath) return reply.code(400).send({ error: "bad_path" });
    const attempt = Number(fields.attempt?.value);
    if (!Number.isInteger(attempt) || attempt < 1) return reply.code(400).send({ error: "bad_attempt" });
    const contentType =
      typeof fields.content_type?.value === "string" ? fields.content_type.value : part.mimetype;

    let bytes = 0;
    const tee = new PassThrough();
    part.file.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    part.file.pipe(tee);

    const stored = await deps.artifactStore.put(record.id, `${CHECKPOINT_PREFIX}${relPath}`, tee, contentType);
    if (part.file.truncated) return reply.code(413).send({ error: "checkpoint_file_too_large" });

    const updated = await deps.store.update(record.id, (r) => ({
      ...r,
      checkpoint: appendCheckpointFile(r.checkpoint, attempt, { path: relPath, url: stored.url, bytes }),
    }));
    if ((updated.checkpoint?.bytes ?? 0) > MAX_CHECKPOINT_TOTAL_BYTES) {
      return reply.code(413).send({ error: "checkpoint_budget_exhausted" });
    }
    return reply.code(201).send({ stored: relPath });
  });

  app.get<{ Params: { id: string } }>("/internal/jobs/:id/checkpoint", async (request, reply) => {
    const record = await authorizeRunner(deps, request, reply);
    if (!record) return;
    if (!record.checkpoint) return reply.send({ files: [] });
    return reply.send({
      attempt: record.checkpoint.attempt,
      files: record.checkpoint.files.map((f) => ({ path: f.path, bytes: f.bytes })),
    });
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/internal/jobs/:id/checkpoint/download",
    async (request, reply) => {
      const record = await authorizeRunner(deps, request, reply);
      if (!record) return;
      const relPath = sanitizeRelPath(request.query.path ?? "");
      const file = relPath ? record.checkpoint?.files.find((f) => f.path === relPath) : undefined;
      if (!relPath || !file) return reply.code(404).send({ error: "checkpoint_file_not_found" });
      if (deps.artifactStore.open) {
        const stream = await deps.artifactStore.open(record.id, `${CHECKPOINT_PREFIX}${relPath}`);
        return reply.send(stream);
      }
      return reply.redirect(file.url);
    },
  );

  // Dynamic Agent Studio only: a best-effort live-progress ping, fired once
  // per step transition. Deliberately NOT the durable BullMQ webhook queue
  // job.completed uses — losing one of these is harmless (the next ping, or
  // the eventual completion webhook, resyncs the Portal), so delivery here is
  // fire-and-forget with no retry.
  app.post<{
    Params: { id: string };
    Body: { step_id: string; step_name?: string; status: "running" | "done" | "failed" };
  }>(
    "/internal/jobs/:id/step-progress",
    {
      schema: {
        body: {
          type: "object",
          required: ["step_id", "status"],
          additionalProperties: false,
          properties: {
            step_id: { type: "string", maxLength: 200 },
            step_name: { type: "string", maxLength: 200 },
            status: { type: "string", enum: ["running", "done", "failed"] },
          },
        },
      },
    },
    async (request, reply) => {
      const record = await authorizeRunner(deps, request, reply);
      if (!record) return;
      const { step_id: stepId, step_name: stepName, status } = request.body;
      const updated = await deps.store.update(record.id, (r) => {
        const alreadyCompleted = r.completedStepIds ?? [];
        const completedStepIds =
          status === "done" && !alreadyCompleted.includes(stepId) ? [...alreadyCompleted, stepId] : alreadyCompleted;
        // A failed step is not "currently running" — leaving currentStepId
        // pinned to it would show that step as active in the Portal's live
        // indicator for the whole retry-backoff window (or forever, on a
        // permanent failure) until the eventual completion webhook clears
        // it. Clear it here instead (omitted, not set to undefined —
        // exactOptionalPropertyTypes forbids the latter): no row is
        // authoritatively "active" until the next "running" ping (this
        // step's retry, or the next step after a permanent failure moves
        // the job on).
        const { currentStepId: _prevId, currentStepName: _prevName, ...rest } = r;
        const nextStepName = stepName ?? r.currentStepName;
        return {
          ...rest,
          completedStepIds,
          ...(status !== "failed" ? { currentStepId: stepId } : {}),
          ...(status !== "failed" && nextStepName ? { currentStepName: nextStepName } : {}),
        };
      });
      const payload: JobStepProgressWebhookPayload = {
        event: "job.step_progress",
        job_id: record.id,
        status: "running",
        client_id: record.request.client_id,
        completed_step_ids: updated.completedStepIds ?? [],
        ...(updated.currentStepId ? { current_step_id: updated.currentStepId } : {}),
        ...(updated.currentStepName ? { current_step_name: updated.currentStepName } : {}),
      };
      void deliverWebhook(deps.config.webhookSecret, record.request.callback_url, payload);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: RunnerCompleteBody }>(
    "/internal/jobs/:id/complete",
    {
      schema: {
        body: {
          type: "object",
          required: ["outcome"],
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: ["done", "failed", "cancelled"] },
            error: { type: "string", maxLength: 20000 },
            transient: { type: "boolean" },
            usage: { type: "object" },
            agentsRepoSha: { type: "string", maxLength: 64 },
            model: { type: "string", maxLength: 100 },
            // Dynamic Agent Studio only. PRE-EXISTING BUG, fixed here: this
            // property was never declared, and Fastify's default AJV
            // validator (removeAdditional: true, implied by
            // additionalProperties: false) silently stripped it from every
            // request body before the handler ever saw it — so
            // runnerReport.dynamicRun, and therefore the webhook's
            // dynamic_run field, and therefore Job.dynamicRun/stepBreakdown,
            // has never once reached the Portal for any completed dynamic-
            // agent job. `usage`/`model`/`agentsRepoSha` above worked because
            // they WERE declared; this one just never was.
            dynamicRun: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const record = await authorizeRunner(deps, request, reply);
      if (!record) return;
      await deps.store.update(record.id, (r) => {
        const next: JobRecord = { ...r, runnerReport: request.body };
        if (request.body.agentsRepoSha) next.agentsRepoSha = request.body.agentsRepoSha;
        if (request.body.model) next.model = request.body.model;
        // Accumulate, don't overwrite: a retried job's earlier (failed) attempt
        // already spent real Anthropic tokens, and the webhook only fires once
        // per job (see lifecycle/finalize.ts) — this is the only place that
        // total can be assembled before it goes out.
        const merged = mergeJobUsage(r.usage, request.body.usage);
        if (merged) next.usage = merged;
        return next;
      });
      return reply.code(204).send();
    },
  );
}
