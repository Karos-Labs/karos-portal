import { describe, expect, it, vi, beforeEach } from "vitest";

const { updateJobMock, refundJobChargeMock, materializeMock } = vi.hoisted(() => ({
  updateJobMock: vi.fn(),
  refundJobChargeMock: vi.fn(),
  materializeMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ updateJob: updateJobMock }));
vi.mock("@/lib/credit-reconcile", () => ({ refundJobCharge: refundJobChargeMock }));
// Mocked EXPLICITLY rather than left to run for real against a half-mocked
// `@/lib/data`. It happened to no-op before (the fixtures carry no
// `agentEngineProductId`, so it returned early), which meant this suite's
// coverage of "materialize is attempted only on the transition into review" was
// accidental — and materialize.ts now pulls in the asset titler and the storage
// client, so the accident was also getting more expensive.
vi.mock("../materialize", () => ({ materializeAgentEngineDeliverable: materializeMock }));

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
    materializeMock.mockReset();
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

  it("maps held -> its own held status, with the reason on heldReason and NOT on error", async () => {
    // The whole point of the state. `held` is agent-engine's non-failure "nothing
    // honestly cleared the gates" outcome, and this used to land on `failed` with
    // the reason in `job.error` — which put a working guardrail behind a red
    // Error card, in the Jobs list's failure chip, and through an auto-refund.
    const result = await syncAgentEngineJobStatusFromView(job(), view("held", { reason: "nothing cleared the gates" }));
    expect(result.status).toBe("held");
    expect(result.heldReason).toBe("nothing cleared the gates");
    // `error` is what classifyJobError / the failure alert / the danger card all
    // read, so a hold reason landing there is the defect, not a detail.
    expect(result.error).toBeNull();
  });

  it("falls back to a plain held message when the run recorded no reason", async () => {
    const result = await syncAgentEngineJobStatusFromView(job(), view("held"));
    expect(result.status).toBe("held");
    expect(result.heldReason).toMatch(/held/i);
  });

  it("clears a stale heldReason when a resumed run later completes", async () => {
    // agent-engine's own RESUMABLE_FROM_STATUSES admits `held`, so held -> resumed
    // -> completed is a real path through this function, and `updateJob` is
    // set(merge:true) — a transition that wrote only the field it cared about
    // would leave "nothing cleared the gates" on a delivered job forever.
    await syncAgentEngineJobStatusFromView(
      job({ status: "held", heldReason: "nothing cleared the gates" }),
      view("completed"),
    );
    expect(updateJobMock).toHaveBeenCalledWith(
      "job_1",
      expect.objectContaining({ status: "review", heldReason: null, error: null }),
    );
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
    materializeMock.mockReset();
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

  it("refunds a degraded and a blocked_intake run too — both still map to failed", async () => {
    for (const status of ["degraded", "blocked_intake"] as const) {
      refundJobChargeMock.mockReset();
      await syncAgentEngineJobStatusFromView(job({ status: "running" }), {
        run: { runId: "r1", status, failureReason: "x", reason: "x" },
      } as unknown as AgentEngineRunView);
      expect(refundJobChargeMock, `${status} should refund`).toHaveBeenCalledTimes(1);
    }
  });

  it("does NOT refund a held run", async () => {
    // A held run is re-entrant on agent-engine's side (its own
    // RESUMABLE_FROM_STATUSES lists `held`, and every completed step is
    // checkpointed), so it can still deliver on a resume — refunding the hold and
    // then delivering would credit the client for work they received. See
    // JobStatus's own "held" note, which also states the residual: a hold nobody
    // ever resumes leaves the charge standing.
    await syncAgentEngineJobStatusFromView(job({ status: "running" }), {
      run: { runId: "r1", status: "held", reason: "engagement lane daily cap reached" },
    } as unknown as AgentEngineRunView);

    expect(refundJobChargeMock).not.toHaveBeenCalled();
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
