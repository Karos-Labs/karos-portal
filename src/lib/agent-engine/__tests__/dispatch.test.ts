import { describe, expect, it, vi, beforeEach } from "vitest";

const { createJobMock, updateJobMock, publishAgentEngineRunMock } = vi.hoisted(() => ({
  createJobMock: vi.fn(),
  updateJobMock: vi.fn(),
  publishAgentEngineRunMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ createJob: createJobMock, updateJob: updateJobMock }));
vi.mock("../pubsub-client", () => ({
  isAgentEnginePubSubConfigured: () => true,
  publishAgentEngineRun: publishAgentEngineRunMock,
  agentEngineRunIdFromMessageId: (messageId: string) => `pubsub-${messageId}`,
}));

import { dispatchAgentEngineRun } from "../dispatch";
import { dispatchOnboardingResearchAgents } from "../dispatch-research-agents";

describe("dispatchAgentEngineRun", () => {
  beforeEach(() => {
    createJobMock.mockReset().mockResolvedValue("job_1");
    updateJobMock.mockReset();
    publishAgentEngineRunMock.mockReset();
  });

  it("creates a job, publishes, and records the derived agentEngineRunId on success", async () => {
    publishAgentEngineRunMock.mockResolvedValue({ messageId: "msg_1" });

    const result = await dispatchAgentEngineRun({
      clientId: "client_1",
      clientSlug: "acme",
      productId: "seo-geo-agent",
      runKind: "recurring",
      agentName: "SEO/GEO Research",
      title: "Test dispatch",
    });

    expect(result).toEqual({ jobId: "job_1", agentEngineRunId: "pubsub-msg_1" });
    expect(updateJobMock).toHaveBeenCalledWith("job_1", expect.objectContaining({ agentEngineRunId: "pubsub-msg_1", agentEngineProductId: "seo-geo-agent" }));
  });

  it("marks the job failed and returns the error when publish throws", async () => {
    publishAgentEngineRunMock.mockRejectedValue(new Error("pubsub unavailable"));

    const result = await dispatchAgentEngineRun({
      clientId: "client_1",
      clientSlug: "acme",
      productId: "intel-report-agent",
      runKind: "recurring",
      agentName: "Intel Report",
      title: "Test dispatch",
    });

    expect(result).toEqual({ jobId: "job_1", error: "pubsub unavailable" });
    expect(updateJobMock).toHaveBeenCalledWith("job_1", expect.objectContaining({ status: "failed", error: "pubsub unavailable" }));
  });
});

describe("dispatchOnboardingResearchAgents", () => {
  beforeEach(() => {
    createJobMock.mockReset().mockResolvedValue("job_1");
    updateJobMock.mockReset();
    publishAgentEngineRunMock.mockReset().mockResolvedValue({ messageId: "msg_1" });
  });

  it("dispatches both seo-geo-agent and intel-report-agent as independent jobs", async () => {
    const result = await dispatchOnboardingResearchAgents({ id: "client_1", name: "Acme Corp", agentsRepoSlug: "acme" });

    expect("skipped" in result.seoGeo).toBe(false);
    expect("skipped" in result.intelReport).toBe(false);
    expect(publishAgentEngineRunMock).toHaveBeenCalledWith(expect.objectContaining({ productId: "seo-geo-agent", clientSlug: "acme" }));
    expect(publishAgentEngineRunMock).toHaveBeenCalledWith(expect.objectContaining({ productId: "intel-report-agent", clientSlug: "acme" }));
  });

  it("skips both, without touching Firestore, when the client has no agentsRepoSlug", async () => {
    const result = await dispatchOnboardingResearchAgents({ id: "client_1", name: "Acme Corp", agentsRepoSlug: undefined });

    expect(result.seoGeo).toMatchObject({ skipped: true });
    expect(result.intelReport).toMatchObject({ skipped: true });
    expect(createJobMock).not.toHaveBeenCalled();
  });
});
