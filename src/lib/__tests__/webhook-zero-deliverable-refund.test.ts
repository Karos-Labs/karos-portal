/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #33 — A RUN THAT FINISHES WITH NOTHING THE CLIENT CAN SEE KEEPS THEIR CREDITS.
 *
 * The webhook's refund is gated on `payload.status !== "done"`, so a run the
 * service reports as DONE never reaches it. When such a run carries zero
 * client-facing artifacts, no asset is created either — the asset-creation
 * refund below it is unreachable, because no creation is attempted. The client
 * paid for a deliverable and got nothing, which is the same outcome as a
 * failed run: it now costs the same (this describe block) AND the job record
 * itself is corrected from the optimistic "review" claim to "failed" (see
 * "the deliveries under test actually ran" below), so it no longer sits
 * indistinguishable from a genuine success awaiting approval.
 *
 * The counterweight has its own test: a LAUNCH run's deliverable is not an asset
 * (it is the umbrella advancing), so judging one by artifact count would refund
 * every successful setup.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/agent-service/verify", () => ({
  SIGNATURE_HEADER: "x-signature",
  TIMESTAMP_HEADER: "x-timestamp",
  verifyAgentServiceSignature: () => true,
}));
vi.mock("@/lib/storage", () => ({
  uploadBytes: vi.fn().mockResolvedValue({ url: "https://cdn.test/hosted" }),
}));
vi.mock("@/lib/chain", () => ({ reflowClientChain: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/client-agent-slots", () => ({
  syncOptionsFromBatchAsset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/credit-settle", () => ({
  settleJobCharge: vi.fn().mockResolvedValue({ settled: true, delta: 7 }),
}));
vi.mock("@/lib/credit-reconcile", () => ({
  refundJobCharge: vi.fn().mockResolvedValue({ refunded: false }),
}));
vi.mock("@/lib/jobs/launch-outcome", () => ({
  applyLaunchOutcome: vi.fn().mockResolvedValue(undefined),
  isLaunchTemplatesArtifact: () => false,
}));
vi.mock("@/lib/task-sync", () => ({
  autoCompleteTasksByTrigger: vi.fn().mockResolvedValue(undefined),
  syncTaskForJobOutcome: vi.fn().mockResolvedValue(undefined),
  findDispatchingTask: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/job-alerts", () => ({ notifyJobFailure: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: vi.fn() } }));

import * as data from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { settleJobCharge } from "@/lib/credit-settle";
import { findDispatchingTask } from "@/lib/task-sync";

// The handler 503s without it, before any branch this file is about.
process.env.AGENT_WEBHOOK_SECRET = "test-secret";

/**
 * `isJobInFlight` is pure and the route's pre-claim filter reads it. Automocked
 * it returns undefined, which reads as "terminal" and turns every delivery away
 * before it can reach the branch under test.
 */
const realData = await vi.importActual<typeof import("@/lib/data")>("@/lib/data");

function jobDoc(overrides: Record<string, any> = {}) {
  return {
    id: "job-1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "LinkedIn Agent",
    title: "LinkedIn Agent · Weekly drafts",
    customAgentId: "agent-li",
    clientAgentId: "umb-1",
    runType: "manual",
    status: "running",
    assetIds: [],
    events: [],
    input: {},
    createdAt: 0,
    external: { serviceJobId: "svc-1", taskType: "custom" },
    ...overrides,
  };
}

/** Manifest with no `client_facing: true` entry — the shape under test. */
const STAFF_ONLY_ARTIFACTS = [
  {
    name: "debug.log",
    path: "debug.log",
    bytes: 5,
    sha256: "cccccccccccccccc",
    content_type: "text/plain",
    client_facing: false,
    url: "https://service.test/debug.log",
  },
];

const CLIENT_FACING_ARTIFACTS = [
  {
    name: "DRAFTS.md",
    path: "DRAFTS.md",
    bytes: 12,
    sha256: "aaaaaaaaaaaaaaaa",
    content_type: "text/markdown",
    client_facing: true,
    url: "https://service.test/DRAFTS.md",
  },
];

function payload(overrides: Record<string, any> = {}) {
  return {
    event: "job.completed",
    job_id: "svc-1",
    status: "done",
    task_type: "custom",
    client_id: "c1",
    artifacts: STAFF_ONLY_ARTIFACTS,
    usage: { totalCostUsd: 0.1, models: {} },
    attempt: 0,
    ...overrides,
  };
}

async function deliver(body: Record<string, any>) {
  const { POST } = await import("@/app/api/agent-service/webhook/route");
  const req = new Request("https://portal.test/api/agent-service/webhook", {
    method: "POST",
    headers: { "x-signature": "sig", "x-timestamp": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as any);
}

const refundReasons = () => vi.mocked(refundJobCharge).mock.calls.map((c) => c[1]);
/** The ledger keys the handler asked the refund to look under. */
const refundKeys = () => vi.mocked(refundJobCharge).mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findDispatchingTask).mockResolvedValue(null);
  vi.mocked(data.isJobInFlight).mockImplementation(realData.isJobInFlight);
  vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(jobDoc() as any);
  vi.mocked(data.claimExternalJobCompletion).mockResolvedValue(true as any);
  vi.mocked(data.getClient).mockResolvedValue({ id: "c1", name: "Acme" } as any);
  vi.mocked(data.createAsset).mockResolvedValue("asset-1" as any);
  vi.mocked(data.updateJob).mockResolvedValue(undefined as any);
  vi.mocked(refundJobCharge).mockResolvedValue({ refunded: true, amount: 25 } as any);
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () => new TextEncoder().encode("x").buffer,
    text: async () => "x",
  }) as any;
});

describe("a 'done' run with no client-facing deliverable", () => {
  it("refunds the client's charge", async () => {
    const res = await deliver(payload());
    expect(res.status).toBe(200);
    expect(refundReasons()).toEqual([expect.stringContaining("no deliverables")]);
  });

  it("creates no asset — which is why the asset-creation refund could never fire", async () => {
    await deliver(payload());
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  /**
   * THE DOMINANT PATH, and the one the first cut of this fix missed entirely.
   *
   * A run a client started from the board is charged under the TASK id — the
   * charge is taken in execution-actions before any job exists, and the job is
   * then submitted as the non-billable task engine, so NOTHING is ever filed
   * under job.id for it. A refund that only looked up job.id therefore found no
   * charge and quietly returned "nothing to refund" for most real runs.
   */
  it("looks the charge up under the DISPATCHING TASK's key, not only the job's", async () => {
    vi.mocked(findDispatchingTask).mockResolvedValue({
      id: "task-9",
      clientId: "c1",
      title: "Weekly drafts",
    } as any);

    await deliver(payload({ metadata: { karos_task_id: "task-9" } }));

    expect(refundKeys()).toEqual([["job-1", "task-9"]]);
  });

  it("asks OUR record which task dispatched the run, not the payload", async () => {
    // The echoed karos_task_id names a Firestore document and arrives over the
    // wire; findDispatchingTask is what validates it against this run and this
    // client. A payload naming a task we have no dispatch record for must not
    // move another client's credits.
    await deliver(payload({ metadata: { karos_task_id: "task-from-another-tenant" } }));

    expect(findDispatchingTask).toHaveBeenCalledWith("job-1", "c1", "task-from-another-tenant");
    expect(refundKeys()).toEqual([["job-1", undefined]]);
  });

  it("records the hand-back on the job so the run is not silently 'complete'", async () => {
    await deliver(payload());
    const events = vi.mocked(data.updateJob).mock.calls[0]![1].events as Array<{ message: string }>;
    expect(events.some((e) => /Refunded 25 credits/.test(e.message))).toBe(true);
  });
});

describe("the runs it must NOT refund", () => {
  it("leaves a run that produced a client-facing deliverable alone", async () => {
    await deliver(payload({ artifacts: CLIENT_FACING_ARTIFACTS }));
    expect(data.createAsset).toHaveBeenCalled();
    expect(refundJobCharge).not.toHaveBeenCalled();
  });

  /**
   * A setup run's deliverable is the umbrella advancing (applyLaunchOutcome),
   * not an asset. Judging it by client-facing artifact count would hand back the
   * credits for every successful launch. A launch that genuinely failed arrives
   * with a non-done status and is refunded by the pre-claim path instead.
   */
  it("leaves a successful LAUNCH run alone even with no client-facing artifact", async () => {
    vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(jobDoc({ runType: "launch" }) as any);
    await deliver(payload());
    expect(refundJobCharge).not.toHaveBeenCalled();
  });

  it("still refunds a FAILED run through the path that already existed", async () => {
    await deliver(payload({ status: "failed", error: "agent crashed", artifacts: [] }));
    expect(refundReasons()).toEqual([expect.stringContaining("run failed")]);
  });
});

/**
 * NON-VACUITY. Every assertion above is about a refund that either does or does
 * not happen, and all of them would "pass" if the handler bailed out before the
 * branch under test — a 404 for an unmatched job, say. Pin that the deliveries
 * actually reached the end.
 */
describe("the deliveries under test actually ran", () => {
  it("claims the job provisionally as 'review', then corrects the final record to 'failed'", async () => {
    const res = await deliver(payload());
    expect(res.status).toBe(200);
    // The claim fires before the deliverable count is known, so it still takes
    // the optimistic "done" mapping — see STATUS_MAP and the comment on the
    // `let status` declaration above it.
    expect(data.claimExternalJobCompletion).toHaveBeenCalledWith("job-1", "review");
    // The client got nothing, which reads the same as a failed run — so the
    // record the job page and every dashboard actually query must say "failed",
    // not sit in the same "review" bucket as a genuine success.
    expect(data.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        status: "failed",
        error: "The run finished without producing a client-facing deliverable",
      }),
    );
  });
});

/**
 * SETTLEMENT AND REFUND ARE THE SAME DECISION, SEEN FROM THE HANDLER
 * (credits rework, 2026-09).
 *
 * A client is charged an ESTIMATE at dispatch; a delivered run reconciles it to
 * `ceil(usage.totalCostUsd × 20)`. This file already owns the question "which
 * outcomes hand credits back", and settlement is the other half of that same
 * question — so the two must be asked together, in the same fixtures, or the
 * one case that matters most (a run refunded AND settled, paying the client
 * twice for nothing) can hide between two suites.
 *
 * The handler's own gate is `status === "review"`, and `status` is the CORRECTED
 * one: the zero-deliverable branch flips a "done" run to "failed" before this
 * runs, which is exactly why settlement sits after the single-use claim while
 * the refund sits before it.
 */
describe("settling a delivered run against what it actually cost", () => {
  it("settles a run that produced a deliverable, using the reported cost", async () => {
    await deliver(payload({ artifacts: CLIENT_FACING_ARTIFACTS }));
    expect(settleJobCharge).toHaveBeenCalledTimes(1);
    const [keys, usd] = vi.mocked(settleJobCharge).mock.calls[0]!;
    expect(usd).toBe(0.1);
    // Both ledger keys, for the reason the refund passes both: a task-dispatched
    // run was charged under the TASK id before this job existed.
    expect(keys).toEqual(["job-1", undefined]);
  });

  it("looks the hold up under the DISPATCHING TASK's key too", async () => {
    vi.mocked(findDispatchingTask).mockResolvedValue({
      id: "task-9",
      clientId: "c1",
    } as never);
    await deliver(payload({ artifacts: CLIENT_FACING_ARTIFACTS }));
    expect(vi.mocked(settleJobCharge).mock.calls[0]![0]).toEqual(["job-1", "task-9"]);
  });

  it("does NOT settle a run that produced nothing — it was refunded instead", async () => {
    // The invariant, at the one place both outcomes are decided: a charge is
    // either refunded or settled, never both.
    await deliver(payload());
    expect(refundJobCharge).toHaveBeenCalledTimes(1);
    expect(settleJobCharge).not.toHaveBeenCalled();
  });

  it("does NOT settle a failed run", async () => {
    await deliver(payload({ status: "failed", error: "agent crashed", artifacts: [] }));
    expect(settleJobCharge).not.toHaveBeenCalled();
  });

  it("hands the settlement a missing cost rather than inventing one", async () => {
    // "Cost unknown" must reach the settlement path as undefined so it can
    // decline; the handler must not substitute 0, which would refund the hold.
    await deliver(payload({ artifacts: CLIENT_FACING_ARTIFACTS, usage: { models: {} } }));
    expect(vi.mocked(settleJobCharge).mock.calls[0]![1]).toBeUndefined();
  });

  it("still delivers when the settlement throws", async () => {
    // A lost settlement leaves the estimate standing, which is the pre-rework
    // behaviour and a safe floor. Failing the delivery over it would strand the
    // asset the client already received.
    vi.mocked(settleJobCharge).mockRejectedValueOnce(new Error("firestore down"));
    const res = await deliver(payload({ artifacts: CLIENT_FACING_ARTIFACTS }));
    expect(res.status).toBe(200);
    expect(data.createAsset).toHaveBeenCalled();
  });
});
