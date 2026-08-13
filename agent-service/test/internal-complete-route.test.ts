import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { JobRecord } from "../src/types.js";

/**
 * Regression test for a real production bug: `/internal/jobs/:id/complete`'s
 * Fastify schema had `additionalProperties: false` and never declared
 * `dynamicRun` in its `properties` list. Fastify's default AJV validator
 * compiler (`removeAdditional: true`, implied by `additionalProperties:
 * false`) silently STRIPS any undeclared property from the request body
 * before the handler ever sees it — so `dynamicRun` never reached
 * `record.runnerReport`, never reached the job.completed webhook payload,
 * and Job.dynamicRun / Job.stepBreakdown never populated for ANY completed
 * Dynamic Agent Studio job, ever. This test posts a real body through the
 * real Fastify schema and asserts `dynamicRun` survives — a mocked handler
 * call (bypassing Fastify's schema layer entirely) would never have caught
 * this, which is exactly how it shipped unnoticed.
 */

vi.mock("../src/webhooks/deliver.js", () => ({ deliverWebhook: vi.fn().mockResolvedValue("delivered") }));

const RUNNER_TOKEN = "test-runner-token";

function baseRecord(): JobRecord {
  return {
    id: "job-1",
    status: "running",
    request: {
      task_type: "custom",
      client_id: "client-1",
      brief: {},
      callback_url: "https://portal.test/api/agent-service/webhook",
    },
    attempt: 1,
    maxAttempts: 3,
    createdAt: 0,
    artifacts: [],
    runnerToken: RUNNER_TOKEN,
  };
}

/** Minimal in-memory stand-in for JobsStore — only .get/.update are called by these routes. */
function fakeStore(initial: JobRecord) {
  let record = initial;
  return {
    get: vi.fn(async (id: string) => (id === record.id ? record : null)),
    update: vi.fn(async (_id: string, mutate: (r: JobRecord) => JobRecord) => {
      record = mutate(record);
      return record;
    }),
    _current: () => record,
  };
}

async function buildApp(store: ReturnType<typeof fakeStore>): Promise<FastifyInstance> {
  const app = Fastify();
  const { registerInternalRoutes } = await import("../src/api/internal.js");
  registerInternalRoutes(app, {
    config: { webhookSecret: "secret" } as any,
    store: store as any,
    artifactStore: {} as any,
    enqueue: vi.fn(),
    removeQueued: vi.fn(),
    finalize: vi.fn(),
  });
  return app;
}

describe("POST /internal/jobs/:id/complete", () => {
  let store: ReturnType<typeof fakeStore>;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = fakeStore(baseRecord());
    app = await buildApp(store);
  });

  it("preserves dynamicRun through schema validation into runnerReport (the bug: it used to be silently stripped)", async () => {
    const dynamicRun = {
      specId: "spec-1",
      specVersion: 1,
      steps: [
        { stepId: "a", type: "ai", label: "Research", status: "done", durationMs: 100, usage: { totalCostUsd: 0.05, models: {} } },
      ],
    };
    const res = await app.inject({
      method: "POST",
      url: "/internal/jobs/job-1/complete",
      headers: { "x-runner-token": RUNNER_TOKEN, "content-type": "application/json" },
      payload: { outcome: "done", dynamicRun },
    });
    expect(res.statusCode).toBe(204);
    expect(store._current().runnerReport?.dynamicRun).toEqual(dynamicRun);
  });

  it("still accepts a body with no dynamicRun at all (the hardcoded custom-agent path)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/jobs/job-1/complete",
      headers: { "x-runner-token": RUNNER_TOKEN, "content-type": "application/json" },
      payload: { outcome: "done", model: "claude-sonnet-4-6" },
    });
    expect(res.statusCode).toBe(204);
    expect(store._current().runnerReport?.dynamicRun).toBeUndefined();
    expect(store._current().model).toBe("claude-sonnet-4-6");
  });

  it("401s without a valid runner token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/jobs/job-1/complete",
      headers: { "x-runner-token": "wrong", "content-type": "application/json" },
      payload: { outcome: "done" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /internal/jobs/:id/step-progress", () => {
  it("records currentStepId/completedStepIds and clears currentStepId on a failed step", async () => {
    const store = fakeStore(baseRecord());
    const app = await buildApp(store);

    const running = await app.inject({
      method: "POST",
      url: "/internal/jobs/job-1/step-progress",
      headers: { "x-runner-token": RUNNER_TOKEN, "content-type": "application/json" },
      payload: { step_id: "a", step_name: "Research", status: "running" },
    });
    expect(running.statusCode).toBe(204);
    expect(store._current().currentStepId).toBe("a");

    const done = await app.inject({
      method: "POST",
      url: "/internal/jobs/job-1/step-progress",
      headers: { "x-runner-token": RUNNER_TOKEN, "content-type": "application/json" },
      payload: { step_id: "a", status: "done" },
    });
    expect(done.statusCode).toBe(204);
    expect(store._current().completedStepIds).toEqual(["a"]);

    const failed = await app.inject({
      method: "POST",
      url: "/internal/jobs/job-1/step-progress",
      headers: { "x-runner-token": RUNNER_TOKEN, "content-type": "application/json" },
      payload: { step_id: "b", step_name: "Draft", status: "failed" },
    });
    expect(failed.statusCode).toBe(204);
    expect(store._current().currentStepId).toBeUndefined();
  });
});
