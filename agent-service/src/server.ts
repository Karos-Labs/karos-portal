import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { randomBytes, randomUUID } from "node:crypto";
import type { ServiceConfig } from "./config.js";
import type { JobsStore } from "./state/jobs-store.js";
import type { ArtifactStore } from "./storage/artifact-store.js";
import type { JobRecord } from "./types.js";
import { makeBearerAuth } from "./auth.js";
import { registerJobRoutes } from "./api/jobs.js";
import { registerInternalRoutes } from "./api/internal.js";
import { getTaskTypeConfig } from "./task-types.js";
import { validateJobRequest } from "./schemas/validate.js";

export interface ServerDeps {
  config: ServiceConfig;
  store: JobsStore;
  artifactStore: ArtifactStore;
  enqueue: (record: JobRecord) => Promise<void>;
  /** returns true when the queued entry was removed before a worker picked it up */
  removeQueued: (jobId: string) => Promise<boolean>;
  /** terminal bookkeeping (transcript + webhook) — used by the cancel-while-queued path */
  finalize: (record: JobRecord) => Promise<void>;
}

export const MAX_ARTIFACT_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 500 * 1024 * 1024;

export function createJobRecord(deps: ServerDeps, body: unknown): { record: JobRecord } | { errors: string[] } {
  const validation = validateJobRequest(body, {
    allowInsecureCallbacks: deps.config.allowInsecureCallbacks,
  });
  if (!validation.ok) return { errors: validation.errors };
  const request = validation.request;
  const taskConfig = getTaskTypeConfig(request.task_type);
  const record: JobRecord = {
    id: randomUUID(),
    status: "queued",
    request,
    attempt: 1,
    maxAttempts: deps.config.maxAttempts,
    createdAt: Date.now(),
    artifacts: [],
    runnerToken: randomBytes(32).toString("hex"),
  };
  void taskConfig;
  return { record };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 5 * 1024 * 1024,
  });
  await app.register(multipart, {
    limits: { fileSize: MAX_ARTIFACT_FILE_BYTES, files: 1, fields: 10 },
  });

  app.get("/healthz", async () => ({ ok: true, service: "karos-agent-service" }));

  await app.register(async (authed) => {
    authed.addHook("onRequest", makeBearerAuth(deps.config.authTokens));
    registerJobRoutes(authed, deps);
  });

  await app.register(async (internal) => {
    registerInternalRoutes(internal, deps);
  });

  return app;
}
