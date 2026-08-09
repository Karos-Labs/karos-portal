import type { FastifyInstance } from "fastify";
import { createJobRecord, type ServerDeps } from "../server.js";
import { JobNotFound, publicView } from "../state/jobs-store.js";
import { isTerminal } from "../state/machine.js";
import { LocalArtifactStore } from "../storage/local.js";
import type { JobRecord } from "../types.js";

/**
 * Pure decision + reshape for POST /v1/jobs/:id/retry, kept separate from the
 * route so it's unit-testable without a real Redis (same reason
 * createJobRecord lives outside registerJobRoutes). Used twice: once as a
 * pre-flight check for a fast, specific error response, and again inside
 * JobsStore.update's CAS retry loop, where it must be safe to call more than
 * once against whatever the freshest record turns out to be.
 */
export function buildRetriedRecord(
  record: JobRecord,
): { record: JobRecord } | { error: "not_retryable" | "no_checkpoint"; status?: JobRecord["status"] } {
  if (record.status !== "failed" && record.status !== "dead_letter") {
    return { error: "not_retryable", status: record.status };
  }
  if (!record.checkpoint || record.checkpoint.files.length === 0) {
    return { error: "no_checkpoint" };
  }
  const attempt = record.attempt + 1;
  const {
    error: _error,
    deadLetterReason: _reason,
    runnerReport: _report,
    finishedAt: _finishedAt,
    startedAt: _startedAt,
    ...rest
  } = record;
  return {
    record: {
      ...rest,
      status: "queued",
      attempt,
      maxAttempts: Math.max(record.maxAttempts, attempt),
      cancelRequested: false,
      // Reset, not omitted: the failed attempt's own webhook already set
      // this true, and the delivery worker skips any job with it still true
      // (queue/webhooks.ts) — without resetting it, this retry's outcome
      // would never reach the platform.
      webhookDelivered: false,
    },
  };
}

export function registerJobRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/v1/jobs", async (request, reply) => {
    const result = createJobRecord(deps, request.body);
    if ("errors" in result) {
      return reply.code(422).send({ error: "validation_failed", details: result.errors });
    }
    await deps.store.create(result.record);
    try {
      await deps.enqueue(result.record);
    } catch (err) {
      await deps.store.update(result.record.id, (r) => ({
        ...r,
        status: "failed",
        error: `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        finishedAt: Date.now(),
      }));
      return reply.code(503).send({ error: "enqueue_failed" });
    }
    return reply.code(202).send({ job_id: result.record.id });
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (request, reply) => {
    const record = await deps.store.get(request.params.id);
    if (!record) return reply.code(404).send({ error: "not_found" });
    return publicView(record);
  });

  app.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", async (request, reply) => {
    const record = await deps.store.get(request.params.id);
    if (!record) return reply.code(404).send({ error: "not_found" });
    if (isTerminal(record.status)) {
      return reply.code(409).send({ error: "already_terminal", status: record.status });
    }
    if (record.status === "queued") {
      const removed = await deps.removeQueued(record.id);
      if (removed) {
        const updated = await deps.store.applyEvent(record.id, { type: "cancel" });
        await deps.finalize(updated);
        return reply.code(202).send({ status: updated.status });
      }
    }
    const updated = await deps.store.requestCancel(record.id);
    return reply.code(202).send({ status: updated.status, cancel_requested: true });
  });

  // Re-queues the SAME job against its own retained checkpoint (see
  // lifecycle/finalize.ts) instead of starting a fresh one from scratch —
  // the whole point being that a client doesn't pay in tokens twice for the
  // part of a run that already finished. Only failed/dead_letter jobs with
  // an actual checkpoint qualify; a caller with nothing to resume from should
  // submit a normal new job instead.
  app.post<{ Params: { id: string } }>("/v1/jobs/:id/retry", async (request, reply) => {
    const existing = await deps.store.get(request.params.id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const preflight = buildRetriedRecord(existing);
    if ("error" in preflight) {
      return reply.code(409).send(
        preflight.status ? { error: preflight.error, status: preflight.status } : { error: preflight.error },
      );
    }

    let updated: JobRecord;
    try {
      updated = await deps.store.update(existing.id, (r) => {
        // Recomputed against the freshest read, not the pre-flight `existing`
        // — a no-op if something else moved the job on since (e.g. it got
        // cancelled). The caller sees that via the status check just below.
        const result = buildRetriedRecord(r);
        return "record" in result ? result.record : r;
      });
    } catch (err) {
      if (err instanceof JobNotFound) return reply.code(404).send({ error: "not_found" });
      throw err;
    }
    if (updated.status !== "queued") {
      return reply.code(409).send({ error: "not_retryable", status: updated.status });
    }

    try {
      await deps.enqueue(updated);
    } catch (err) {
      await deps.store.update(updated.id, (r) => ({
        ...r,
        status: "failed",
        error: `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        finishedAt: Date.now(),
      }));
      return reply.code(503).send({ error: "enqueue_failed" });
    }
    return reply.code(202).send({ status: updated.status, attempt: updated.attempt });
  });

  app.get<{ Params: { id: string; "*": string } }>("/v1/jobs/:id/artifacts/*", async (request, reply) => {
    const record = await deps.store.get(request.params.id);
    if (!record) return reply.code(404).send({ error: "not_found" });
    const storagePath = decodeURI(request.params["*"]);
    const artifact = record.artifacts.find((a) => a.path === storagePath);
    if (!artifact) return reply.code(404).send({ error: "artifact_not_found" });
    if (!deps.artifactStore.open) {
      return artifact.url ? reply.redirect(artifact.url) : reply.code(404).send({ error: "not_servable" });
    }
    const stream = await deps.artifactStore.open(record.id, storagePath);
    if (artifact.contentType) void reply.header("content-type", artifact.contentType);
    return reply.send(stream);
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id/transcript", async (request, reply) => {
    const record = await deps.store.get(request.params.id);
    if (!record) return reply.code(404).send({ error: "not_found" });
    if (deps.artifactStore instanceof LocalArtifactStore) {
      try {
        const stream = await deps.artifactStore.openTranscript(record.id);
        void reply.header("content-type", "application/x-ndjson");
        return reply.send(stream);
      } catch {
        return reply.code(404).send({ error: "transcript_not_found" });
      }
    }
    if (record.transcriptUrl) return reply.redirect(record.transcriptUrl);
    return reply.code(404).send({ error: "transcript_not_found" });
  });
}
