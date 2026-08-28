import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * SCRUM-265 item 4 — "Stop writing during render on the job page."
 *
 * The property under test is literally that: calling
 * `scheduleAgentEngineJobStatusSync` must NOT perform the Firestore write
 * (or the materialize call, or the refund) before it returns — those must
 * happen only once the deferred `after()` callback actually runs, which in
 * production is after the response has been sent.
 *
 * `after` is mocked as a controllable queue (not the codebase's usual
 * `(fn) => fn()` immediate-invoke stub) specifically so this test can assert
 * the "not yet" half — an immediate-invoke mock would make this and the old,
 * blocking implementation look identical, which is exactly the kind of check
 * that cannot fail regardless of which code it runs against.
 */
const { updateJobMock, refundJobChargeMock, materializeMock, afterQueue } = vi.hoisted(() => ({
  updateJobMock: vi.fn(),
  refundJobChargeMock: vi.fn(),
  materializeMock: vi.fn(),
  afterQueue: [] as Array<() => void | Promise<void>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ updateJob: updateJobMock }));
vi.mock("@/lib/credit-reconcile", () => ({ refundJobCharge: refundJobChargeMock }));
vi.mock("../materialize", () => ({ materializeAgentEngineDeliverable: materializeMock }));
vi.mock("next/server", () => ({
  after: (task: () => void | Promise<void>) => {
    afterQueue.push(task);
  },
}));

import { scheduleAgentEngineJobStatusSync } from "../reconcile";
import type { AgentEngineRunView } from "../read-run";
import type { Job } from "@/lib/types";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    clientId: "client_1",
    agentId: "agent-engine",
    agentName: "Social posts (IG/TikTok)",
    title: "Test job",
    status: "queued",
    input: {},
    assetIds: [],
    events: [],
    createdBy: "user_1",
    createdAt: 1000,
    updatedAt: 1000,
    agentEngineRunId: "pubsub-msg-1",
    ...overrides,
  } as Job;
}

function view(status: AgentEngineRunView["run"]["status"], overrides: Partial<AgentEngineRunView["run"]> = {}): AgentEngineRunView {
  return {
    run: {
      runId: "pubsub-msg-1",
      clientSlug: "acme",
      productId: "landing-builder-agent",
      runKind: "recurring",
      status,
      createdAt: 1000,
      updatedAt: 2000,
      ...overrides,
    },
    steps: [],
  };
}

async function flushAfterQueue() {
  const queued = afterQueue.splice(0, afterQueue.length);
  for (const task of queued) await task();
}

describe("scheduleAgentEngineJobStatusSync", () => {
  beforeEach(() => {
    updateJobMock.mockReset();
    refundJobChargeMock.mockReset();
    materializeMock.mockReset();
    afterQueue.length = 0;
  });

  it("does not write to Firestore before returning — the write is deferred, not inline", () => {
    const result = scheduleAgentEngineJobStatusSync(job(), view("completed"));

    // The render-facing return value already reflects the transition...
    expect(result.status).toBe("review");
    // ...but nothing has been persisted yet. This is the actual bug: the old
    // `await syncAgentEngineJobStatusFromView(...)` call in the page blocked
    // the response on exactly this write.
    expect(updateJobMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("performs the real write once the deferred (after()) callback is flushed", async () => {
    materializeMock.mockResolvedValue(undefined);
    scheduleAgentEngineJobStatusSync(job(), view("completed"));
    expect(updateJobMock).not.toHaveBeenCalled();

    await flushAfterQueue();

    expect(updateJobMock).toHaveBeenCalledWith("job_1", expect.objectContaining({ status: "review" }));
  });

  it("schedules nothing at all while the run is still in flight — same no-op as the synchronous path", () => {
    const result = scheduleAgentEngineJobStatusSync(job(), view("running"));
    expect(result.status).toBe("queued");
    expect(afterQueue).toHaveLength(0);
  });

  it("still refunds a failed run — just after the response, not before it", async () => {
    scheduleAgentEngineJobStatusSync(
      job({ status: "running" }),
      view("failed", { failureReason: "step 09 crashed" }),
    );
    expect(refundJobChargeMock).not.toHaveBeenCalled();

    await flushAfterQueue();

    expect(refundJobChargeMock).toHaveBeenCalledTimes(1);
  });
});
