import { describe, expect, it } from "vitest";
import { agentEngineStepStatusBadge } from "../step-status";
import type { AgentEngineStepRecord } from "../read-run";

/**
 * AU68 (SCRUM-366), karosCMO's half.
 *
 * agent-engine's producers now record a returned tool/agent failure honestly
 * instead of persisting it as `completed`. This repo is the consumer named in
 * the ticket, and its job is to display that verdict ONCE and without
 * re-flattening it.
 *
 * The first test below FAILS TO COMPILE against `main`, which is the point:
 * `AgentEngineStepRecord["status"]` was `"running" | "completed" | "failed"`,
 * a union that had already gone stale when AU67 shipped `content_fail` /
 * `not_available` / `tooling_error` for `step.code`. Nothing in this repo
 * PARSES these records — the type is a description of what Firestore holds —
 * so nothing was ever going to notice at runtime.
 */
describe("SCRUM-366: the record type describes what agent-engine actually writes", () => {
  it("accepts every status agent-engine's StepRecordSchema can persist", () => {
    // Mirrors packages/workflow/src/adapters/types.ts's `StepRecordSchema.status`
    // enum, verbatim and in order. A value the engine can write that this union
    // rejects is a compile error HERE, which is the only place it can be one.
    const engineStatuses: ReadonlyArray<AgentEngineStepRecord["status"]> = [
      "running",
      "completed",
      "content_fail",
      "not_available",
      "tooling_error",
      "budget_exceeded",
      "failed",
    ];
    expect(engineStatuses).toHaveLength(7);
  });
});

describe("SCRUM-366: a widened vocabulary is not re-flattened on display", () => {
  const step = (over: Partial<AgentEngineStepRecord>): Pick<AgentEngineStepRecord, "status" | "kind" | "error"> => ({
    status: "completed",
    kind: "code",
    ...over,
  });

  it("paints a real fault red", () => {
    expect(agentEngineStepStatusBadge(step({ status: "tooling_error", error: "browserType.launch: Timeout" }))).toEqual({
      tone: "danger",
      label: "browserType.launch: Timeout",
    });
    expect(agentEngineStepStatusBadge(step({ status: "failed" })).tone).toBe("danger");
  });

  it("does NOT paint a designed, expected state red", () => {
    // The engine spent two tickets refusing to collapse these into "failed".
    // A display that paints them all "Failed" reintroduces the conflation from
    // the other end, and a healthy revision loop reads as a broken run.
    for (const status of ["content_fail", "not_available", "budget_exceeded"] as const) {
      const badge = agentEngineStepStatusBadge(step({ status, kind: "agent" }));
      expect(badge.tone, `${status} is not a fault`).toBe("warning");
      expect(badge.label, `${status} must not be labelled "Failed"`).not.toBe("Failed");
    }
  });

  it("still says Done for a completed step, and distinguishes a waiting gate from a busy step", () => {
    expect(agentEngineStepStatusBadge(step({ status: "completed" }))).toEqual({ tone: "success", label: "Done" });
    expect(agentEngineStepStatusBadge(step({ status: "running", kind: "gate" })).label).toBe("Awaiting review");
    expect(agentEngineStepStatusBadge(step({ status: "running", kind: "code" })).label).toBe("Running…");
  });

  it("carries the step's own reason when it has one, so a red badge says why", () => {
    expect(agentEngineStepStatusBadge(step({ status: "tooling_error", error: "529 overloaded_error" })).label).toBe("529 overloaded_error");
    expect(agentEngineStepStatusBadge(step({ status: "tooling_error" })).label).toBe("Tool failed");
  });
});
