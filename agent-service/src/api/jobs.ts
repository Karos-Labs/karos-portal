import type { FastifyInstance } from "fastify";
import { createJobRecord, type ServerDeps } from "../server.js";
import { publicView } from "../state/jobs-store.js";
import { isTerminal } from "../state/machine.js";
import { LocalArtifactStore } from "../storage/local.js";

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
