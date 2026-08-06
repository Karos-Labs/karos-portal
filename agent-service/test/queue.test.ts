import { describe, expect, it, vi } from "vitest";
import { enqueueJob, type JobsQueue } from "../src/queue/queue.js";
import type { JobRecord } from "../src/types.js";

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    status: "queued",
    request: {
      task_type: "social_post",
      client_id: "client-1",
      brief: { topic: "t" },
      callback_url: "https://cb.example.com/hook",
    },
    attempt: 1,
    maxAttempts: 2,
    createdAt: 1,
    artifacts: [],
    runnerToken: "tok",
    ...overrides,
  };
}

function mockQueue(): JobsQueue {
  return { add: vi.fn().mockResolvedValue(undefined) } as unknown as JobsQueue;
}

describe("enqueueJob", () => {
  it("adds with no delay when none is given (the original submission path)", async () => {
    const queue = mockQueue();
    await enqueueJob(queue, record());
    expect(queue.add).toHaveBeenCalledWith(
      "run",
      { jobId: "job-1" },
      { jobId: "job-1_1" },
    );
  });

  it("passes a delay through when given (the retry path, worker.ts's afterExit)", async () => {
    const queue = mockQueue();
    await enqueueJob(queue, record({ attempt: 2 }), { delayMs: 5000 });
    expect(queue.add).toHaveBeenCalledWith(
      "run",
      { jobId: "job-1" },
      { jobId: "job-1_2", delay: 5000 },
    );
  });

  it("omits the delay key entirely for delayMs: 0 rather than passing a no-op 0", () => {
    const queue = mockQueue();
    // A falsy delayMs (0/undefined) should behave identically to omitting opts.
    return enqueueJob(queue, record(), { delayMs: 0 }).then(() => {
      expect(queue.add).toHaveBeenCalledWith(
        "run",
        { jobId: "job-1" },
        { jobId: "job-1_1" },
      );
    });
  });
});
