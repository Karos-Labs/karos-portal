import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerDeps } from "../src/server.js";
import { buildJobSpec } from "../src/queue/worker.js";
import { buildSpecEnv, decodeJobSpecRef } from "../src/exec/executor.js";
import { fetchJobSpec } from "../runner/src/spec-ref.js";
import type { ServiceConfig } from "../src/config.js";
import type { JobRecord } from "../src/types.js";

/**
 * Reproduces the real 422 bug (job oBxwG7ob5Sgh4Pun0NNp / X Agent spec
 * huMsrTKukcdqjz5sU7cX): a hand-authored dynamic-agent spec whose 6 steps run
 * near the schema's own 20,000-char prompt ceiling serializes to ~116 KiB —
 * ~4x over the Cloud Run env-var budget that used to reject it at submit
 * time. This suite proves the whole pipeline now carries a spec that size
 * end to end: POST /v1/jobs accepts it, the transport layer picks the
 * fetch-by-reference path instead of inlining it, and a runner-side HTTP
 * fetch against a REAL running server retrieves the exact same JobSpec the
 * inline path would have produced.
 */

function baseConfig(port: number): ServiceConfig {
  return {
    port,
    redisUrl: "redis://localhost:6379",
    authTokens: ["test-token"],
    webhookSecret: "test-secret",
    internalBaseUrl: `http://127.0.0.1:${port}`,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    artifactStore: "local",
    artifactsDir: "/tmp/artifacts",
    executor: "docker",
    runnerImage: "karos-agent-runner:test",
    defaultTimeoutMs: 30 * 60 * 1000,
    maxAttempts: 2,
    retryDelayMs: 5000,
    jobTtlSeconds: 3600,
    workerConcurrency: 1,
    allowInsecureCallbacks: true,
  };
}

/** Minimal in-memory JobsStore stand-in — only .create/.get are exercised by this path. */
function fakeStore() {
  const byId = new Map<string, JobRecord>();
  return {
    records: byId,
    store: {
      create: async (record: JobRecord) => {
        byId.set(record.id, record);
      },
      get: async (id: string) => byId.get(id) ?? null,
    } as unknown as ServerDeps["store"],
  };
}

/** A step prompt near the AJV schema's own 20,000-char ceiling — matches the real X Agent's step sizes. */
function bigPrompt(label: string): string {
  return `${label}: ${"Follow the brand voice and compliance rules exactly. ".repeat(340)}`.slice(0, 19_800);
}

/** Shaped like the real failing spec: 6 steps, each with a near-max prompt. */
function oversizedDynamicSpec(): Record<string, unknown> {
  return {
    id: "spec-x-agent",
    name: "X Agent",
    description: "Drafts an X post end to end.",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 5,
    active: true,
    version: 1,
    inputSchema: Array.from({ length: 8 }, (_, i) => ({
      key: `field_${i}`,
      type: "text",
      label: `Field ${i}`,
      required: false,
      order: i,
    })),
    steps: ["subjects", "angles", "draft", "claims", "compliance", "assemble"].map((id, order) => ({
      id,
      type: "ai",
      label: id,
      model: "sonnet",
      prompt: bigPrompt(id),
      order,
    })),
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u-admin",
  };
}

function smallDynamicSpec(): Record<string, unknown> {
  return {
    id: "spec-small",
    name: "Small Agent",
    description: "Short spec.",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 1,
    active: true,
    version: 1,
    inputSchema: [{ key: "topic", type: "text", label: "Topic", required: true, order: 0 }],
    steps: [{ id: "write", type: "ai", label: "Write", model: "sonnet", prompt: "Write about {{inputs.topic}}", order: 0 }],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u-admin",
  };
}

function jobRequestBody(spec: Record<string, unknown>): Record<string, unknown> {
  return {
    task_type: "custom",
    client_id: "client-123",
    callback_url: "https://platform.example.com/api/agent-service/webhook",
    brief: {
      specSnapshot: spec,
      spec_version: spec.version,
      inputs: {},
      agent_key: `dynamic:${spec.id}`,
      label: spec.name,
    },
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("oversized dynamic-agent spec transport (422 regression)", () => {
  it("accepts an ~116 KiB spec at submit time instead of rejecting it as too large", async () => {
    const { store } = fakeStore();
    const deps: ServerDeps = {
      config: baseConfig(0),
      store,
      artifactStore: {} as ServerDeps["artifactStore"],
      enqueue: async () => {},
      removeQueued: async () => false,
      finalize: async () => {},
    };
    app = await buildServer(deps);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const body = jobRequestBody(oversizedDynamicSpec());
    const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    expect(bodyBytes).toBeGreaterThan(100 * 1024); // sanity: this really is the ~116 KiB shape

    const res = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(202);
    const json = (await res.json()) as { job_id: string };
    expect(json.job_id).toBeTruthy();
  });

  it("chooses JOB_SPEC_REF_B64 for the oversized spec and JOB_SPEC_B64 for a normal one", () => {
    const config = baseConfig(8080);
    const bigRecord: JobRecord = {
      id: "job-big",
      status: "queued",
      request: jobRequestBody(oversizedDynamicSpec()) as unknown as JobRecord["request"],
      attempt: 1,
      maxAttempts: 2,
      createdAt: Date.now(),
      artifacts: [],
      runnerToken: "runner-token-big",
    };
    const smallRecord: JobRecord = {
      ...bigRecord,
      id: "job-small",
      request: jobRequestBody(smallDynamicSpec()) as unknown as JobRecord["request"],
      runnerToken: "runner-token-small",
    };

    const bigEnv = buildSpecEnv(buildJobSpec(config, bigRecord));
    const smallEnv = buildSpecEnv(buildJobSpec(config, smallRecord));

    expect(bigEnv.JOB_SPEC_B64).toBeUndefined();
    expect(bigEnv.JOB_SPEC_REF_B64).toBeDefined();

    expect(smallEnv.JOB_SPEC_REF_B64).toBeUndefined();
    expect(smallEnv.JOB_SPEC_B64).toBeDefined();
  });

  it("a runner given only the ref pointer fetches the exact same JobSpec over real HTTP", async () => {
    const { store, records } = fakeStore();
    const config = baseConfig(0);
    const deps: ServerDeps = {
      config,
      store,
      artifactStore: {} as ServerDeps["artifactStore"],
      enqueue: async () => {},
      removeQueued: async () => false,
      finalize: async () => {},
    };
    app = await buildServer(deps);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // The server was built with a "port 0" placeholder internalBaseUrl; patch
    // deps.config in place to the real bound address so the /internal/spec
    // route (which reads deps.config at request time) reports the same
    // callbackBaseUrl this test computes for its own expectation.
    deps.config = { ...config, internalBaseUrl: `http://127.0.0.1:${port}` };
    const runtimeConfig = deps.config;

    const record: JobRecord = {
      id: "job-e2e-big",
      status: "queued",
      request: jobRequestBody(oversizedDynamicSpec()) as unknown as JobRecord["request"],
      attempt: 1,
      maxAttempts: 2,
      createdAt: Date.now(),
      artifacts: [],
      runnerToken: "runner-token-e2e",
    };
    records.set(record.id, record);

    const expectedSpec = buildJobSpec(runtimeConfig, record);
    const env = buildSpecEnv(expectedSpec);
    expect(env.JOB_SPEC_REF_B64).toBeDefined();
    expect(env.JOB_SPEC_B64).toBeUndefined();

    const ref = decodeJobSpecRef(env.JOB_SPEC_REF_B64!);
    expect(ref).toEqual({ jobId: record.id, callbackBaseUrl: runtimeConfig.internalBaseUrl, runnerToken: record.runnerToken });

    const fetchedSpec = await fetchJobSpec(ref);
    expect(fetchedSpec).toEqual(expectedSpec);

    // Wrong runner token must not be able to read the spec.
    await expect(fetchJobSpec({ ...ref, runnerToken: "wrong-token" })).rejects.toThrow(/401/);
  });
});
