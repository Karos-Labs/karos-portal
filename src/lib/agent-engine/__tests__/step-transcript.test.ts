import { describe, expect, it } from "vitest";

import { agentStepTranscript, runAgentTranscripts, stepOutputPreviews } from "../step-transcript";
import type { AgentEngineStepRecord } from "../read-run";

/**
 * Fixtures shaped like agent-engine's REAL recorded step output — an
 * `AgentExecutionResult` whose `steps` are `AgentStepTelemetry` records
 * (`agent-engine/packages/core/src/types/agent-step.ts`). Transcribed from an
 * actual prep run's `10-draft-post` checkpoint rather than invented, including
 * the two turn shapes that are easy to forget: the FINAL turn, which carries a
 * `thought` and no `toolCall` at all, and a zero-cost self-critique turn, which
 * carries a `toolCall` with `args: undefined`.
 */
function agentStep(overrides: Partial<AgentEngineStepRecord> = {}): AgentEngineStepRecord {
  return {
    stepId: "10-draft-post",
    kind: "agent",
    status: "completed",
    startedAt: 1000,
    completedAt: 2000,
    costUsd: 0.1215,
    durationMs: 72000,
    output: {
      status: "completed",
      totalCostUsd: 0.1215,
      totalTokens: { input: 41440, output: 1803 },
      finalOutput: { text: "B2B marketing automation is splitting into two camps.", lane: "build-in-public" },
      steps: [
        {
          stepIndex: 0,
          thought: "Before I draft, I need to flag a structural conflict with the account charter.",
          toolCall: {
            name: "render.preview",
            args: { text: "B2B marketing automation is splitting into two camps." },
            result: { status: "success", result: { withinLimit: true, characterCount: 244 } },
            toolVersion: "1.0.0",
          },
          modelUsed: "claude-sonnet-4-6",
          inputTokens: { cached: 0, uncached: 7739 },
          outputTokens: 446,
          durationMs: 12000,
          costUsd: 0.0299,
          status: "success",
        },
        {
          stepIndex: 1,
          thought: "The preview is within the limit. Running the lint gate.",
          toolCall: {
            name: "gate.lintPost",
            args: { platform: "x", checkAntiSlop: true },
            result: { status: "content_fail", reason: "banned phrase: game changer" },
            toolVersion: "1.0.0",
          },
          modelUsed: "claude-sonnet-4-6",
          inputTokens: { cached: 0, uncached: 8100 },
          outputTokens: 320,
          durationMs: 9000,
          costUsd: 0.0205,
          status: "success",
        },
        // The FINAL turn: reasoning, no tool call.
        {
          stepIndex: 2,
          thought: "Rewritten without the banned phrase. Returning the draft.",
          modelUsed: "claude-sonnet-4-6",
          inputTokens: { cached: 0, uncached: 9000 },
          outputTokens: 500,
          durationMs: 11000,
          costUsd: 0.0284,
          status: "success",
        },
        // A zero-cost self-critique turn: tool call with no args recorded.
        {
          stepIndex: 3,
          toolCall: { name: "gate.lintPost", args: undefined, result: { verdict: "pass" }, toolVersion: "1.0.0" },
          modelUsed: "claude-sonnet-4-6",
          inputTokens: { cached: 0, uncached: 0 },
          outputTokens: 0,
          durationMs: 40,
          costUsd: 0,
          status: "success",
        },
      ],
    },
    ...overrides,
  };
}

describe("agentStepTranscript", () => {
  it("turns each recorded telemetry turn into the same block shape <JobTranscript> already renders", () => {
    const transcript = agentStepTranscript(agentStep())!;
    expect(transcript.turns).toHaveLength(4);

    const first = transcript.turns[0]!;
    expect(first.role).toBe("assistant");
    expect(first.blocks.map((b) => b.kind)).toEqual(["thinking", "tool_use", "tool_result"]);
    expect(first.blocks[0]).toMatchObject({ kind: "thinking", text: expect.stringContaining("structural conflict") });
    // The tool version travels in the label so a reader can tell which build of
    // a gate produced a verdict.
    expect(first.blocks[1]).toMatchObject({ kind: "tool_use", name: "render.preview (v1.0.0)" });
    expect(first.blocks[2]).toMatchObject({ kind: "tool_result", isError: false });
  });

  it("marks a content_fail tool outcome as an error even though the TURN says success", () => {
    // Both facts are asked, and this is why: `AgentToolOutcome.status` and the
    // turn's own `status` are different scopes. A gate that refused the draft is
    // the single most important thing in a transcript, and the turn that called
    // it reports "success" — it successfully called the tool.
    const transcript = agentStepTranscript(agentStep())!;
    const lintResult = transcript.turns[1]!.blocks.find((b) => b.kind === "tool_result");
    expect(lintResult).toMatchObject({ isError: true });
    expect(lintResult && "text" in lintResult ? lintResult.text : "").toContain("game changer");
  });

  it("keeps a final turn that has reasoning but no tool call", () => {
    const transcript = agentStepTranscript(agentStep())!;
    expect(transcript.turns[2]!.blocks.map((b) => b.kind)).toEqual(["thinking"]);
  });

  it("keeps a tool turn that has no reasoning and no args", () => {
    const transcript = agentStepTranscript(agentStep())!;
    const blocks = transcript.turns[3]!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(["tool_use", "tool_result"]);
    expect(blocks[0]).toMatchObject({ input: undefined });
  });

  it("carries the execution status, totals and final output alongside the turns", () => {
    const transcript = agentStepTranscript(agentStep())!;
    expect(transcript.executionStatus).toBe("completed");
    expect(transcript.totalCostUsd).toBeCloseTo(0.1215, 4);
    expect(transcript.inputTokens).toBe(41440);
    expect(transcript.outputTokens).toBe(1803);
    expect(transcript.finalOutput).toContain("build-in-public");
  });

  it("surfaces a turn's own error, which is a different fact from a bad tool result", () => {
    const step = agentStep();
    (step.output as { steps: unknown[] }).steps = [
      { stepIndex: 0, modelUsed: "m", inputTokens: { cached: 0, uncached: 1 }, outputTokens: 0, durationMs: 1, costUsd: 0, status: "tooling_error", error: "prompt skillRef not found in store" },
    ];
    const transcript = agentStepTranscript(step)!;
    expect(transcript.turns[0]!.blocks).toEqual([
      { kind: "tool_result", text: "prompt skillRef not found in store", isError: true },
    ]);
  });

  it("truncates a huge tool result and says so, rather than shipping it whole to the browser", () => {
    const step = agentStep();
    (step.output as { steps: unknown[] }).steps = [
      {
        stepIndex: 0,
        toolCall: { name: "research.pull", args: {}, result: "x".repeat(50_000), toolVersion: "1.0.0" },
        modelUsed: "m",
        inputTokens: { cached: 0, uncached: 1 },
        outputTokens: 0,
        durationMs: 1,
        costUsd: 0,
        status: "success",
      },
    ];
    const transcript = agentStepTranscript(step)!;
    expect(transcript.truncated).toBe(true);
    const result = transcript.turns[0]!.blocks.find((b) => b.kind === "tool_result");
    expect(result && "text" in result ? result.text.length : 0).toBeLessThan(13_000);
  });

  it("returns undefined for a step that is not an agent execution at all", () => {
    // Ordinary states, not errors: a code step, a step still running, and an
    // output offloaded to GCS.
    expect(agentStepTranscript({ stepId: "01-x", kind: "code", status: "completed", startedAt: 1, output: { topics: [] } })).toBeUndefined();
    expect(agentStepTranscript({ stepId: "10-draft", kind: "agent", status: "running", startedAt: 1 })).toBeUndefined();
    expect(
      agentStepTranscript({ stepId: "10-draft", kind: "agent", status: "completed", startedAt: 1, output: { archived: true, gcsUri: "gs://b/o", sizeBytes: 9 } }),
    ).toBeUndefined();
  });
});

describe("runAgentTranscripts", () => {
  it("keys each transcript by its step id, so a run with two agent steps is unambiguous", () => {
    const found = runAgentTranscripts([
      { stepId: "01-load", kind: "code", status: "completed", startedAt: 1, output: { ok: true } },
      agentStep({ stepId: "04b-research-extract-facts" }),
      agentStep({ stepId: "10-draft-post" }),
    ]);
    expect(found.map((f) => f.stepId)).toEqual(["04b-research-extract-facts", "10-draft-post"]);
  });

  it("skips an agent step whose recorded turns carry nothing to show", () => {
    const empty = agentStep();
    (empty.output as { steps: unknown[]; finalOutput: unknown }).steps = [];
    (empty.output as { finalOutput: unknown }).finalOutput = null;
    expect(runAgentTranscripts([empty])).toEqual([]);
  });
});

describe("stepOutputPreviews", () => {
  const steps: AgentEngineStepRecord[] = [
    { stepId: "06-reserve-topic", kind: "code", status: "completed", startedAt: 1, output: { topics: ["a"] } },
    { stepId: "15-batch-review", kind: "gate", status: "completed", startedAt: 2, output: { decision: "approve", actor: "Tomer Erel" } },
    { stepId: "16-verify", kind: "code", status: "running", startedAt: 3 },
    { stepId: "17-big", kind: "code", status: "completed", startedAt: 4, output: { archived: true, gcsUri: "gs://b/o", sizeBytes: 9 } },
    agentStep(),
  ];

  it("includes a resolved gate's decision — the only place the portal can show who approved what", () => {
    const previews = stepOutputPreviews(steps);
    const gate = previews.find((p) => p.stepId === "15-batch-review");
    expect(gate?.kind).toBe("gate");
    expect(gate?.json).toContain("Tomer Erel");
  });

  it("excludes agent steps (they render as a transcript), running steps, and archived outputs", () => {
    expect(stepOutputPreviews(steps).map((p) => p.stepId)).toEqual(["06-reserve-topic", "15-batch-review"]);
  });

  it("flags a truncated payload instead of showing a silently short one", () => {
    const [preview] = stepOutputPreviews([
      { stepId: "04-research-pull", kind: "code", status: "completed", startedAt: 1, output: { raw: "y".repeat(40_000) } },
    ]);
    expect(preview?.truncated).toBe(true);
    expect(preview?.json).toContain("(truncated)");
  });
});
