import { describe, expect, it, vi, beforeEach } from "vitest";

const { updateJobMock, refundJobChargeMock } = vi.hoisted(() => ({
  updateJobMock: vi.fn(),
  refundJobChargeMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ updateJob: updateJobMock }));
vi.mock("@/lib/credit-reconcile", () => ({ refundJobCharge: refundJobChargeMock }));

import { syncAgentEngineJobStatusFromView } from "../reconcile";
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

describe("syncAgentEngineJobStatusFromView", () => {
  beforeEach(() => {
    updateJobMock.mockReset();
    refundJobChargeMock.mockReset();
  });

  it("maps completed -> review, matching the legacy webhook's done -> review precedent", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("completed"));
    expect(result.status).toBe("review");
    expect(updateJobMock).toHaveBeenCalledWith("job_1", expect.objectContaining({ status: "review" }));
  });

  it("maps failed -> failed, carrying failureReason as job.error", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("failed", { failureReason: "step 09 crashed" }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("step 09 crashed");
  });

  it("maps degraded -> failed", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("degraded", { failureReason: "unexpected error" }));
    expect(result.status).toBe("failed");
  });

  it("maps held -> failed with a distinguishing message, not a real deliverable", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("held", { reason: "nothing cleared the gates" }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("nothing cleared the gates");
  });

  it("maps blocked_intake -> failed with a distinguishing message", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("blocked_intake", { reason: "missing client profile" }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("missing client profile");
  });

  it("does not update job.status while the run is still running", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("running"));
    expect(result.status).toBe("queued");
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("does not update job.status while the run is awaiting_gate — that's AgentEngineGateApproval's job, not job.status", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("awaiting_gate", { pendingGateId: "gate_1" }));
    expect(result.status).toBe("queued");
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("is idempotent — a job already synced to the run's outcome triggers no further write", async () => {
    await syncAgentEngineJobStatusFromView(job({ status: "review" }), view("completed"));
    expect(updateJobMock).not.toHaveBeenCalled();
  });
});

describe("refunds on a failed agent-engine run", () => {
  beforeEach(() => {
    updateJobMock.mockReset();
    refundJobChargeMock.mockReset();
  });

  it("refunds a failed run, the way the legacy path always did", async () => {
    // Custom agents charge credits at submission. Until they began routing
    // here this path never refunded, so a blocked run — a topic-guardrail
    // violation, say — left the client paying for output they never received.
    await syncAgentEngineJobStatusFromView(job({ status: "running" }), {
      run: { runId: "r1", status: "failed", failureReason: "Blocked by topic guardrail: draft engaged with crypto" },
    } as unknown as AgentEngineRunView);

    expect(refundJobChargeMock).toHaveBeenCalledTimes(1);
    expect(String(refundJobChargeMock.mock.calls[0]![1])).toMatch(/Auto-refund/);
  });

  it("refunds a held and a blocked_intake run too — both map to failed", async () => {
    for (const status of ["degraded", "held", "blocked_intake"] as const) {
      refundJobChargeMock.mockReset();
      await syncAgentEngineJobStatusFromView(job({ status: "running" }), {
        run: { runId: "r1", status, failureReason: "x", reason: "x" },
      } as unknown as AgentEngineRunView);
      expect(refundJobChargeMock, `${status} should refund`).toHaveBeenCalledTimes(1);
    }
  });

  it("never refunds a successful run", async () => {
    await syncAgentEngineJobStatusFromView(job({ status: "running" }), {
      run: { runId: "r1", status: "completed" },
      deliverable: undefined,
    } as unknown as AgentEngineRunView);

    expect(refundJobChargeMock).not.toHaveBeenCalled();
  });

  it("does not refund again once the job is already marked failed", async () => {
    // The early-return on an already-synced job is what keeps a repeated
    // reconcile from issuing a second refund.
    await syncAgentEngineJobStatusFromView(
      job({ status: "failed", error: "agent-engine run failed" }),
      { run: { runId: "r1", status: "failed" } } as unknown as AgentEngineRunView,
    );

    expect(refundJobChargeMock).not.toHaveBeenCalled();
  });
});
