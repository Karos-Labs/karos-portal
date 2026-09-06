import { describe, expect, it, vi, beforeEach } from "vitest";

const { updateJobMock, refundJobChargeMock, materializeMock, settleJobChargeMock, logUsageMock, afterMock } =
  vi.hoisted(() => ({
    updateJobMock: vi.fn(),
    afterMock: vi.fn(),
    refundJobChargeMock: vi.fn(),
    materializeMock: vi.fn(),
    settleJobChargeMock: vi.fn(),
    logUsageMock: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/data", () => ({ updateJob: updateJobMock }));
vi.mock("@/lib/credit-reconcile", () => ({ refundJobCharge: refundJobChargeMock }));
vi.mock("@/lib/credit-settle", () => ({ settleJobCharge: settleJobChargeMock }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: logUsageMock } }));
// Mocked EXPLICITLY rather than left to run for real against a half-mocked
// `@/lib/data`. It happened to no-op before (the fixtures carry no
// `agentEngineProductId`, so it returned early), which meant this suite's
// coverage of "materialize is attempted only on the transition into review" was
// accidental — and materialize.ts now pulls in the asset titler and the storage
// client, so the accident was also getting more expensive.
vi.mock("../materialize", () => ({ materializeAgentEngineDeliverable: materializeMock }));

import { scheduleAgentEngineJobStatusSync, syncAgentEngineJobStatusFromView } from "../reconcile";
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

  it("is idempotent — a job already synced with its asset attached triggers no further write", async () => {
    materializeMock.mockResolvedValue(undefined); // nothing new to attach
    await syncAgentEngineJobStatusFromView(job({ status: "review", assetIds: ["asset_1"] }), view("completed"));
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("materializes a job that is ALREADY at review but has no asset, and attaches it", async () => {
    // The gap that made the materialize.ts fix heal nothing already on disk.
    // This function returned early the moment `job.status` matched, so every
    // engine job that reached "review" back when its product had no
    // materializer was permanently asset-less — prep's own x-agent and
    // linkedin-agent runs were all in that state, with no path back.
    materializeMock.mockResolvedValue("asset_new");
    const result = await syncAgentEngineJobStatusFromView(job({ status: "review", assetIds: [] }), view("completed"));

    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(result.assetIds).toEqual(["asset_new"]);
    // NOTHING is written from here: the materializer attaches its own asset
    // with `attachAssetToJob` (an arrayUnion). A `[...job.assetIds, assetId]`
    // patch from this stale snapshot is exactly the overwrite that left every
    // duplicated prep job pointing at one asset with the rest orphaned.
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("does not re-attempt the refund on every view of an already-failed job", async () => {
    // The flip side of dropping the early return: without gating the refund on
    // the status transition, a staff member opening a failed job would open a
    // Firestore transaction each time.
    await syncAgentEngineJobStatusFromView(
      job({ status: "failed", error: "step 09 crashed" }),
      view("failed", { failureReason: "step 09 crashed" }),
    );
    expect(refundJobChargeMock).not.toHaveBeenCalled();
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("does not ask for a deliverable for a run that did not complete", async () => {
    await syncAgentEngineJobStatusFromView(job(), view("held", { reason: "cap reached" }));
    expect(materializeMock).not.toHaveBeenCalled();
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

/**
 * THE ONE TELEMETRY GAP THE CREDITS REWORK HAD TO CLOSE (2026-09).
 *
 * agent-engine has always reported what a run cost, and the portal has always
 * rendered it live — but this sync wrote only status/error/assetIds, so nothing
 * was ever PERSISTED. Every other execution path stored a cost; this family did
 * not, which meant it could not be settled against actual spend at all and read
 * as free on every staff cost surface. These pin the fix in both directions: the
 * cost lands on the job, and a delivered run settles its hold against it.
 */
describe("what an agent-engine run cost us", () => {
  beforeEach(() => {
    updateJobMock.mockReset();
    refundJobChargeMock.mockReset();
    materializeMock.mockReset();
    settleJobChargeMock.mockReset();
    logUsageMock.mockReset();
  });

  it("persists the run's own reported total onto job.external", async () => {
    await syncAgentEngineJobStatusFromView(
      job({ status: "running" }),
      view("completed", { totalCostUsd: 1.4 }),
    );
    expect(updateJobMock).toHaveBeenCalledTimes(1);
    expect(updateJobMock.mock.calls[0]![1].external).toMatchObject({ totalCostUsd: 1.4 });
  });

  it("falls back to the sum of the steps when the run total is missing", async () => {
    // A run that finished before the run-level total was written still has its
    // per-step costs, and they are the same dollars.
    const v = view("completed");
    v.steps = [{ costUsd: 0.4 }, { costUsd: 0.6 }, {}] as never;
    await syncAgentEngineJobStatusFromView(job({ status: "running" }), v);
    expect(updateJobMock.mock.calls[0]![1].external.totalCostUsd).toBeCloseTo(1);
  });

  it("treats a run that reported nothing as unknown, not as free", async () => {
    // Writing 0 would make a whole product family read as costless on the staff
    // cost line and would let a settlement refund the entire hold.
    await syncAgentEngineJobStatusFromView(job({ status: "running" }), view("completed"));
    expect(updateJobMock.mock.calls[0]![1].external).toBeUndefined();
    expect(settleJobChargeMock).not.toHaveBeenCalled();
  });

  it("logs the run's usage so this family is not invisible to cost reporting", async () => {
    await syncAgentEngineJobStatusFromView(
      job({ status: "running" }),
      view("completed", { totalCostUsd: 1.4 }),
    );
    expect(logUsageMock).toHaveBeenCalledTimes(1);
    // Already priced by the engine — passing tokens here would be inventing them.
    expect(logUsageMock.mock.calls[0]![0]).toMatchObject({ costUsd: 1.4, jobId: "job_1" });
  });

  it("settles the client's hold against that cost on a DELIVERED run", async () => {
    await syncAgentEngineJobStatusFromView(
      job({ status: "running" }),
      view("completed", { totalCostUsd: 1.4 }),
    );
    // The delivering job is named twice: once as the pairing key, once as the
    // run doing the settling, so a task key carrying two live holds hands back
    // the right one (CreditLedgerEntry.settlesJobId).
    expect(settleJobChargeMock).toHaveBeenCalledWith(
      "job_1",
      1.4,
      "Social posts (IG/TikTok)",
      "job_1",
    );
    expect(refundJobChargeMock).not.toHaveBeenCalled();
  });

  it("refunds a failed run and does NOT also settle it", async () => {
    // A charge is either refunded or settled, never both. The settlement path
    // re-checks this inside its own transaction; this is the caller-side half.
    await syncAgentEngineJobStatusFromView(
      job({ status: "running" }),
      view("failed", { failureReason: "step 09 crashed", totalCostUsd: 1.4 }),
    );
    expect(refundJobChargeMock).toHaveBeenCalledTimes(1);
    expect(settleJobChargeMock).not.toHaveBeenCalled();
  });

  it("neither refunds nor settles a HELD run", async () => {
    // It can still resume and deliver, and it must then settle against its FULL
    // cost — not against the partial one it had while held.
    await syncAgentEngineJobStatusFromView(
      job({ status: "running" }),
      view("held", { reason: "cap reached", totalCostUsd: 0.4 }),
    );
    expect(refundJobChargeMock).not.toHaveBeenCalled();
    expect(settleJobChargeMock).not.toHaveBeenCalled();
  });

  it("does not re-settle on every later view of the same job", async () => {
    // This function runs on every page view of a terminal job. Without the
    // cost-changed gate, each one would open a Firestore transaction to learn
    // that the hold is already settled.
    await syncAgentEngineJobStatusFromView(
      job({ status: "review", external: { totalCostUsd: 1.4 } } as never),
      view("completed", { totalCostUsd: 1.4 }),
    );
    expect(settleJobChargeMock).not.toHaveBeenCalled();
    expect(updateJobMock).not.toHaveBeenCalled();
  });
});

/**
 * D6 — ONE USAGE ROW PER OUTCOME, not one per time the total moves.
 *
 * An agent-engine run is genuinely re-enterable (`RESUMABLE_FROM_STATUSES`
 * admits `held`), so a run that is held and then resumed passes through this
 * sync twice with a bigger number each time. Logging on `costChanged` alone
 * billed the leaderboard for the same run twice and inflated every dashboard
 * that sums `usageLogs`.
 */
describe("usage logging across a hold and a resume", () => {
  beforeEach(() => {
    updateJobMock.mockReset();
    refundJobChargeMock.mockReset();
    materializeMock.mockReset();
    settleJobChargeMock.mockReset();
    logUsageMock.mockReset();
  });

  it("logs once for the hold and once for the delivery, never twice for one", async () => {
    // Held at $0.40 — a terminal outcome of its own, so it logs what it burned.
    await syncAgentEngineJobStatusFromView(
      job({ status: "running" }),
      view("held", { reason: "cap reached", totalCostUsd: 0.4 }),
    );
    expect(logUsageMock).toHaveBeenCalledTimes(1);

    // Resumed and delivered at $1.40 — a NEW outcome, and the row carries the
    // full cost rather than the delta.
    await syncAgentEngineJobStatusFromView(
      job({ status: "held", heldReason: "cap reached", external: { totalCostUsd: 0.4 } } as never),
      view("completed", { totalCostUsd: 1.4 }),
    );
    expect(logUsageMock).toHaveBeenCalledTimes(2);
    expect(logUsageMock.mock.calls[1]![0]).toMatchObject({ costUsd: 1.4 });
  });

  it("does not log again when only the cost moves under an unchanged status", async () => {
    // The live shape of the double-log: a still-`review` job whose engine total
    // was topped up after delivery. The cost is persisted; the usage row is not
    // written a second time.
    await syncAgentEngineJobStatusFromView(
      job({ status: "review", external: { totalCostUsd: 1.4 } } as never),
      view("completed", { totalCostUsd: 1.5 }),
    );
    expect(updateJobMock).toHaveBeenCalledTimes(1);
    expect(updateJobMock.mock.calls[0]![1].external.totalCostUsd).toBe(1.5);
    expect(logUsageMock).not.toHaveBeenCalled();
  });
});

describe("scheduleAgentEngineJobStatusSync — defers a sync only when one has work left", () => {
  beforeEach(() => {
    afterMock.mockReset();
    materializeMock.mockReset();
  });

  it("schedules nothing for a job that is already fully synced with its asset attached", () => {
    // Every render of a finished job's page used to defer a full sync holding
    // that render's snapshot; with the page refreshing every 4 s around
    // completion, that is where prep's 2–8 identical assets per run came from.
    const result = scheduleAgentEngineJobStatusSync(
      job({ status: "review", assetIds: ["asset_1"], external: { totalCostUsd: 0.5 } }),
      view("completed", { totalCostUsd: 0.5 }),
    );
    expect(afterMock).not.toHaveBeenCalled();
    expect(result.status).toBe("review");
  });

  it("schedules one sync when the status still needs writing", () => {
    scheduleAgentEngineJobStatusSync(job({ status: "running" }), view("completed"));
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("schedules one sync when the status is right but the deliverable is still unattached", () => {
    scheduleAgentEngineJobStatusSync(job({ status: "review", assetIds: [] }), view("completed"));
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("schedules nothing while the run is still in flight", () => {
    scheduleAgentEngineJobStatusSync(job(), view("running"));
    expect(afterMock).not.toHaveBeenCalled();
  });
});
