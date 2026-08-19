/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AN APPROVED TASK-MAP SUGGESTION'S INFERRED DATE REACHES ITS ASSET (2026-08).
 *
 * Approving a suggestion (updateTaskStatusAction's `targetDate` param) stashes
 * the calendar day it was shown on as `metadata.suggestedDate` on the task
 * (lib/calendar-suggestion-placement.ts infers it; see that module and
 * action-list.ts's sibling feature for the full story). Without this, the
 * asset the run produces lands as `status: "draft"` with only a
 * `recommendedAt` HINT — never `scheduledAt` — so `postKind` (calendar-kind.ts)
 * classifies it `null` and it is invisible on the calendar regardless of
 * anything the grid itself does. The webhook is where the two meet: it already
 * resolves "the task that dispatched this run" via `findDispatchingTask` for
 * the zero-deliverable refund (webhook-zero-deliverable-refund.test.ts) — this
 * file is the SAME lookup, read for a different field, feeding a different
 * write.
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
import { findDispatchingTask } from "@/lib/task-sync";

process.env.AGENT_WEBHOOK_SECRET = "test-secret";

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
    artifacts: CLIENT_FACING_ARTIFACTS,
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

/** The `scheduledAt` field of the createAsset call, whichever call index it is. */
const createdScheduledAt = () =>
  vi.mocked(data.createAsset).mock.calls.map((c) => (c[0] as any).scheduledAt);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findDispatchingTask).mockResolvedValue(null);
  vi.mocked(data.isJobInFlight).mockImplementation(realData.isJobInFlight);
  vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(jobDoc() as any);
  vi.mocked(data.claimExternalJobCompletion).mockResolvedValue(true as any);
  vi.mocked(data.getClient).mockResolvedValue({ id: "c1", name: "Acme" } as any);
  vi.mocked(data.createAsset).mockResolvedValue("asset-1" as any);
  vi.mocked(data.updateJob).mockResolvedValue(undefined as any);
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () => new TextEncoder().encode("x").buffer,
    text: async () => "x",
  }) as any;
});

describe("a run dispatched from an approved suggestion", () => {
  it("gives the created asset the task's suggestedDate as its own scheduledAt", async () => {
    vi.mocked(findDispatchingTask).mockResolvedValue({
      id: "task-9",
      clientId: "c1",
      title: "Weekly drafts",
      metadata: { suggestedDate: 1_800_000_000_000 },
    } as any);

    await deliver(payload({ metadata: { karos_task_id: "task-9" } }));

    expect(createdScheduledAt()).toEqual([1_800_000_000_000]);
  });

  it("asks OUR record of the dispatch, not the payload, for the date", async () => {
    await deliver(payload({ metadata: { karos_task_id: "task-9" } }));
    expect(findDispatchingTask).toHaveBeenCalledWith("job-1", "c1", "task-9");
  });
});

describe("every other run — the common case this must not disturb", () => {
  it("leaves scheduledAt unset when the dispatching task carries no suggestedDate", async () => {
    vi.mocked(findDispatchingTask).mockResolvedValue({
      id: "task-1",
      clientId: "c1",
      title: "Ordinary task",
      metadata: {},
    } as any);

    await deliver(payload({ metadata: { karos_task_id: "task-1" } }));

    expect(createdScheduledAt()).toEqual([undefined]);
  });

  it("leaves scheduledAt unset when there is no dispatching task at all (staff-fired / no task)", async () => {
    vi.mocked(findDispatchingTask).mockResolvedValue(null);

    await deliver(payload());

    expect(createdScheduledAt()).toEqual([undefined]);
  });

  it("ignores a non-numeric suggestedDate rather than passing it through", async () => {
    vi.mocked(findDispatchingTask).mockResolvedValue({
      id: "task-2",
      clientId: "c1",
      title: "Corrupt row",
      metadata: { suggestedDate: "not-a-date" },
    } as any);

    await deliver(payload({ metadata: { karos_task_id: "task-2" } }));

    expect(createdScheduledAt()).toEqual([undefined]);
  });
});
