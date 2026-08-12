import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicAgentSpec, DynamicAgentStepDef } from "../src/dynamic-types.js";
import { AGENT_MODEL_ALIASES } from "../src/task-types.js";

/**
 * step-runner.ts's own contract (Decision 1 sequential-only, Decision 4
 * retry policy, Phase 7 context accumulation) with the two things that talk
 * to the outside world mocked: the SDK's `query()` (AI steps) and
 * `runCodeStep` (code steps). Everything else — ordering, retry counting,
 * context threading, dependsOn rejection — runs for real.
 */

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const runCodeStepMock = vi.fn();
vi.mock("../runner/src/dynamic/code-sandbox.js", () => ({
  runCodeStep: (...args: unknown[]) => runCodeStepMock(...args),
}));

async function* sdkStream(messages: unknown[]) {
  for (const m of messages) yield m;
}

function assistantText(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}
function resultOk(usage?: { model: string; inputTokens: number; outputTokens: number; totalCostUsd: number }) {
  if (!usage) return { type: "result", subtype: "success" };
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: usage.totalCostUsd,
    modelUsage: {
      [usage.model]: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: usage.totalCostUsd,
      },
    },
  };
}
function resultError(subtype: string, errors?: string[]) {
  return { type: "result", subtype, ...(errors ? { errors } : {}) };
}

function aiStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "ai" }>> = {}): DynamicAgentStepDef {
  return { id: "s1", type: "ai", label: "Step 1", model: "sonnet", prompt: "Do the thing", order: 0, ...patch };
}
function codeStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "code" }>> = {}): DynamicAgentStepDef {
  return { id: "s2", type: "code", label: "Step 2", language: "node", code: "console.log('{}')", order: 1, ...patch };
}
function baseSpec(steps: DynamicAgentStepDef[]): DynamicAgentSpec {
  return {
    id: "spec-1",
    name: "Test agent",
    description: "d",
    category: "c",
    icon: "Sparkles",
    creditsCost: 1,
    active: true,
    version: 1,
    inputSchema: [],
    steps,
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";
});

describe("runDynamicSteps", () => {
  it("DECISION 1: refuses to run any step at all when dependsOn is populated", async () => {
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep({ dependsOn: ["other"] })]), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dependsOn/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("runs steps strictly in `order`, not array order", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const second = aiStep({ id: "second", order: 1, prompt: "second" });
    const first = aiStep({ id: "first", order: 0, prompt: "first" });
    const result = await runDynamicSteps(baseSpec([second, first]), {});
    expect(result.ok).toBe(true);
    expect(result.trace.map((t) => t.stepId)).toEqual(["first", "second"]);
  });

  it("Phase 7: every step sees the FULL accumulated context, including outputs from steps before its immediate predecessor", async () => {
    const prompts: string[] = [];
    queryMock.mockImplementation((args: { prompt: string }) => {
      prompts.push(args.prompt);
      return sdkStream([assistantText(`out-${prompts.length}`), resultOk()]);
    });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const steps = [
      aiStep({ id: "a", order: 0, prompt: "A" }),
      aiStep({ id: "b", order: 1, prompt: "B refers to {{outputs.a}}" }),
      aiStep({ id: "c", order: 2, prompt: "C sees everything" }),
    ];
    const result = await runDynamicSteps(baseSpec(steps), { topic: "x" });
    expect(result.ok).toBe(true);
    expect(prompts[1]).toContain("out-1"); // b's interpolated reference to a's output
    expect(prompts[2]).toContain('"a"'); // c's full serialized context still carries a's output
    expect(prompts[2]).toContain('"b"');
    expect(result.outputs).toEqual({ a: "out-1", b: "out-2", c: "out-3" });
    expect(result.finalOutput).toBe("out-3"); // the last step's own output
  });

  it("DECISION 4: retries an AI step exactly once on a transient result error, then succeeds", async () => {
    let call = 0;
    queryMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return sdkStream([resultError("error_during_execution", ["upstream 503 overloaded"])]);
      return sdkStream([assistantText("recovered"), resultOk()]);
    });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep()]), {});
    expect(result.ok).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("sums each AI step's token/cost usage into one run-level total, and records it per-step on the trace", async () => {
    queryMock.mockImplementationOnce(() =>
      sdkStream([assistantText("a-out"), resultOk({ model: "claude-haiku", inputTokens: 10, outputTokens: 5, totalCostUsd: 0.01 })]),
    );
    queryMock.mockImplementationOnce(() =>
      sdkStream([assistantText("b-out"), resultOk({ model: "claude-sonnet", inputTokens: 20, outputTokens: 8, totalCostUsd: 0.05 })]),
    );
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const steps = [aiStep({ id: "a", order: 0 }), aiStep({ id: "b", order: 1 })];
    const result = await runDynamicSteps(baseSpec(steps), {});

    expect(result.ok).toBe(true);
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.06);
    expect(result.usage?.models["claude-haiku"]).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.01,
    });
    expect(result.trace[0]?.usage?.models["claude-haiku"]?.inputTokens).toBe(10);
    expect(result.trace[1]?.usage?.models["claude-sonnet"]?.inputTokens).toBe(20);
  });

  it("forwards every raw SDK message from an AI step to onTranscriptMessage, like the hardcoded path's TranscriptStreamer", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const seen: unknown[] = [];
    const result = await runDynamicSteps(baseSpec([aiStep()]), {}, { onTranscriptMessage: (m) => seen.push(m) });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([assistantText("out"), resultOk()]);
  });

  it("DECISION 4: does not retry a permanent AI result error, and fails the run at that step", async () => {
    queryMock.mockImplementation(() => sdkStream([resultError("error_during_execution", ["invalid x-api-key"])]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep()]), {});
    expect(result.ok).toBe(false);
    expect(result.failedStepId).toBe("s1");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("DECISION 4: a code step failure is NEVER retried, even though it looks like the same error text", async () => {
    runCodeStepMock.mockResolvedValue({ ok: false, error: "Code step exited with code 1.", stderr: "boom" });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([codeStep()]), {});
    expect(result.ok).toBe(false);
    expect(runCodeStepMock).toHaveBeenCalledTimes(1);
  });

  it("Decision 4 (fail-fast): stops at the failing step and returns partial context from steps completed before it", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("ok"), resultOk()]));
    runCodeStepMock.mockResolvedValue({ ok: false, error: "boom" });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const steps = [aiStep({ id: "a", order: 0 }), codeStep({ id: "b", order: 1 }), aiStep({ id: "c", order: 2, prompt: "never runs" })];
    const result = await runDynamicSteps(baseSpec(steps), {});
    expect(result.ok).toBe(false);
    expect(result.failedStepId).toBe("b");
    expect(result.failedStepIndex).toBe(1);
    expect(result.partialOutputs).toEqual({ a: "ok" });
    expect(queryMock).toHaveBeenCalledTimes(1); // step c never ran
  });

  it("Decision 5: a code step fails cleanly, without spawning anything, when DYNAMIC_CODE_STEPS_ENABLED is not set", async () => {
    delete process.env.DYNAMIC_CODE_STEPS_ENABLED;
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([codeStep()]), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/i);
    expect(runCodeStepMock).not.toHaveBeenCalled();
  });

  it("fails the AI step when the model produced no text output", async () => {
    queryMock.mockImplementation(() => sdkStream([resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep()]), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no text output/i);
  });
});

describe("resumeFrom — skipping steps a prior attempt already completed", () => {
  it("skips a completed step entirely (no SDK call, no onProgress ping) and seeds context from its prior output", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("b-out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const events: unknown[] = [];
    const steps = [aiStep({ id: "a", order: 0, prompt: "uses nothing" }), aiStep({ id: "b", order: 1, prompt: "uses {{outputs.a}}" })];
    const result = await runDynamicSteps(baseSpec(steps), {}, {
      onProgress: (e) => events.push(e),
      resumeFrom: {
        completedStepIds: new Set(["a"]),
        outputs: { a: "a-out-from-prior-attempt" },
        priorTrace: [{ stepId: "a", type: "ai", label: "Step 1", status: "done", durationMs: 111 }],
      },
    });
    expect(result.ok).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1); // only step b ran
    expect(events.every((e) => (e as { stepId: string }).stepId !== "a")).toBe(true);
    expect(result.trace[0]).toMatchObject({ stepId: "a", status: "done", durationMs: 111 });
    expect(result.outputs).toEqual({ a: "a-out-from-prior-attempt", b: "b-out" });
  });

  it("does not double-count a resumed step's usage into this attempt's returned total, but keeps it in the trace", async () => {
    queryMock.mockImplementation(() =>
      sdkStream([assistantText("b-out"), resultOk({ model: "claude-sonnet", inputTokens: 20, outputTokens: 8, totalCostUsd: 0.05 })]),
    );
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const steps = [aiStep({ id: "a", order: 0 }), aiStep({ id: "b", order: 1 })];
    const result = await runDynamicSteps(baseSpec(steps), {}, {
      resumeFrom: {
        completedStepIds: new Set(["a"]),
        outputs: { a: "a-out" },
        priorTrace: [{
          stepId: "a",
          type: "ai",
          label: "Step 1",
          status: "done",
          durationMs: 50,
          usage: { totalCostUsd: 0.01, models: { "claude-haiku": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.01 } } },
        }],
      },
    });
    expect(result.ok).toBe(true);
    // Only THIS attempt's own spend (step b) — step a's prior-attempt usage is
    // agent-service's job to merge cross-attempt (mergeJobUsage at /complete),
    // not this function's.
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.05);
    expect(result.usage?.models["claude-haiku"]).toBeUndefined();
    // But the full step history — including step a's original cost — survives
    // in the trace for stepBreakdown/analytics purposes.
    expect(result.trace[0]?.usage?.totalCostUsd).toBe(0.01);
  });

  it("runs every step fresh when resumeFrom is absent (unchanged default behavior)", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep({ id: "a" }), aiStep({ id: "b", order: 1 })]), {});
    expect(result.ok).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe("resolveStepModel — reusing the brief's step_models", () => {
  it("prefers the brief's step_models entry over the snapshot's own step.model", async () => {
    const { resolveStepModel } = await import("../runner/src/dynamic/step-runner.js");
    const step = aiStep({ id: "draft", model: "haiku" }) as Extract<DynamicAgentStepDef, { type: "ai" }>;
    const result = resolveStepModel(step, { draft: "opus" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alias).toBe("opus");
      expect(result.model).toBe(AGENT_MODEL_ALIASES.opus);
    }
  });

  it("falls back to step.model when the brief carries no map for that step", async () => {
    const { resolveStepModel } = await import("../runner/src/dynamic/step-runner.js");
    const step = aiStep({ id: "draft", model: "sonnet" }) as Extract<DynamicAgentStepDef, { type: "ai" }>;
    const viaFallback = resolveStepModel(step, { someOtherStep: "opus" });
    expect(viaFallback.ok).toBe(true);
    if (viaFallback.ok) expect(viaFallback.model).toBe(AGENT_MODEL_ALIASES.sonnet);
    const viaNoMap = resolveStepModel(step, undefined);
    if (viaNoMap.ok) expect(viaNoMap.model).toBe(AGENT_MODEL_ALIASES.sonnet);
  });

  it("refuses a RAW model id from either place — aliases only", async () => {
    const { resolveStepModel } = await import("../runner/src/dynamic/step-runner.js");
    const step = aiStep({ id: "draft", model: "sonnet" }) as Extract<DynamicAgentStepDef, { type: "ai" }>;
    const fromBrief = resolveStepModel(step, { draft: "claude-opus-4-8" });
    expect(fromBrief.ok).toBe(false);
    if (!fromBrief.ok) expect(fromBrief.error).toMatch(/alias/i);

    const rawInSpec = { ...step, model: "gpt-4" } as unknown as Extract<DynamicAgentStepDef, { type: "ai" }>;
    expect(resolveStepModel(rawInSpec, undefined).ok).toBe(false);
  });
});

describe("per-step model routing end to end", () => {
  it("runs each step on its own resolved model and records it in the trace", async () => {
    const seen: Array<string | undefined> = [];
    queryMock.mockImplementation((args: { options?: { model?: string } }) => {
      seen.push(args.options?.model);
      return sdkStream([assistantText("out"), resultOk()]);
    });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const steps = [aiStep({ id: "a", order: 0, model: "haiku" }), aiStep({ id: "b", order: 1, model: "opus" })];
    const result = await runDynamicSteps(baseSpec(steps), {});
    expect(result.ok).toBe(true);
    expect(seen).toEqual([AGENT_MODEL_ALIASES.haiku, AGENT_MODEL_ALIASES.opus]);
    expect(result.trace.map((t) => t.model)).toEqual([AGENT_MODEL_ALIASES.haiku, AGENT_MODEL_ALIASES.opus]);
  });

  it("reuses the options.agents plumbing, keyed by the step id", async () => {
    let captured: Record<string, { model?: string }> | undefined;
    queryMock.mockImplementation((args: { options?: { agents?: Record<string, { model?: string }> } }) => {
      captured = args.options?.agents;
      return sdkStream([assistantText("out"), resultOk()]);
    });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(baseSpec([aiStep({ id: "research", model: "sonnet" })]), {});
    expect(captured).toBeDefined();
    expect(Object.keys(captured ?? {})).toEqual(["research"]);
    expect(captured?.research?.model).toBe(AGENT_MODEL_ALIASES.sonnet);
  });

  it("a step_models override reroutes the model without touching the snapshot", async () => {
    const seen: Array<string | undefined> = [];
    queryMock.mockImplementation((args: { options?: { model?: string } }) => {
      seen.push(args.options?.model);
      return sdkStream([assistantText("out"), resultOk()]);
    });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const spec = baseSpec([aiStep({ id: "draft", model: "haiku" })]);
    await runDynamicSteps(spec, {}, { stepModels: { draft: "opus" } });
    expect(seen).toEqual([AGENT_MODEL_ALIASES.opus]);
    // the snapshot itself is untouched
    expect(spec.steps[0]).toMatchObject({ model: "haiku" });
  });

  it("fails the step with an English error when the model is not a known alias", async () => {
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const bad = { ...aiStep(), model: "gpt-4" } as unknown as DynamicAgentStepDef;
    const result = await runDynamicSteps(baseSpec([bad]), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/alias/i);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("dash normalization of AI output", () => {
  it("normalizes an em dash in a step's text before it enters the context store", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("big — news and this -- too"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep({ id: "a" })]), {});
    expect(result.ok).toBe(true);
    expect(result.outputs?.a).toBe("big - news and this - too");
  });

  it("leaves a shell separator inside a fenced block alone", async () => {
    const withFence = "Run:\n```bash\nnpm t -- --watch\n```";
    queryMock.mockImplementation(() => sdkStream([assistantText(withFence), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep({ id: "a" })]), {});
    expect(result.outputs?.a).toBe(withFence);
  });

  it("normalizes a code step's own JSON output too", async () => {
    runCodeStepMock.mockResolvedValue({ ok: true, output: { headline: "a — b" } });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([codeStep({ id: "c", order: 0 })]), {});
    expect(result.ok).toBe(true);
    expect(result.outputs?.c).toEqual({ headline: "a - b" });
  });

  it("the downstream step sees the ALREADY normalized text of the step before it", async () => {
    const prompts: string[] = [];
    let call = 0;
    queryMock.mockImplementation((args: { prompt: string }) => {
      prompts.push(args.prompt);
      call += 1;
      return sdkStream([assistantText(call === 1 ? "first — one" : "second"), resultOk()]);
    });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(
      baseSpec([aiStep({ id: "a", order: 0 }), aiStep({ id: "b", order: 1, prompt: "use {{outputs.a}}" })]),
      {},
    );
    expect(prompts[1]).toContain("first - one");
    expect(prompts[1]).not.toContain("first — one");
  });
});
