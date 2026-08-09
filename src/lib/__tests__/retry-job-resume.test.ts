/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as agentServiceClient from "@/lib/agent-service/client";
import * as submitCustom from "@/lib/jobs/submit-custom";
import type { Job } from "@/lib/types";

/**
 * retryJobAction's whole point is to avoid re-spending Anthropic tokens (and
 * re-billing) on work a failed run already finished. That only holds if it
 * genuinely prefers resuming the SAME agent-service job over minting a fresh
 * one — assert the branch, not just that some jobId comes back.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/agent-service/reconcile-job", () => ({ reconcileOneJob: vi.fn() }));
vi.mock("@/lib/actions/_shared", () => ({
  requireStaff: vi.fn().mockResolvedValue({ uid: "u-staff", role: "KAROS_EMPLOYEE" }),
  requireClientAccess: vi.fn(),
}));
vi.mock("@/lib/agent-service/client", () => {
  class AgentServiceNotResumable extends Error {}
  return {
    AgentServiceNotResumable,
    cancelAgentServiceJob: vi.fn(),
    retryAgentServiceJob: vi.fn(),
  };
});
vi.mock("@/lib/jobs/submit-custom", () => ({ submitCustomAgentJob: vi.fn() }));

function failedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    clientId: "client-1",
    agentId: "agent-service",
    customAgentId: "custom-agent-1",
    agentName: "LinkedIn Setup",
    title: "LinkedIn Setup",
    status: "failed",
    input: { agent: "LinkedIn Setup", prompt: "Set up LinkedIn" },
    assetIds: [],
    events: [{ at: 0, level: "info", message: "Submitted to agent service" }],
    createdBy: "u-staff",
    createdAt: 0,
    updatedAt: 0,
    external: { taskType: "custom", serviceJobId: "svc-1", inputTokens: 0, outputTokens: 0, artifacts: [] },
    ...overrides,
  };
}

describe("retryJobAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes the same agent-service job and does not submit a fresh one", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob());
    vi.mocked(data.updateJob).mockResolvedValue(undefined);
    vi.mocked(agentServiceClient.retryAgentServiceJob).mockResolvedValue({ status: "queued", attempt: 2 });

    const { retryJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await retryJobAction("job-1");

    expect(result).toEqual({ jobId: "job-1" });
    expect(agentServiceClient.retryAgentServiceJob).toHaveBeenCalledWith("svc-1");
    expect(submitCustom.submitCustomAgentJob).not.toHaveBeenCalled();
    expect(data.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "queued", error: null }),
    );
  });

  it("falls back to a fresh submission when the service has nothing to resume from", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob());
    vi.mocked(agentServiceClient.retryAgentServiceJob).mockRejectedValue(
      new agentServiceClient.AgentServiceNotResumable("no checkpoint"),
    );
    vi.mocked(submitCustom.submitCustomAgentJob).mockResolvedValue({ jobId: "job-2" });

    const { retryJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await retryJobAction("job-1");

    expect(result).toEqual({ jobId: "job-2" });
    expect(submitCustom.submitCustomAgentJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "custom-agent-1", clientId: "client-1", prompt: "Set up LinkedIn" }),
    );
    expect(data.updateJob).not.toHaveBeenCalled();
  });

  it("surfaces a genuine service error instead of silently falling back", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob());
    vi.mocked(agentServiceClient.retryAgentServiceJob).mockRejectedValue(new Error("service unreachable"));

    const { retryJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await retryJobAction("job-1");

    expect(result).toEqual({ error: "service unreachable" });
    expect(submitCustom.submitCustomAgentJob).not.toHaveBeenCalled();
  });

  it("skips the resume path entirely when the job has no service reference", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob({ external: undefined }));
    vi.mocked(submitCustom.submitCustomAgentJob).mockResolvedValue({ jobId: "job-2" });

    const { retryJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await retryJobAction("job-1");

    expect(result).toEqual({ jobId: "job-2" });
    expect(agentServiceClient.retryAgentServiceJob).not.toHaveBeenCalled();
  });
});
