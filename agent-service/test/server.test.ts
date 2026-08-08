import { describe, expect, it } from "vitest";
import { createJobRecord, type ServerDeps } from "../src/server.js";
import type { ServiceConfig } from "../src/config.js";

/**
 * createJobRecord runs TWO independent gates on a submitted brief: the ajv
 * schema (schemas/validate.js, covered by schemas.test.ts) and its own
 * resolveTaskConfig() call, which is skipped entirely for a Dynamic Agent
 * Studio brief (see the isDynamicAgentBrief() check in server.ts). Neither
 * schemas.test.ts nor task-types.test.ts drives createJobRecord itself —
 * this file closes that gap.
 */

function baseConfig(): ServiceConfig {
  return {
    port: 8080,
    redisUrl: "redis://localhost:6379",
    authTokens: ["test-token"],
    webhookSecret: "test-secret",
    internalBaseUrl: "http://localhost:8080",
    publicBaseUrl: "http://localhost:8080",
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

function testDeps(): ServerDeps {
  return {
    config: baseConfig(),
    // createJobRecord never touches store/artifactStore/enqueue/removeQueued/
    // finalize — only deps.config — so these are unused stand-ins to satisfy
    // ServerDeps's shape.
    store: {} as ServerDeps["store"],
    artifactStore: {} as ServerDeps["artifactStore"],
    enqueue: async () => {},
    removeQueued: async () => false,
    finalize: async () => {},
  };
}

function dynamicSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "spec-1",
    name: "Case Study Drafter",
    description: "Drafts a case study.",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 5,
    active: true,
    version: 1,
    inputSchema: [{ key: "company_name", type: "text", label: "Company name", required: true, order: 0 }],
    steps: [{ id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0 }],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u-admin",
    ...overrides,
  };
}

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_type: "custom",
    client_id: "client-123",
    callback_url: "https://platform.example.com/api/agent-service/webhook",
    ...overrides,
  };
}

describe("createJobRecord", () => {
  it("accepts a dynamic-agent brief with no entry_skill_dir", () => {
    const result = createJobRecord(
      testDeps(),
      requestBody({
        brief: {
          specSnapshot: dynamicSpec(),
          spec_version: 1,
          inputs: { company_name: "Acme" },
          agent_key: "case-study-drafter",
          label: "Case Study Drafter",
        },
      }),
    );
    expect("errors" in result).toBe(false);
    if (!("errors" in result)) {
      expect(result.record.request.brief.specSnapshot).toBeDefined();
      expect(result.record.status).toBe("queued");
    }
  });

  it("still rejects a legacy custom brief with an empty entry_skill_dir", () => {
    const result = createJobRecord(
      testDeps(),
      requestBody({
        brief: {
          entry_skill_dir: "",
          instructions: "Run the agent.",
          prompt: "3 posts",
        },
      }),
    );
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.join(" ")).toMatch(/entry_skill_dir/);
    }
  });

  it("still rejects a legacy custom brief with a missing entry_skill_dir", () => {
    const result = createJobRecord(
      testDeps(),
      requestBody({
        brief: {
          instructions: "Run the agent.",
          prompt: "3 posts",
        },
      }),
    );
    expect("errors" in result).toBe(true);
  });
});
