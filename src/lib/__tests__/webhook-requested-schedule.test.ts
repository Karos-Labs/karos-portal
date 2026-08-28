/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-B9 ("[T-B9] Generate now, publish on date X", SCRUM-253).
 *
 * `reschedule_output` only ever moves an asset that already exists.
 * `createPlannedRunAction` schedules the GENERATION itself, for later, and is
 * staff-only. Neither lets someone ask, in one request, for an agent to run
 * NOW with its deliverable already scheduled to publish on a chosen date.
 *
 * The honest mechanism: run now, and stamp the target date on the job
 * (`Job.requestedScheduledAt`, set staff-only via `run_agent_now`'s
 * `publishAt` param / `runCustomAgentAction`). The completion webhook reads
 * ITS OWN record of the request back off the job doc — never the payload —
 * and schedules the resulting asset directly (`status: "scheduled"`) instead
 * of letting it land as an undated draft.
 *
 * Modeled directly on webhook-suggested-date.test.ts, which is this same
 * webhook doing the analogous thing for an approved Task-Map suggestion.
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

const FUTURE = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days out
const PAST = Date.now() - 60 * 60 * 1000; // 1 hour ago

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

/** The single createAsset call's payload, for the assertions below. */
const createdAssetCall = () => vi.mocked(data.createAsset).mock.calls[0]?.[0] as any;

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

describe("a run carrying a staff-requested target publish date (Job.requestedScheduledAt)", () => {
  it("schedules the resulting asset directly instead of landing it as an undated draft", async () => {
    vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(
      jobDoc({ requestedScheduledAt: FUTURE }) as any,
    );

    await deliver(payload());

    const asset = createdAssetCall();
    expect(asset.status).toBe("scheduled");
    expect(asset.scheduledAt).toBe(FUTURE);
    expect(asset.publishMode).toBe("manual");
  });

  it("reads its OWN job record, not the webhook payload, for the date", async () => {
    vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(
      jobDoc({ requestedScheduledAt: FUTURE }) as any,
    );
    // A malicious/irrelevant payload-carried date must be ignored.
    await deliver(payload({ metadata: { requestedScheduledAt: String(FUTURE + 1) } }));

    expect(createdAssetCall().scheduledAt).toBe(FUTURE);
  });

  it("ignores a requested date that has already passed by completion, rather than scheduling a post dated in the past", async () => {
    vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(
      jobDoc({ requestedScheduledAt: PAST }) as any,
    );

    await deliver(payload());

    const asset = createdAssetCall();
    expect(asset.status).toBe("draft");
    expect(asset.scheduledAt).toBeUndefined();
  });

  it("never applies to a Control Room Test Run, whatever date rides on the job", async () => {
    vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(
      jobDoc({ requestedScheduledAt: FUTURE, runType: "test" }) as any,
    );

    await deliver(payload());

    const asset = createdAssetCall();
    expect(asset.status).toBe("draft");
    expect(asset.meta.testRun).toBe(true);
  });

  it("never applies to a launch (setup) deliverable", async () => {
    vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(
      jobDoc({ requestedScheduledAt: FUTURE, runType: "launch", clientAgentId: "umb-1" }) as any,
    );

    await deliver(payload());

    const asset = createdAssetCall();
    expect(asset.status).toBe("draft");
    expect(asset.meta.launchDeliverable).toBe(true);
  });
});

describe("every other run — the common case this must not disturb", () => {
  it("leaves the asset as an ordinary undated draft when no schedule was requested", async () => {
    vi.mocked(data.getJobByExternalServiceId).mockResolvedValue(jobDoc() as any);

    await deliver(payload());

    const asset = createdAssetCall();
    expect(asset.status).toBe("draft");
    expect(asset.scheduledAt).toBeUndefined();
  });
});
