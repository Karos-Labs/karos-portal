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
import { resolveTaskConfig } from "./task-types.js";
import { validateJobRequest } from "./schemas/validate.js";
import { isDynamicAgentBrief } from "./dynamic-types.js";

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
// A checkpoint only needs to carry enough of the output tree to skip
// redoing finished work on retry — a small slice of the client-artifact
// budget above, not a full mirror of it.
export const MAX_CHECKPOINT_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * A broad sanity/DoS ceiling on the submitted brief, independent of transport.
 * This is NOT the Cloud Run env-var budget any more — a spec too big for one
 * env var (JOB_SPEC_B64) now travels via a fetched reference instead of being
 * inlined (see exec/executor.ts's buildSpecEnv / INLINE_SPEC_MAX_BYTES), so
 * rejecting here no longer needs to track that limit. What's left is just
 * "absurdly large", loosely under the schema's own worst case (40 steps at
 * the 20,000-char prompt ceiling plus 40 inputSchema items) with headroom,
 * and well under the server's own 5 MiB body limit.
 */
export const MAX_JOB_SPEC_TOTAL_BYTES = 2 * 1024 * 1024;

function estimatedSpecBytes(deps: ServerDeps, request: JobRecord["request"]): number {
  const worstCase = {
    jobId: "00000000-0000-0000-0000-000000000000",
    taskType: request.task_type,
    clientId: request.client_id,
    clientSlug: request.client_slug ?? "",
    brief: request.brief,
    contextFiles: request.context_files ?? [],
    agentVersion: request.agent_version ?? "",
    timeoutMs: 3_600_000,
    callbackBaseUrl: deps.config.internalBaseUrl,
    runnerToken: "0".repeat(64),
    attempt: deps.config.maxAttempts,
    maxAttempts: deps.config.maxAttempts,
  };
  // base64 inflates 3 bytes → 4 chars.
  return Math.ceil(Buffer.byteLength(JSON.stringify(worstCase), "utf8") / 3) * 4;
}

export function createJobRecord(deps: ServerDeps, body: unknown): { record: JobRecord } | { errors: string[] } {
  const validation = validateJobRequest(body, {
    allowInsecureCallbacks: deps.config.allowInsecureCallbacks,
  });
  if (!validation.ok) return { errors: validation.errors };
  const request = validation.request;
  // Resolves the per-job config now so malformed custom briefs (bad skill
  // paths) are rejected at submit time instead of failing inside the runner.
  //
  // A Dynamic Agent Studio brief (specSnapshot present) carries no
  // entry_skill_dir BY DESIGN — the generic engine runs the frozen snapshot's
  // own steps, not a repo skill path — so resolveTaskConfig's hardcoded-skill
  // validation (entry_skill_dir/skill_roots/instructions/prompt) does not
  // apply and must be skipped. isDynamicAgentBrief() is the single routing
  // predicate shared with custom.json's root if/then/else and the early
  // branch in runner/src/main.ts; keep all three agreeing rather than
  // re-deriving the check here.
  if (request.task_type !== "custom" || !isDynamicAgentBrief(request.brief)) {
    try {
      resolveTaskConfig(request.task_type, request.brief);
    } catch (err) {
      return { errors: [`/brief ${err instanceof Error ? err.message : String(err)}`] };
    }
  }
  const specBytes = estimatedSpecBytes(deps, request);
  if (specBytes > MAX_JOB_SPEC_TOTAL_BYTES) {
    return {
      errors: [
        `job spec too large (~${Math.ceil(specBytes / 1024)} KiB; max ${MAX_JOB_SPEC_TOTAL_BYTES / 1024} KiB) — ` +
          "trim the brief (instructions/notes) or attach fewer context files",
      ],
    };
  }
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
