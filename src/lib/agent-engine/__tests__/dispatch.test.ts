import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  createJobMock,
  updateJobMock,
  publishAgentEngineRunMock,
  dispatchViaMiddlewareMock,
  middlewareEnabledMock,
  pubsubConfiguredMock,
} = vi.hoisted(() => ({
  createJobMock: vi.fn(),
  updateJobMock: vi.fn(),
  publishAgentEngineRunMock: vi.fn(),
  dispatchViaMiddlewareMock: vi.fn(),
  middlewareEnabledMock: vi.fn(() => false),
  pubsubConfiguredMock: vi.fn(() => true),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ createJob: createJobMock, updateJob: updateJobMock }));
vi.mock("../pubsub-client", () => ({
  isAgentEnginePubSubConfigured: pubsubConfiguredMock,
  publishAgentEngineRun: publishAgentEngineRunMock,
  agentEngineRunIdFromMessageId: (messageId: string) => `pubsub-${messageId}`,
}));
// The error class is kept REAL: the fallback decision reads `shouldFallBack`
// off it, so a stubbed stand-in would let the behaviour under test drift from
// the class that actually ships.
vi.mock("../middleware-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware-client")>()),
  isMiddlewareDispatchEnabled: middlewareEnabledMock,
  dispatchViaMiddleware: dispatchViaMiddlewareMock,
}));

import { MiddlewareDispatchError } from "../middleware-client";
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

describe("dispatchAgentEngineRun transport selection", () => {
  beforeEach(() => {
    createJobMock.mockReset().mockResolvedValue("job_1");
    updateJobMock.mockReset();
    publishAgentEngineRunMock.mockReset();
    dispatchViaMiddlewareMock.mockReset();
    middlewareEnabledMock.mockReset().mockReturnValue(false);
  });

  const base = {
    clientId: "client_1",
    clientSlug: "acme",
    productId: "instagram-agent",
    runKind: "recurring" as const,
    agentName: "Instagram",
    title: "Test",
  };

  it("publishes directly when the middleware flag is off", async () => {
    publishAgentEngineRunMock.mockResolvedValue({ messageId: "msg_direct" });

    const result = await dispatchAgentEngineRun(base);

    expect(publishAgentEngineRunMock).toHaveBeenCalledOnce();
    expect(dispatchViaMiddlewareMock).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: "job_1", agentEngineRunId: "pubsub-msg_direct" });
  });

  it("routes through the control plane when the flag is on, and never also publishes", async () => {
    middlewareEnabledMock.mockReturnValue(true);
    dispatchViaMiddlewareMock.mockResolvedValue({
      pubsubMessageId: "msg_mw",
      middlewareRunId: "run_mw",
    });

    const result = await dispatchAgentEngineRun(base);

    expect(dispatchViaMiddlewareMock).toHaveBeenCalledOnce();
    // Double-dispatching would run the client's job twice and bill it twice.
    expect(publishAgentEngineRunMock).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: "job_1", agentEngineRunId: "pubsub-msg_mw" });
  });

  it("derives the SAME run id shape from either transport", async () => {
    // Everything downstream (reconcile, materialize, the job page) reads
    // agentEngineRuns/{pubsub-<messageId>}; switching transport must not
    // change the key those depend on.
    publishAgentEngineRunMock.mockResolvedValue({ messageId: "same_id" });
    const direct = await dispatchAgentEngineRun(base);

    createJobMock.mockResolvedValue("job_1");
    middlewareEnabledMock.mockReturnValue(true);
    dispatchViaMiddlewareMock.mockResolvedValue({
      pubsubMessageId: "same_id",
      middlewareRunId: "run_mw",
    });
    const viaMiddleware = await dispatchAgentEngineRun(base);

    expect(direct).toEqual(viaMiddleware);
  });

  it("marks the job failed when the control plane rejects the dispatch", async () => {
    middlewareEnabledMock.mockReturnValue(true);
    dispatchViaMiddlewareMock.mockRejectedValue(new Error("Agent middleware dispatch failed (422)."));

    const result = await dispatchAgentEngineRun(base);

    expect(result).toEqual({ jobId: "job_1", error: "Agent middleware dispatch failed (422)." });
    expect(updateJobMock).toHaveBeenCalledWith("job_1", expect.objectContaining({ status: "failed" }));
  });

  it("still dispatches via the control plane when Pub/Sub is not configured locally", async () => {
    // The middleware owns the topic in that mode; this repo needs no topic env.
    middlewareEnabledMock.mockReturnValue(true);
    pubsubConfiguredMock.mockReturnValueOnce(false);
    dispatchViaMiddlewareMock.mockResolvedValue({
      pubsubMessageId: "msg_mw",
      middlewareRunId: "run_mw",
    });

    const result = await dispatchAgentEngineRun(base);

    expect(result).toEqual({ jobId: "job_1", agentEngineRunId: "pubsub-msg_mw" });
  });
});

describe("dispatchAgentEngineRun middleware fallback", () => {
  beforeEach(() => {
    createJobMock.mockReset().mockResolvedValue("job_1");
    updateJobMock.mockReset();
    publishAgentEngineRunMock.mockReset().mockResolvedValue({ messageId: "msg_direct" });
    dispatchViaMiddlewareMock.mockReset();
    middlewareEnabledMock.mockReset().mockReturnValue(true);
    pubsubConfiguredMock.mockReset().mockReturnValue(true);
  });

  const base = {
    clientId: "client_1",
    clientSlug: "acme",
    productId: "landing-builder-agent",
    runKind: "recurring" as const,
    agentName: "Landing",
    title: "Test",
  };

  function middlewareFailure(status: number | undefined, shouldFallBack: boolean) {
    return new MiddlewareDispatchError(`boom (${status ?? "network"})`, { ...(status !== undefined ? { status } : {}), shouldFallBack });
  }

  it.each([
    ["network error", undefined],
    ["401 unauthenticated", 401],
    ["403 forbidden", 403],
    ["404 agent not seeded", 404],
    ["429 rate limited", 429],
    ["500 middleware broken", 500],
    ["503 middleware restarting", 503],
  ])("falls back to direct publish on %s so the job is never orphaned", async (_label, status) => {
    dispatchViaMiddlewareMock.mockRejectedValue(middlewareFailure(status, true));

    const result = await dispatchAgentEngineRun(base);

    expect(result).toEqual({ jobId: "job_1", agentEngineRunId: "pubsub-msg_direct" });
    expect(publishAgentEngineRunMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["409 duplicate run — publishing again would run the job twice", 409],
    ["422 agent has no active prompt — the exact thing the control plane catches", 422],
    ["400 malformed request", 400],
  ])("does NOT fall back on %s", async (_label, status) => {
    dispatchViaMiddlewareMock.mockRejectedValue(middlewareFailure(status, false));

    const result = await dispatchAgentEngineRun(base);

    expect(publishAgentEngineRunMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ jobId: "job_1" });
    expect(result).toHaveProperty("error");
    expect(updateJobMock).toHaveBeenCalledWith("job_1", expect.objectContaining({ status: "failed" }));
  });

  it("records the degradation on the job, not just in the log", async () => {
    dispatchViaMiddlewareMock.mockRejectedValue(middlewareFailure(503, true));

    await dispatchAgentEngineRun(base);

    const patch = updateJobMock.mock.calls.at(-1)![1];
    expect(patch.agentEngineRunId).toBe("pubsub-msg_direct");
    // Whoever reviews the output needs to know it ran without a resolved
    // prompt version; a log line alone would not reach them.
    expect(JSON.stringify(patch.events)).toContain("Degraded dispatch");
  });

  it("emits a structured warning a log-based metric can count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatchViaMiddlewareMock.mockRejectedValue(middlewareFailure(500, true));

    await dispatchAgentEngineRun(base);

    const logged = JSON.parse(String(warn.mock.calls[0]![0]));
    expect(logged).toMatchObject({
      severity: "WARNING",
      message: "agent-engine dispatch fell back to direct Pub/Sub",
      status: 500,
      jobId: "job_1",
      clientSlug: "acme",
      productId: "landing-builder-agent",
    });
    warn.mockRestore();
  });

  it("fails cleanly when neither transport is available", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatchViaMiddlewareMock.mockRejectedValue(middlewareFailure(503, true));
    pubsubConfiguredMock.mockReturnValue(false);

    const result = await dispatchAgentEngineRun(base);

    expect(publishAgentEngineRunMock).not.toHaveBeenCalled();
    expect(result).toHaveProperty("error");
  });

  it("does not fall back on a plain non-middleware error", async () => {
    // A bug in our own code must not be misread as "the control plane is down".
    dispatchViaMiddlewareMock.mockRejectedValue(new TypeError("undefined is not a function"));

    const result = await dispatchAgentEngineRun(base);

    expect(publishAgentEngineRunMock).not.toHaveBeenCalled();
    expect(result).toHaveProperty("error");
  });
});
