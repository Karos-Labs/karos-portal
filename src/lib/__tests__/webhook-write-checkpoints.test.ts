/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as storage from "@/lib/storage";

/**
 * The hardcoded custom-agent path has no per-step SDK boundary, so
 * `write_checkpoints`/`run_duration_ms` (present only when a skill happens
 * to checkpoint its own progress by writing files) is what drives
 * Job.stepBreakdown there instead of `dynamic_run`. This pins: the branch
 * only fires when `dynamic_run` is absent, the resulting breakdown is
 * proportioned by wall-clock share of the run's totals, and it's marked
 * `estimated` so the UI never presents it as exact.
 */

vi.mock("server-only", () => ({}));
const afterState: { promise: Promise<unknown> } = { promise: Promise.resolve() };
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => void | Promise<void>) => {
      afterState.promise = Promise.resolve().then(fn);
      return afterState.promise;
    },
  };
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
    agentName: "LinkedIn Agent",
    title: "LinkedIn Agent · Karos Labs",
    customAgentId: "custom-1",
    status: "running",
    assetIds: [],
    events: [],
    input: {},
    createdAt: 0,
    external: { serviceJobId: "svc-1", taskType: "custom" },
    ...overrides,
  };
}

function payload(overrides: Record<string, any> = {}) {
  return {
    event: "job.completed",
    job_id: "svc-1",
    status: "done",
    task_type: "custom",
    client_id: "c1",
    artifacts: [
      {
        name: "post.md",
        path: "clients/karoslabs/outputs/linkedin-agent-v2/run/client/post.md",
        bytes: 100,
        sha256: "a".repeat(16),
        client_facing: true,
        url: "https://service.test/post.md",
      },
    ],
    usage: {
      totalCostUsd: 1.0,
      models: {
        "claude-sonnet": { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    },
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
  const res = await POST(req as any);
  await afterState.promise;
  return res;
}

function writtenJobPatch(): any {
  const call = (data.updateJob as any).mock.calls.at(-1);
  return call ? call[1] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_WEBHOOK_SECRET = "test-secret";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("# Post\n").buffer,
      text: async () => "# Post\n",
    }),
  );
  (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
  (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
  (data.getJob as any).mockResolvedValue(jobDoc());
  (data.claimExternalJobCompletion as any).mockResolvedValue(true);
  (data.createAsset as any).mockResolvedValue("asset-new");
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Karos" });
  (storage.uploadBytes as any).mockImplementation(async ({ path }: { path: string }) => ({
    url: `https://cdn.test/${path}`,
    path,
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("job.completed with write_checkpoints (hardcoded path)", () => {
  it("builds an estimated stepBreakdown prorated by wall-clock share", async () => {
    await post(
      payload({
        write_checkpoints: [
          { path: "clients/karoslabs/outputs/linkedin-agent-v2/run/internal/01-run.json", atMs: 0 },
          { path: "clients/karoslabs/outputs/linkedin-agent-v2/run/internal/12-commit.json", atMs: 5000 },
        ],
        run_duration_ms: 10_000,
      }),
    );
    const patch = writtenJobPatch();
    expect(patch.stepBreakdown).toHaveLength(2);
    expect(patch.stepBreakdown[0]).toMatchObject({ stepId: "01-run", durationMs: 5000, estimated: true });
    expect(patch.stepBreakdown[1]).toMatchObject({ stepId: "12-commit", durationMs: 5000, estimated: true });
    expect(patch.dynamicRun).toBeUndefined();
  });

  it("does not set stepBreakdown at all when the skill left no checkpoints", async () => {
    await post(payload());
    const patch = writtenJobPatch();
    expect(patch.stepBreakdown).toBeUndefined();
  });

  it("prefers dynamic_run over write_checkpoints when a payload somehow carries both", async () => {
    await post(
      payload({
        dynamic_run: { specId: "spec-1", specVersion: 1, steps: [] },
        write_checkpoints: [{ path: "outputs/01-a.json", atMs: 0 }],
        run_duration_ms: 1000,
      }),
    );
    const patch = writtenJobPatch();
    expect(patch.dynamicRun).toBeDefined();
    // The dynamic_run branch's own stepBreakdown (built from zero steps) wins — not the checkpoint estimate.
    expect(patch.stepBreakdown).toEqual([]);
  });
});
