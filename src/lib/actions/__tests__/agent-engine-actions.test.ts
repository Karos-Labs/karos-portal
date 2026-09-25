/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";

/**
 * IGSTYLE-6, §2.5 — action-level coverage for `resolveAgentEngineGateAction`'s
 * own named acceptance line: "a style-only `revise` reaches
 * `resolveAgentEngineGate` intact." Before this ticket, `edits` was forwarded
 * to the engine only on `decision: "approve"`; a reviewer's colour pick made
 * while requesting a revision was silently dropped. This file proves the
 * fix directly against the real `resolveAgentEngineGateAction`, mocking only
 * its three dependencies (`@/lib/data`, `@/lib/actions/_shared`,
 * `@/lib/agent-engine/client`) so the actual approve/revise/reject
 * edits-filtering logic under test runs for real.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");

const requireStaffMock = vi.fn();
vi.mock("@/lib/actions/_shared", () => ({
  requireStaff: (...args: unknown[]) => requireStaffMock(...args),
}));

const resolveAgentEngineGateMock = vi.fn();
vi.mock("@/lib/agent-engine/client", () => ({
  resolveAgentEngineGate: (...args: unknown[]) => resolveAgentEngineGateMock(...args),
  AgentEngineCredentialError: class FakeAgentEngineCredentialError extends Error {},
}));

const recordGateDecisionMock = vi.fn();
vi.mock("@/lib/agent-engine/learning-feedback", () => ({
  recordGateDecisionToLearning: (...args: unknown[]) => recordGateDecisionMock(...args),
}));

import { resolveAgentEngineGateAction } from "../agent-engine-actions";

const STAFF_USER = { uid: "u-staff", email: "staff@karoslabs.test", name: "Staff User", role: "KAROS_EMPLOYEE" } as any;
const JOB = { id: "job1", agentEngineRunId: "run_1" } as any;

const STYLE_EDIT = { ground: "#000000", fg: "#eeeeee" };

beforeEach(() => {
  requireStaffMock.mockReset().mockResolvedValue(STAFF_USER);
  (data.getJob as any).mockReset().mockResolvedValue(JOB);
  resolveAgentEngineGateMock.mockReset().mockResolvedValue({ runId: "run_1", status: "running" });
  recordGateDecisionMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("resolveAgentEngineGateAction — style edits reach the engine on both approve and revise", () => {
  it("a style-only revise reaches resolveAgentEngineGate intact", async () => {
    const res = await resolveAgentEngineGateAction("job1", "gate1", {
      decision: "revise",
      notes: "Try a darker background",
      edits: { style: STYLE_EDIT },
    });

    expect(res).toEqual({});
    expect(resolveAgentEngineGateMock).toHaveBeenCalledTimes(1);
    const [runId, gateId, resolution] = resolveAgentEngineGateMock.mock.calls[0];
    expect(runId).toBe("run_1");
    expect(gateId).toBe("gate1");
    expect(resolution).toMatchObject({
      decision: "revise",
      edits: { style: STYLE_EDIT },
    });
  });

  it("a revise with style AND caption/slides strips caption/slides but keeps style", async () => {
    await resolveAgentEngineGateAction("job1", "gate1", {
      decision: "revise",
      notes: "Try a darker background",
      edits: { style: STYLE_EDIT, caption: "hand-typed caption", slides: [{ n: 1, fields: { headline: "x" } }] },
    });

    const [, , resolution] = resolveAgentEngineGateMock.mock.calls[0];
    expect(resolution.edits).toEqual({ style: STYLE_EDIT });
  });

  it("a revise with no style pick at all sends no edits key", async () => {
    await resolveAgentEngineGateAction("job1", "gate1", {
      decision: "revise",
      notes: "Try a darker background",
    });

    const [, , resolution] = resolveAgentEngineGateMock.mock.calls[0];
    expect(resolution.edits).toBeUndefined();
  });

  it("an approve with a style pick forwards it alongside caption/slides, unchanged from before this ticket", async () => {
    await resolveAgentEngineGateAction("job1", "gate1", {
      decision: "approve",
      edits: { style: STYLE_EDIT, caption: "final caption", slides: [{ n: 1, fields: { headline: "x" } }] },
    });

    const [, , resolution] = resolveAgentEngineGateMock.mock.calls[0];
    expect(resolution.edits).toEqual({
      style: STYLE_EDIT,
      caption: "final caption",
      slides: [{ n: 1, fields: { headline: "x" } }],
    });
  });

  it("a reject never forwards edits, style included, even if the caller included one", async () => {
    await resolveAgentEngineGateAction("job1", "gate1", {
      decision: "reject",
      notes: "Wrong brief entirely",
      edits: { style: STYLE_EDIT },
    });

    const [, , resolution] = resolveAgentEngineGateMock.mock.calls[0];
    expect(resolution.edits).toBeUndefined();
  });

  it("an approve with only caption/slides (no style) still forwards edits exactly as before this ticket", async () => {
    await resolveAgentEngineGateAction("job1", "gate1", {
      decision: "approve",
      edits: { caption: "final caption" },
    });

    const [, , resolution] = resolveAgentEngineGateMock.mock.calls[0];
    expect(resolution.edits).toEqual({ caption: "final caption" });
  });
});

describe("resolveAgentEngineGateAction — the reviewer's words reach the learning loop", () => {
  const LOOP_JOB = { id: "job1", agentEngineRunId: "run_1", agentEngineProductId: "tiktok-clipping-agent", clientId: "c1" } as any;

  it("records the decision and the note once the engine has accepted it, without the rating", async () => {
    (data.getJob as any).mockResolvedValue(LOOP_JOB);
    const res = await resolveAgentEngineGateAction("job1", "11-clip-review-r0", { decision: "revise", notes: "Lead with the disagreement.", rating: 2 });
    expect(res).toEqual({});
    expect(recordGateDecisionMock).toHaveBeenCalledTimes(1);
    expect(recordGateDecisionMock.mock.calls[0]![0]).toEqual({
      clientId: "c1",
      productId: "tiktok-clipping-agent",
      runId: "run_1",
      gateId: "11-clip-review-r0",
      decision: "revise",
      notes: "Lead with the disagreement.",
      actor: "Staff User",
    });
  });

  it("records nothing when the engine refused the decision", async () => {
    (data.getJob as any).mockResolvedValue(LOOP_JOB);
    resolveAgentEngineGateMock.mockRejectedValueOnce(new Error("boom"));
    const res = await resolveAgentEngineGateAction("job1", "11-clip-review-r0", { decision: "revise", notes: "x" });
    expect(res.error).toBeDefined();
    expect(recordGateDecisionMock).not.toHaveBeenCalled();
  });
});
