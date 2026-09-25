import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A reviewer's words at the engine's review gate reach the learning loop.
 *
 * The gate is the only review surface Instagram, TikTok and branded-shorts
 * have. Before this, a note typed there steered that run's redraft and was
 * then forgotten: nothing wrote it to `client_feedback_log`, so the next run's
 * `clientFeedback` was empty and the middleware derived nothing from it.
 */

const { fetchMock, baseUrlMock, getClientMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  baseUrlMock: vi.fn(),
  getClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../middleware-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware-http")>()),
  middlewareBaseUrl: baseUrlMock,
  middlewareFetch: fetchMock,
}));
vi.mock("@/lib/data", () => ({ getClient: getClientMock }));

import { recordGateDecisionToLearning } from "../learning-feedback";

const BASE = {
  clientId: "client-1",
  productId: "instagram-agent",
  runId: "pubsub-42",
  gateId: "09a-batch-review-r0",
  actor: "Jane",
} as const;

function sentBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
  expect(path).toBe("/clients/acme/learning/feedback");
  expect(init.method).toBe("POST");
  return init.body;
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ duplicate: false });
  baseUrlMock.mockReset().mockReturnValue("https://middleware.test");
  getClientMock.mockReset().mockResolvedValue({ id: "client-1", agentsRepoSlug: "acme" });
});

describe("recordGateDecisionToLearning", () => {
  it("a revise is a change request, filed against the run, once per round", async () => {
    await recordGateDecisionToLearning({ ...BASE, decision: "revise", notes: "  Less jargon on slide one.  " });
    expect(sentBody()).toMatchObject({
      platform: "instagram",
      action: "change_requested",
      runId: "pubsub-42",
      reason: "Less jargon on slide one.",
      actor: "Jane",
      sourceId: "pubsub-42:09a-batch-review-r0:change_requested",
    });
  });

  it("a reject is a skip with its reason", async () => {
    await recordGateDecisionToLearning({ ...BASE, productId: "tiktok-clipping-agent", gateId: "11-clip-review-r1", decision: "reject", notes: "Off-brand topic." });
    expect(sentBody()).toMatchObject({ platform: "tiktok", action: "skipped", reason: "Off-brand topic.", sourceId: "pubsub-42:11-clip-review-r1:skipped" });
  });

  it("an approve with a note is a note; branded-shorts files under TikTok", async () => {
    await recordGateDecisionToLearning({ ...BASE, productId: "branded-shorts-agent", gateId: "10-delivery-review-r0", decision: "approve", notes: "Keep captions this short." });
    expect(sentBody()).toMatchObject({ platform: "tiktok", action: "note", reason: "Keep captions this short." });
  });

  it("writes nothing for an approve with no words, a product off the loop, or a client with no engine slug", async () => {
    await recordGateDecisionToLearning({ ...BASE, decision: "approve", notes: undefined });
    await recordGateDecisionToLearning({ ...BASE, decision: "revise", notes: "   " });
    await recordGateDecisionToLearning({ ...BASE, productId: "intel-report-agent", decision: "revise", notes: "x" });
    getClientMock.mockResolvedValueOnce({ id: "client-1" });
    await recordGateDecisionToLearning({ ...BASE, decision: "revise", notes: "x" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws: a control plane that is down costs the lesson, not the decision", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    getClientMock.mockRejectedValueOnce(new Error("firestore down"));
    await expect(recordGateDecisionToLearning({ ...BASE, decision: "revise", notes: "x" })).resolves.toBeUndefined();
    await expect(recordGateDecisionToLearning({ ...BASE, decision: "revise", notes: "x" })).resolves.toBeUndefined();
  });
});
