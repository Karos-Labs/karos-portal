import { describe, expect, it } from "vitest";
import { buildStepBreakdown } from "@/lib/jobs/step-breakdown";
import type { DynamicAgentRunReport } from "@/lib/types";

describe("buildStepBreakdown", () => {
  it("maps a done step's usage into cost/token fields, in USD — never a credits figure", () => {
    const report: DynamicAgentRunReport = {
      specId: "spec-1",
      specVersion: 1,
      steps: [
        {
          stepId: "a",
          type: "ai",
          label: "Research",
          status: "done",
          durationMs: 1234,
          model: "claude-sonnet",
          usage: {
            totalCostUsd: 0.05,
            models: {
              "claude-sonnet": { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.05 },
            },
          },
        },
      ],
    };
    expect(buildStepBreakdown(report)).toEqual([
      {
        stepId: "a",
        stepName: "Research",
        stepType: "ai",
        inputTokens: 100,
        outputTokens: 40,
        costUsd: 0.05,
        modelUsed: "claude-sonnet",
        durationMs: 1234,
        status: "completed",
      },
    ]);
  });

  it("maps a failed step's status, and omits token/cost fields when there is no usage (a code step, or a step that never called the SDK)", () => {
    const report: DynamicAgentRunReport = {
      specId: "spec-1",
      specVersion: 1,
      steps: [{ stepId: "b", type: "code", label: "Reshape", status: "failed", durationMs: 40 }],
    };
    expect(buildStepBreakdown(report)).toEqual([
      { stepId: "b", stepName: "Reshape", stepType: "code", durationMs: 40, status: "failed" },
    ]);
  });

  it("sums multiple models' tokens within one step", () => {
    const report: DynamicAgentRunReport = {
      specId: "spec-1",
      specVersion: 1,
      steps: [
        {
          stepId: "a",
          type: "ai",
          label: "Research",
          status: "done",
          durationMs: 10,
          usage: {
            models: {
              m1: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
              m2: { inputTokens: 20, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            },
          },
        },
      ],
    };
    const [row] = buildStepBreakdown(report);
    expect(row).toMatchObject({ inputTokens: 30, outputTokens: 13 });
  });

  it("falls back to stepId for stepName when label is empty", () => {
    const report: DynamicAgentRunReport = {
      specId: "spec-1",
      specVersion: 1,
      steps: [{ stepId: "unlabeled-step", type: "ai", label: "", status: "done", durationMs: 5 }],
    };
    expect(buildStepBreakdown(report)[0]?.stepName).toBe("unlabeled-step");
  });

  it("is total and order-preserving: one output row per input step, same order", () => {
    const report: DynamicAgentRunReport = {
      specId: "spec-1",
      specVersion: 1,
      steps: [
        { stepId: "a", type: "ai", label: "A", status: "done", durationMs: 1 },
        { stepId: "b", type: "code", label: "B", status: "failed", durationMs: 2 },
      ],
    };
    expect(buildStepBreakdown(report).map((s) => s.stepId)).toEqual(["a", "b"]);
  });
});
