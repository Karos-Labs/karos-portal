/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";

/**
 * The 409 that said nothing (22 Sept 2026, prep, Instagram run
 * pubsub-21936957999643915): "Request changes" on a gate that had already
 * been decided answered `Agent engine request failed (409). Please try again
 * or contact support.` — three times, buttons still lit. agent-engine now
 * sends a `code` and the record behind it; this proves the action turns each
 * one into a sentence about what the run is actually doing, and flags the
 * panel as stale so it stops offering the same buttons.
 */

vi.mock("server-only", () => ({}));
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePathMock(...args) }));
vi.mock("@/lib/data");

const requireStaffMock = vi.fn();
vi.mock("@/lib/actions/_shared", () => ({
  requireStaff: (...args: unknown[]) => requireStaffMock(...args),
}));

/** The real class's shape, by NAME — the action matches on `name`, not the class, exactly so a mock like this one is enough. */
class FakeAgentEngineRequestError extends Error {
  readonly name = "AgentEngineRequestError";
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
    readonly detail?: string,
  ) {
    super(detail ? `Agent engine request failed (${status}): ${detail}` : `Agent engine request failed (${status}).`);
  }
}

const resolveAgentEngineGateMock = vi.fn();
// No `AgentEngineRequestError` export in the mock, on purpose: the action must
// recognise the error by NAME alone, which is the whole point of the fake above.
vi.mock("@/lib/agent-engine/client", () => ({
  resolveAgentEngineGate: (...args: unknown[]) => resolveAgentEngineGateMock(...args),
  AgentEngineCredentialError: class FakeAgentEngineCredentialError extends Error {},
}));

import { resolveAgentEngineGateAction } from "../agent-engine-actions";

const STAFF_USER = { uid: "u-staff", email: "staff@karoslabs.test", name: "Staff User", role: "KAROS_EMPLOYEE" } as any;
const JOB = { id: "job1", agentEngineRunId: "pubsub-21936957999643915" } as any;
const GATE = "pubsub-21936957999643915__09a-batch-review-r0";

beforeEach(() => {
  requireStaffMock.mockReset().mockResolvedValue(STAFF_USER);
  (data.getJob as any).mockReset().mockResolvedValue(JOB);
  resolveAgentEngineGateMock.mockReset();
  revalidatePathMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("resolveAgentEngineGateAction — the engine's structured 409s become sentences a reviewer can act on", () => {
  it("GATE_ALREADY_RESOLVED by the timeout: says the draft approved itself, when, and that the note was not applied", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(
      new FakeAgentEngineRequestError(409, "GATE_ALREADY_RESOLVED", {
        error: "already resolved",
        code: "GATE_ALREADY_RESOLVED",
        runStatus: "awaiting_gate",
        resolvedDecision: "approve",
        resolvedBy: "system:gate-timeout",
        resolvedAt: "2026-09-22T17:05:00Z",
        continuation: "enqueued",
      }),
    );
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "revise", notes: "Shorter hook" });
    expect(res.stale).toBe(true);
    expect(res.error).toMatch(/approved itself/);
    expect(res.error).toMatch(/20:05/); // 17:05Z in Asia/Jerusalem
    expect(res.error).toMatch(/note was not applied/);
    expect(res.error).not.toMatch(/try again/i);
    expect(revalidatePathMock).toHaveBeenCalledWith("/jobs/job1");
  });

  it("GATE_ALREADY_RESOLVED by a person: names them and their decision", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(
      new FakeAgentEngineRequestError(409, "GATE_ALREADY_RESOLVED", {
        code: "GATE_ALREADY_RESOLVED",
        runStatus: "awaiting_gate",
        resolvedDecision: "reject",
        resolvedBy: "dana@karoslabs.com",
        resolvedAt: "2026-09-22T17:05:00Z",
      }),
    );
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "approve" });
    expect(res.stale).toBe(true);
    expect(res.error).toMatch(/rejected by dana@karoslabs.com/);
  });

  it("RUN_NOT_AWAITING_GATE while running: says the run is already continuing and nothing needs redoing", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(
      new FakeAgentEngineRequestError(409, "RUN_NOT_AWAITING_GATE", { code: "RUN_NOT_AWAITING_GATE", runStatus: "running" }),
    );
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "approve" });
    expect(res.stale).toBe(true);
    expect(res.error).toMatch(/already continuing/);
  });

  it("RUN_NOT_AWAITING_GATE on a finished run: says so in words, not a status token", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(
      new FakeAgentEngineRequestError(409, "RUN_NOT_AWAITING_GATE", { code: "RUN_NOT_AWAITING_GATE", runStatus: "degraded" }),
    );
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "approve" });
    expect(res.error).toMatch(/stopped on an error/);
  });

  it("GATE_NOT_PENDING: the page is a round behind", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(
      new FakeAgentEngineRequestError(409, "GATE_NOT_PENDING", { code: "GATE_NOT_PENDING", runStatus: "awaiting_gate", pendingGateId: `${JOB.agentEngineRunId}__09a-batch-review-r1` }),
    );
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "approve" });
    expect(res.stale).toBe(true);
    expect(res.error).toMatch(/newer review round/);
  });

  it("RUN_BUSY: the decision was recorded; nothing to redo", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(new FakeAgentEngineRequestError(409, "RUN_BUSY", { code: "RUN_BUSY", runStatus: "running" }));
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "approve" });
    expect(res.stale).toBe(true);
    expect(res.error).toMatch(/was recorded/);
  });

  it("TIMEOUT: says the decision may have landed, and is NOT stale (the gate may well still be open)", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(new FakeAgentEngineRequestError(0, "TIMEOUT", {}, "did not answer"));
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "approve" });
    expect(res.stale).toBeUndefined();
    expect(res.error).toMatch(/did not answer in time/);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("an engine error with no code still shows the engine's own sentence rather than a generic one", async () => {
    resolveAgentEngineGateMock.mockRejectedValue(new FakeAgentEngineRequestError(500, undefined, { error: "run has an unresumable productId" }, "run has an unresumable productId"));
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "approve" });
    expect(res.error).toMatch(/unresumable productId/);
    expect(res.stale).toBeUndefined();
  });

  it("a 202 from the engine is success, exactly as a 200 was", async () => {
    resolveAgentEngineGateMock.mockResolvedValue({ runId: JOB.agentEngineRunId, status: "awaiting_gate", continuation: "enqueued", decisionOutcome: "recorded" });
    const res = await resolveAgentEngineGateAction("job1", GATE, { decision: "revise", notes: "Shorter hook" });
    expect(res).toEqual({});
  });
});
