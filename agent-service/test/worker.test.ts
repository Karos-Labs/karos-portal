import { describe, expect, it } from "vitest";
import { buildJobSpec, buildRunnerEnv, buildWebhookPayload, resolveExitEvent } from "../src/queue/worker.js";
import type { ServiceConfig } from "../src/config.js";
import type { JobRecord } from "../src/types.js";

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    status: "running",
    request: {
      task_type: "social_post",
      client_id: "client-1",
      brief: { topic: "t" },
      callback_url: "https://cb.example.com/hook",
      metadata: { platform_job_id: "fs-123" },
    },
    attempt: 1,
    maxAttempts: 2,
    createdAt: 1,
    artifacts: [],
    runnerToken: "tok",
    ...overrides,
  };
}

describe("resolveExitEvent", () => {
  it("prefers the runner report over a timeout race", () => {
    expect(
      resolveExitEvent(record({ runnerReport: { outcome: "done" } }), true),
    ).toEqual({ type: "complete" });
  });

  it("maps timeout with no report to a timeout event", () => {
    expect(resolveExitEvent(record(), true)).toEqual({ type: "timeout" });
  });

  it("treats a silent container death as transient", () => {
    expect(resolveExitEvent(record(), false)).toEqual({ type: "fail", transient: true });
  });

  it("maps runner outcomes", () => {
    expect(resolveExitEvent(record({ runnerReport: { outcome: "done" } }), false)).toEqual({ type: "complete" });
    expect(resolveExitEvent(record({ runnerReport: { outcome: "cancelled" } }), false)).toEqual({ type: "cancel" });
    expect(
      resolveExitEvent(record({ runnerReport: { outcome: "failed", transient: true } }), false),
    ).toEqual({ type: "fail", transient: true });
    expect(resolveExitEvent(record({ runnerReport: { outcome: "failed" } }), false)).toEqual({
      type: "fail",
      transient: false,
    });
  });

  it("honours a cancel request when the runner reported failure mid-kill", () => {
    expect(
      resolveExitEvent(record({ cancelRequested: true, runnerReport: { outcome: "failed", transient: true } }), false),
    ).toEqual({ type: "cancel" });
  });
});

describe("buildWebhookPayload", () => {
  it("carries artifacts, usage, metadata and provenance", () => {
    const payload = buildWebhookPayload(
      record({
        status: "done",
        agentsRepoSha: "abc123",
        model: "claude-sonnet-x",
        usage: { totalCostUsd: 1.23, models: {} },
        transcriptUrl: "https://svc/t",
        artifacts: [
          {
            path: "clients/x/outputs/blog/2026-07-05-job/client/post.md",
            name: "post.md",
            bytes: 10,
            sha256: "d".repeat(64),
            contentType: "text/markdown",
            clientFacing: true,
            url: "https://svc/a",
          },
        ],
      }),
    );
    expect(payload.status).toBe("done");
    expect(payload.metadata?.platform_job_id).toBe("fs-123");
    expect(payload.artifacts[0]?.client_facing).toBe(true);
    expect(payload.agents_repo_sha).toBe("abc123");
    expect(payload.usage?.totalCostUsd).toBe(1.23);
    expect(payload.transcript_url).toBe("https://svc/t");
  });
});

describe("buildRunnerEnv", () => {
  it("passes the API key and proxy settings, exempting the api + metadata hosts from the proxy", () => {
    const config = {
      anthropicApiKey: "sk-ant-xxx",
      jobHttpProxy: "http://proxy:8888",
      internalBaseUrl: "http://api:8080",
    } as ServiceConfig;
    const env = buildRunnerEnv(config);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8888");
    // api host bypasses the proxy (callbacks go direct), and the GCE metadata
    // server must too (it's the IAM ID-token source, denied by the allow-list).
    expect(env.NO_PROXY?.split(",")).toEqual(["api", "metadata.google.internal", "169.254.169.254"]);
  });

  it("bypasses the proxy for the job-scoped platform MCP host", () => {
    const config = {
      jobHttpProxy: "http://proxy:8888",
      internalBaseUrl: "http://api:8080",
    } as ServiceConfig;
    const spec = buildJobSpec(config, record({
      request: {
        ...record().request,
        callback_url: "https://app.example.com/api/webhook",
        metadata: {
          karos_mcp_url: "https://app.example.com/api/mcp",
          karos_job_token: "karos_job_secret",
        },
      },
    }));
    expect(spec.karosMcp).toEqual({
      url: "https://app.example.com/api/mcp",
      token: "karos_job_secret",
    });
    expect(buildRunnerEnv(config, spec).NO_PROXY?.split(",")).toContain("app.example.com");
  });

  it("rejects an MCP endpoint on a different origin from the platform webhook", () => {
    const config = { internalBaseUrl: "http://api:8080" } as ServiceConfig;
    const spec = buildJobSpec(config, record({
      request: {
        ...record().request,
        callback_url: "https://app.example.com/api/webhook",
        metadata: {
          karos_mcp_url: "https://attacker.example/api/mcp",
          karos_job_token: "karos_job_secret",
        },
      },
    }));
    expect(spec.karosMcp).toBeUndefined();
  });

  it("omits proxy vars when no proxy is configured", () => {
    const env = buildRunnerEnv({ internalBaseUrl: "http://api:8080" } as ServiceConfig);
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("injects APIFY_TOKEN only when configured", () => {
    expect(buildRunnerEnv({ internalBaseUrl: "http://api:8080" } as ServiceConfig).APIFY_TOKEN).toBeUndefined();
    const env = buildRunnerEnv({ internalBaseUrl: "http://api:8080", apifyToken: "apify_api_xxx" } as ServiceConfig);
    expect(env.APIFY_TOKEN).toBe("apify_api_xxx");
  });
});
