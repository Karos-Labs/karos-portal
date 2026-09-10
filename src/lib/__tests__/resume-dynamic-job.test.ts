import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as agentServiceClient from "@/lib/agent-service/client";
import * as submitCustom from "@/lib/jobs/submit-custom";
import type { Job } from "@/lib/types";

/**
 * resumeFailedJobAction is the Dynamic Agent Studio counterpart of
 * retryJobAction (retry-job-resume.test.ts) — same four-case shape, gated on
 * dynamicAgentSpecId instead of customAgentId, and its from-scratch fallback
 * reconstructs `inputs` from job.input.inputs (the JSON blob submit-custom.ts
 * now persists) rather than job.input.prompt.
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
vi.mock("@/lib/jobs/submit-custom", () => ({
  submitCustomAgentJob: vi.fn(),
  submitDynamicAgentJob: vi.fn(),
}));

function failedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    clientId: "client-1",
    agentId: "agent-service",
    dynamicAgentSpecId: "spec-1",
    agentName: "Case study agent",
    title: "Case study agent",
    status: "failed",
    input: { agent: "Case study agent", inputs: JSON.stringify({ company_name: "Acme" }) },
    assetIds: [],
    events: [{ at: 0, level: "info", message: "Submitted to agent service" }],
    createdBy: "u-staff",
    createdAt: 0,
    updatedAt: 0,
    external: { taskType: "custom", serviceJobId: "svc-1", inputTokens: 0, outputTokens: 0, artifacts: [] },
    ...overrides,
  };
}

describe("resumeFailedJobAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes the same agent-service job and does not submit a fresh one", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob());
    vi.mocked(data.updateJob).mockResolvedValue(undefined);
    vi.mocked(agentServiceClient.retryAgentServiceJob).mockResolvedValue({ status: "queued", attempt: 2 });

    const { resumeFailedJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await resumeFailedJobAction("job-1");

    expect(result).toEqual({ jobId: "job-1" });
    expect(agentServiceClient.retryAgentServiceJob).toHaveBeenCalledWith("svc-1");
    expect(submitCustom.submitDynamicAgentJob).not.toHaveBeenCalled();
    expect(data.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "queued", error: null }),
    );
  });

  it("falls back to a fresh submission, reconstructed from job.input.inputs, when the service has nothing to resume from", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob());
    vi.mocked(agentServiceClient.retryAgentServiceJob).mockRejectedValue(
      new agentServiceClient.AgentServiceNotResumable("no checkpoint"),
    );
    vi.mocked(submitCustom.submitDynamicAgentJob).mockResolvedValue({ jobId: "job-2" });

    const { resumeFailedJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await resumeFailedJobAction("job-1");

    expect(result).toEqual({ jobId: "job-2" });
    expect(submitCustom.submitDynamicAgentJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ specId: "spec-1", clientId: "client-1", inputs: { company_name: "Acme" } }),
    );
    expect(data.updateJob).not.toHaveBeenCalled();
  });

  it("surfaces a genuine service error instead of silently falling back", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob());
    vi.mocked(agentServiceClient.retryAgentServiceJob).mockRejectedValue(new Error("service unreachable"));

    const { resumeFailedJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await resumeFailedJobAction("job-1");

    expect(result).toEqual({ error: "service unreachable" });
    expect(submitCustom.submitDynamicAgentJob).not.toHaveBeenCalled();
  });

  it("skips the resume path entirely when the job has no service reference", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob({ external: undefined }));
    vi.mocked(submitCustom.submitDynamicAgentJob).mockResolvedValue({ jobId: "job-2" });

    const { resumeFailedJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await resumeFailedJobAction("job-1");

    expect(result).toEqual({ jobId: "job-2" });
    expect(agentServiceClient.retryAgentServiceJob).not.toHaveBeenCalled();
  });

  it("rejects a job with no dynamicAgentSpecId — that is retryJobAction's job, not this one's", async () => {
    vi.mocked(data.getJob).mockResolvedValue(failedJob({ dynamicAgentSpecId: undefined, customAgentId: "custom-1" }));

    const { resumeFailedJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await resumeFailedJobAction("job-1");

    expect(result.error).toMatch(/no resumable agent reference/i);
  });

  it("refuses to resubmit a legacy job with no saved inputs, instead of silently resubmitting {}", async () => {
    // Predates submitDynamicAgentJob persisting input.inputs — job.input is
    // just { agent: spec.name }, same as every dynamic-agent job created
    // before that change shipped.
    vi.mocked(data.getJob).mockResolvedValue(
      failedJob({ external: undefined, input: { agent: "Case study agent" } }),
    );

    const { resumeFailedJobAction } = await import("@/lib/actions/external-job-actions");
    const result = await resumeFailedJobAction("job-1");

    expect(result.error).toMatch(/predates resumable execution/i);
    expect(submitCustom.submitDynamicAgentJob).not.toHaveBeenCalled();
  });
});
