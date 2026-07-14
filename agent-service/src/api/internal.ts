import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import path from "node:path";
import { MAX_ARTIFACT_TOTAL_BYTES, type ServerDeps } from "../server.js";
import { timingSafeStringEqual } from "../webhooks/sign.js";
import type { JobRecord, RunnerCompleteBody } from "../types.js";

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
        if (request.body.usage) next.usage = request.body.usage;
        return next;
      });
      return reply.code(204).send();
    },
  );
}
