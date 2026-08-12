/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";

/**
 * The job.step_progress branch (Dynamic Agent Studio live progress) is
 * deliberately handled and RETURNED entirely separately from job.completed:
 * no claim, no refund, no artifact re-host, no asset write, no usage
 * logging. These tests pin that isolation — a step-progress ping only ever
 * touches currentStepId/currentStepName/completedStepIds.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
let signatureValid = true;
vi.mock("@/lib/agent-service/verify", () => ({
  SIGNATURE_HEADER: "x-signature",
  TIMESTAMP_HEADER: "x-timestamp",
  verifyAgentServiceSignature: () => signatureValid,
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

import { refundJobCharge } from "@/lib/credit-reconcile";
import { logger } from "@/services/logger";

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

function payload(overrides: Record<string, any> = {}) {
  return {
    event: "job.step_progress",
    job_id: "svc-1",
    status: "running",
    client_id: "c1",
    current_step_id: "step-2",
    current_step_name: "Write the draft",
    completed_step_ids: ["step-1"],
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

beforeEach(() => {
  vi.clearAllMocks();
  signatureValid = true;
  process.env.AGENT_WEBHOOK_SECRET = "test-secret";
  (data.isJobInFlight as any).mockImplementation(realData.isJobInFlight);
  (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc());
  (data.getJob as any).mockResolvedValue(jobDoc());
  (data.updateJob as any).mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("job.step_progress", () => {
  it("updates only the live-progress fields on an in-flight job", async () => {
    const res = await post(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(data.updateJob).toHaveBeenCalledTimes(1);
    expect(data.updateJob).toHaveBeenCalledWith("job-1", {
      currentStepId: "step-2",
      currentStepName: "Write the draft",
      completedStepIds: ["step-1"],
      updatedAt: expect.any(Number),
    });
  });

  it("never touches credits, refunds, or usage logging", async () => {
    await post(payload());
    expect(refundJobCharge).not.toHaveBeenCalled();
    expect(logger.logUsage).not.toHaveBeenCalled();
  });

  it("is a no-op against a job that already reached a terminal status", async () => {
    (data.getJobByExternalServiceId as any).mockResolvedValue(jobDoc({ status: "review" }));
    const res = await post(payload());
    expect(await res.json()).toEqual({ ok: true, skipped: true, reason: "Already processed" });
    expect(data.updateJob).not.toHaveBeenCalled();
  });

  it("defaults current_step_id/current_step_name to null when the runner omits them", async () => {
    await post(payload({ current_step_id: undefined, current_step_name: undefined }));
    expect(data.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ currentStepId: null, currentStepName: null }),
    );
  });

  it("401s on a bad signature, same as job.completed", async () => {
    signatureValid = false;
    const res = await post(payload());
    expect(res.status).toBe(401);
    expect(data.updateJob).not.toHaveBeenCalled();
  });

  it("400s on a malformed payload (missing completed_step_ids type)", async () => {
    const res = await post({ ...payload(), completed_step_ids: "not-an-array" });
    expect(res.status).toBe(400);
  });
});
