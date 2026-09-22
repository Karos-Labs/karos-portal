import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import { AgentEngineRequestError, resolveAgentEngineGate } from "../client";
import { autoApproveDeadlineMs, parseGateDurationMs, type AgentEngineGateRecord, type AgentEngineStepRecord } from "../read-run";

/**
 * `request()` used to log what agent-engine said and throw a sentence that did
 * not contain it. Every reader downstream — the gate action, the reviewer —
 * got "Agent engine request failed (409). Please try again or contact
 * support." whatever the reason. It now keeps the engine's `error`, its
 * `code` and the rest of the body on a typed error.
 */

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AGENT_ENGINE_URL", "https://engine.example.test");
  vi.stubEnv("AGENT_ENGINE_AUDIENCE", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("request() keeps what the engine said", () => {
  it("parses a structured 409 into code, detail and body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          error: 'gate "r0" on run "x" was already resolved (decision: "approve")',
          code: "GATE_ALREADY_RESOLVED",
          runStatus: "awaiting_gate",
          resolvedDecision: "approve",
          resolvedBy: "system:gate-timeout",
          resolvedAt: "2026-09-22T17:05:00Z",
        }),
    });
    const err = await resolveAgentEngineGate("x", "r0", { decision: "revise", actor: "me", notes: "n", feedback: "n" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentEngineRequestError);
    const e = err as AgentEngineRequestError;
    expect(e.name).toBe("AgentEngineRequestError");
    expect(e.status).toBe(409);
    expect(e.code).toBe("GATE_ALREADY_RESOLVED");
    expect(e.detail).toMatch(/already resolved/);
    expect(e.body.resolvedBy).toBe("system:gate-timeout");
    // The message a screen shows carries the engine's sentence.
    expect(e.message).toMatch(/already resolved/);
  });

  it("an unknown code is dropped rather than trusted; a non-JSON body still yields a usable error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, text: async () => JSON.stringify({ error: "x", code: "SOMETHING_NEW" }) });
    const e1 = (await resolveAgentEngineGate("x", "r0", { decision: "approve", actor: "me" }).catch((e: unknown) => e)) as AgentEngineRequestError;
    expect(e1.code).toBeUndefined();
    expect(e1.detail).toBe("x");

    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" });
    const e2 = (await resolveAgentEngineGate("x", "r0", { decision: "approve", actor: "me" }).catch((e: unknown) => e)) as AgentEngineRequestError;
    expect(e2.status).toBe(502);
    expect(e2.detail).toBeUndefined();
    expect(e2.message).toMatch(/failed \(502\)/);
  });

  it("a fetch severed by the timeout becomes TIMEOUT, not a raw DOMException message", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);
    const e = (await resolveAgentEngineGate("x", "r0", { decision: "approve", actor: "me" }).catch((e: unknown) => e)) as AgentEngineRequestError;
    expect(e).toBeInstanceOf(AgentEngineRequestError);
    expect(e.code).toBe("TIMEOUT");
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/did not answer within 30 seconds/);
  });

  it("a 202 (decision recorded, continuation handed to the worker) is a success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({ runId: "x", status: "awaiting_gate", continuation: "enqueued" }) });
    await expect(resolveAgentEngineGate("x", "r0", { decision: "approve", actor: "me" })).resolves.toMatchObject({ continuation: "enqueued" });
  });
});

describe("autoApproveDeadlineMs — when an open gate will decide itself", () => {
  const gate = (timeout: AgentEngineGateRecord["timeout"]): AgentEngineGateRecord => ({
    gateId: "pubsub-1__09a-batch-review-r0",
    runId: "pubsub-1",
    kind: "batch_review",
    payload: {},
    requiredRole: "reviewer",
    ...(timeout ? { timeout } : {}),
  });
  const step = (stepId: string, startedAt: number): AgentEngineStepRecord => ({ stepId, kind: "gate", status: "running", startedAt });

  it("is the gate step's start plus the window", () => {
    const opened = Date.UTC(2026, 8, 22, 16, 5);
    expect(autoApproveDeadlineMs(gate({ duration: "1h", onTimeout: "auto_approve" }), [step("09a-batch-review-r0", opened)])).toBe(opened + 3_600_000);
  });

  it("finds a fan-out slot's scoped step too", () => {
    const opened = 1_000;
    expect(autoApproveDeadlineMs(gate({ duration: "30m", onTimeout: "auto_approve" }), [step("slot-2::09a-batch-review-r0", opened)])).toBe(opened + 1_800_000);
  });

  it("is undefined for a hold gate, an unparseable duration, or no step to date it from", () => {
    expect(autoApproveDeadlineMs(gate({ duration: "24h", onTimeout: "hold" }), [step("09a-batch-review-r0", 1)])).toBeUndefined();
    expect(autoApproveDeadlineMs(gate({ duration: "soon", onTimeout: "auto_approve" }), [step("09a-batch-review-r0", 1)])).toBeUndefined();
    expect(autoApproveDeadlineMs(gate({ duration: "1h", onTimeout: "auto_approve" }), [])).toBeUndefined();
    expect(autoApproveDeadlineMs(gate(undefined), [step("09a-batch-review-r0", 1)])).toBeUndefined();
  });

  it("parses the engine's duration grammar", () => {
    expect(parseGateDurationMs("1h")).toBe(3_600_000);
    expect(parseGateDurationMs("6h")).toBe(21_600_000);
    expect(parseGateDurationMs("45s")).toBe(45_000);
    expect(parseGateDurationMs("7d")).toBe(604_800_000);
    expect(parseGateDurationMs("1 week")).toBeUndefined();
  });
});
