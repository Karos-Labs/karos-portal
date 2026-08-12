/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as storage from "@/lib/storage";
import { logger } from "@/services/logger";

/**
 * A resumed Dynamic Agent Studio run's `dynamic_run.steps` carries EVERY
 * completed step across every attempt (resumeFrom prepends a prior attempt's
 * trace so step-level cost history survives a resume — step-runner.ts). That
 * means the SAME step can appear in more than one job.completed delivery for
 * the same jobId: once on the attempt that first completed it (possibly a
 * failed delivery), and again on every later delivery that carries it
 * forward. The per-step usageLogs loop must not log that step's tokens/cost
 * more than once across those deliveries — gated on `payload.status ===
 * "done"` so a step is logged exactly once, on the run's one eventual
 * success, never on an interim failure whose steps get carried into a later
 * delivery.
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
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn() }));
vi.mock("@/lib/chain", () => ({ reflowClientChain: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/client-agent-slots", () => ({
  syncOptionsFromBatchAsset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/credit-reconcile", () => ({
  refundJobCharge: vi.fn().mockResolvedValue({ refunded: false }),
}));
vi.mock("@/lib/task-sync", () => ({
  autoCompleteTasksByTrigger: vi.fn().mockResolvedValue(undefined),
  findDispatchingTask: vi.fn().mockResolvedValue(null),
  syncTaskForJobOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/job-alerts", () => ({ notifyJobFailure: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: vi.fn() } }));

const realData = await vi.importActual<typeof import("@/lib/data")>("@/lib/data");

function jobDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: "job-1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "Case study agent",
    title: "Case study agent · Run",
    dynamicAgentSpecId: "spec-1",
    status: "running",
    assetIds: [],
    events: [],
    input: {},
    createdAt: 0,
    external: { serviceJobId: "svc-1", taskType: "custom" },
    ...overrides,
  };
}

const stepA = {
  stepId: "a",
  type: "ai" as const,
  label: "Research",
  status: "done" as const,
  durationMs: 100,
  usage: { totalCostUsd: 0.01, models: { "claude-sonnet": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.01 } } },
};
const stepB = {
  stepId: "b",
  type: "ai" as const,
  label: "Draft",
  status: "done" as const,
  durationMs: 200,
  usage: { totalCostUsd: 0.02, models: { "claude-sonnet": { inputTokens: 20, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.02 } } },
};

function payload(overrides: Record<string, any> = {}) {
  return {
    event: "job.completed",
    job_id: "svc-1",
    status: "failed",
    task_type: "custom",
    client_id: "c1",
    artifacts: [],
    attempt: 0,
    ...overrides,
  };
}

async function post(body: Record<string, any>) {
  const { POST } = await import("@/app/api/agent-service/webhook/route");
  const req = new Request("https://portal.test/api/agent-service/webhook", {
    method: "POST",
    headers: { "x-signature": "sig", "x-timestamp": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as any);
}

function stepUsageCalls() {
  return (logger.logUsage as any).mock.calls
    .map((c: any[]) => c[0])
    .filter((c: any) => c.operation === "managed_job_step");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_WEBHOOK_SECRET = "test-secret";
  (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
  (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
  (data.getJob as any).mockResolvedValue(jobDoc());
  (data.claimExternalJobCompletion as any).mockResolvedValue(true);
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Karos" });
  (storage.uploadBytes as any).mockResolvedValue({ url: "https://cdn.test/x", path: "x" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("per-step usageLogs rows are never double-logged across a resume", () => {
  it("does NOT log per-step usage on a failed (interim) delivery, even though the run-level rows still fire", async () => {
    await post(payload({ status: "failed", error: "step c blew up", dynamic_run: { specId: "spec-1", specVersion: 1, steps: [stepA, stepB] } }));
    expect(stepUsageCalls()).toHaveLength(0);
  });

  it("logs each step exactly once on the run's eventual success, even though those steps were carried over from a failed attempt", async () => {
    // Same jobId, resumed: the success delivery's dynamic_run.steps carries
    // stepA/stepB forward (per step-runner.ts's resumeFrom) alongside a new
    // stepC — mirroring what a real resumed run's webhook payload looks like.
    const stepC = { ...stepB, stepId: "c", label: "Polish" };
    await post(payload({ status: "done", dynamic_run: { specId: "spec-1", specVersion: 1, steps: [stepA, stepB, stepC] } }));
    const calls = stepUsageCalls();
    expect(calls.map((c: any) => c.stepId).sort()).toEqual(["a", "b", "c"]);
    // Exactly one row per step — not one per (step × delivery).
    expect(calls).toHaveLength(3);
  });

  it("across two deliveries for the same job (failed, then done), a carried-over step is logged exactly once total", async () => {
    await post(payload({ status: "failed", dynamic_run: { specId: "spec-1", specVersion: 1, steps: [stepA] } }));
    expect(stepUsageCalls()).toHaveLength(0); // interim failure: not logged yet

    vi.clearAllMocks();
    (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
    (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
    (data.getJob as any).mockResolvedValue(jobDoc());
    (data.claimExternalJobCompletion as any).mockResolvedValue(true);
    (data.updateJob as any).mockResolvedValue(undefined);
    (data.getClient as any).mockResolvedValue({ id: "c1", name: "Karos" });
    (storage.uploadBytes as any).mockResolvedValue({ url: "https://cdn.test/x", path: "x" });

    await post(payload({ status: "done", dynamic_run: { specId: "spec-1", specVersion: 1, steps: [stepA, stepB] } }));
    const calls = stepUsageCalls();
    expect(calls.filter((c: any) => c.stepId === "a")).toHaveLength(1); // logged once total, on the success delivery only
    expect(calls.filter((c: any) => c.stepId === "b")).toHaveLength(1);
  });
});
