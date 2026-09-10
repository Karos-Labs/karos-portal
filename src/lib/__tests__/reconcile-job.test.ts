import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getAgentServiceJobMock,
  refundJobChargeMock,
  claimExternalJobCompletionMock,
  updateJobMock,
  syncTaskForJobOutcomeMock,
  notifyJobFailureMock,
  getClientMock,
  logUsageMock,
} = vi.hoisted(() => ({
  getAgentServiceJobMock: vi.fn(),
  refundJobChargeMock: vi.fn(),
  claimExternalJobCompletionMock: vi.fn(),
  updateJobMock: vi.fn(),
  syncTaskForJobOutcomeMock: vi.fn(),
  notifyJobFailureMock: vi.fn(),
  getClientMock: vi.fn(),
  logUsageMock: vi.fn(),
}));

vi.mock("@/lib/agent-service/client", () => ({ getAgentServiceJob: getAgentServiceJobMock }));
vi.mock("@/lib/credit-reconcile", () => ({ refundJobCharge: refundJobChargeMock }));
vi.mock("@/lib/task-sync", () => ({ syncTaskForJobOutcome: syncTaskForJobOutcomeMock }));
vi.mock("@/lib/job-alerts", () => ({ notifyJobFailure: notifyJobFailureMock }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: logUsageMock } }));
vi.mock("@/lib/data", () => ({
  claimExternalJobCompletion: claimExternalJobCompletionMock,
  getClient: getClientMock,
  updateJob: updateJobMock,
}));

import { reconcileOneJob } from "@/lib/agent-service/reconcile-job";
import type { Job } from "@/lib/types";

const BASE_JOB: Job = {
  id: "job1",
  clientId: "client1",
  agentId: "agent-service",
  agentName: "X Agent",
  title: "Draft a post",
  status: "running",
  input: {},
  assetIds: [],
  events: [],
  createdBy: "system",
  createdAt: 1,
  updatedAt: 2,
  external: { serviceJobId: "svc1", taskType: "custom" },
};

beforeEach(() => {
  vi.clearAllMocks();
  refundJobChargeMock.mockResolvedValue({ refunded: false });
  claimExternalJobCompletionMock.mockResolvedValue(true);
  updateJobMock.mockResolvedValue(undefined);
  syncTaskForJobOutcomeMock.mockResolvedValue(undefined);
  notifyJobFailureMock.mockResolvedValue(undefined);
  getClientMock.mockResolvedValue({ id: "client1", name: "Acme Co" });
});

describe("reconcileOneJob", () => {
  it("returns immediately for a job with no external.serviceJobId — nothing to reconcile", async () => {
    const job: Job = { ...BASE_JOB, external: undefined };
    const result = await reconcileOneJob(job);
    expect(result.action).toMatch(/not a managed job/);
    expect(getAgentServiceJobMock).not.toHaveBeenCalled();
  });

  it("leaves a 'done' remote job alone — deliverables must come through the webhook", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "done", attempt: 1, artifacts: [] });
    const result = await reconcileOneJob(BASE_JOB);
    expect(result.action).toMatch(/awaiting webhook/);
    expect(claimExternalJobCompletionMock).not.toHaveBeenCalled();
    expect(refundJobChargeMock).not.toHaveBeenCalled();
  });

  it("reports 'still <status>' for a remote job that hasn't reached a terminal state", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "running", attempt: 1, artifacts: [] });
    const result = await reconcileOneJob(BASE_JOB);
    expect(result.action).toBe("still running");
    expect(claimExternalJobCompletionMock).not.toHaveBeenCalled();
  });

  it("refunds BEFORE claiming, and does not claim at all if the refund throws", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "failed", attempt: 1, artifacts: [], error: "boom" });
    refundJobChargeMock.mockRejectedValue(new Error("ledger write failed"));
    const result = await reconcileOneJob(BASE_JOB);
    expect(result.action).toMatch(/refund failed/);
    expect(claimExternalJobCompletionMock).not.toHaveBeenCalled();
  });

  it("stops after a lost claim race — another delivery already reconciled this job", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "failed", attempt: 1, artifacts: [], error: "boom" });
    claimExternalJobCompletionMock.mockResolvedValue(false);
    const result = await reconcileOneJob(BASE_JOB);
    expect(result.action).toBe("already reconciled");
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("on a real failure: claims, updates the job, alerts, and logs usage with status 'failed'", async () => {
    getAgentServiceJobMock.mockResolvedValue({
      id: "svc1",
      status: "failed",
      attempt: 1,
      artifacts: [],
      error: "429 rate limit",
      usage: { models: { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
    });
    const result = await reconcileOneJob(BASE_JOB);
    expect(result.action).toBe("reconciled → failed");
    expect(claimExternalJobCompletionMock).toHaveBeenCalledWith("job1", "failed");
    expect(updateJobMock).toHaveBeenCalledTimes(1);
    expect(notifyJobFailureMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock.mock.calls[0]![0]).toMatchObject({
      status: "failed",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("on a cancellation: claims and logs usage as 'cancelled', but never alerts (deliberate stop, not a failure)", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "cancelled", attempt: 1, artifacts: [] });
    const result = await reconcileOneJob(BASE_JOB);
    expect(result.action).toBe("reconciled → cancelled");
    expect(claimExternalJobCompletionMock).toHaveBeenCalledWith("job1", "cancelled");
    expect(notifyJobFailureMock).not.toHaveBeenCalled();
    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock.mock.calls[0]![0]).toMatchObject({ status: "cancelled" });
  });

  it("dead_letter maps to a 'failed' local status and does alert", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "dead_letter", attempt: 5, artifacts: [] });
    const result = await reconcileOneJob(BASE_JOB);
    expect(result.action).toBe("reconciled → failed");
    expect(claimExternalJobCompletionMock).toHaveBeenCalledWith("job1", "failed");
    expect(notifyJobFailureMock).toHaveBeenCalledTimes(1);
  });

  it("logs a zero-cost usage stub when the remote job reports no per-model usage at all", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "failed", attempt: 1, artifacts: [], error: "boom" });
    await reconcileOneJob(BASE_JOB);
    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock.mock.calls[0]![0]).toMatchObject({ inputTokens: 0, outputTokens: 0, status: "failed" });
  });

  it("never throws even if syncTaskForJobOutcome rejects", async () => {
    getAgentServiceJobMock.mockResolvedValue({ id: "svc1", status: "failed", attempt: 1, artifacts: [], error: "boom" });
    syncTaskForJobOutcomeMock.mockRejectedValue(new Error("task gone"));
    await expect(reconcileOneJob(BASE_JOB)).resolves.toMatchObject({ action: "reconciled → failed" });
  });
});
