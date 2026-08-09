import { describe, expect, it } from "vitest";
import { buildRetriedRecord } from "../src/api/jobs.js";
import type { JobRecord } from "../src/types.js";

function baseRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    status: "dead_letter",
    request: {
      task_type: "custom",
      client_id: "client-1",
      callback_url: "https://platform.example.com/api/agent-service/webhook",
      brief: {},
    },
    attempt: 2,
    maxAttempts: 2,
    createdAt: 0,
    artifacts: [],
    runnerToken: "token",
    error: "job container exited without reporting",
    webhookDelivered: true,
    checkpoint: { attempt: 2, files: [{ path: "out.md", url: "https://example.com/out.md", bytes: 10 }], bytes: 10 },
    ...overrides,
  };
}

describe("buildRetriedRecord", () => {
  it("re-queues a dead-lettered job with a checkpoint, bumping attempt/maxAttempts", () => {
    const result = buildRetriedRecord(baseRecord());
    expect("record" in result).toBe(true);
    if (!("record" in result)) return;
    expect(result.record.status).toBe("queued");
    expect(result.record.attempt).toBe(3);
    expect(result.record.maxAttempts).toBe(3);
    expect(result.record.webhookDelivered).toBe(false);
    expect(result.record.cancelRequested).toBe(false);
    expect(result.record.error).toBeUndefined();
    expect(result.record.checkpoint).toEqual(baseRecord().checkpoint);
  });

  it("re-queues a permanently-failed job the same way as a dead-lettered one", () => {
    const result = buildRetriedRecord(baseRecord({ status: "failed", attempt: 1, maxAttempts: 2 }));
    expect("record" in result).toBe(true);
    if (!("record" in result)) return;
    expect(result.record.status).toBe("queued");
    expect(result.record.attempt).toBe(2);
    expect(result.record.maxAttempts).toBe(2);
  });

  it("refuses a job that isn't in a retryable terminal state", () => {
    for (const status of ["queued", "running", "done", "cancelled"] as const) {
      const result = buildRetriedRecord(baseRecord({ status }));
      expect(result).toEqual({ error: "not_retryable", status });
    }
  });

  it("refuses a failed job with no checkpoint to resume from", () => {
    const { checkpoint: _checkpoint, ...record } = baseRecord();
    const result = buildRetriedRecord(record);
    expect(result).toEqual({ error: "no_checkpoint" });
  });

  it("refuses a failed job with an empty checkpoint file list", () => {
    const result = buildRetriedRecord(baseRecord({ checkpoint: { attempt: 2, files: [], bytes: 0 } }));
    expect(result).toEqual({ error: "no_checkpoint" });
  });

  it("preserves accumulated usage so cost tracking stays cumulative across the retry", () => {
    const usage = { totalCostUsd: 5.26, models: {} };
    const result = buildRetriedRecord(baseRecord({ usage }));
    expect("record" in result).toBe(true);
    if ("record" in result) expect(result.record.usage).toEqual(usage);
  });
});
