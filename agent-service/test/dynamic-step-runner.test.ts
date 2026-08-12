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

describe("per-AI-step capability grants (allowNetwork / allowClientData)", () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  });

  it("a step without allowNetwork gets no tools at all — unchanged from before this capability existed", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(baseSpec([aiStep()]), {});
    const options = queryMock.mock.calls[0]![0].options;
    expect(options.allowedTools).toEqual([]);
  });

  it("a step with allowNetwork gets exactly the WebFetch tool, when a proxy is configured", async () => {
    process.env.HTTP_PROXY = "http://proxy:8888";
    queryMock.mockImplementation(() => sdkStream([assistantText("out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep({ allowNetwork: true })]), {});
    expect(result.ok).toBe(true);
    const options = queryMock.mock.calls[0]![0].options;
    expect(options.allowedTools).toEqual(["WebFetch"]);
  });

  it("fails the step (and the job) with an English reason when allowNetwork is requested but no proxy is configured — never falls back to unrestricted egress or silent no-op", async () => {
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep({ allowNetwork: true })]), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network access.*no egress proxy/i);
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.trace[0]!.capabilities).toEqual({
      allowNetwork: true,
      allowClientData: false,
      networkHonored: false,
      clientDataHonored: false,
    });
  });

  it("records capabilities on a successful step that requested a grant, and omits capabilities on a step that requested neither", async () => {
    process.env.HTTP_PROXY = "http://proxy:8888";
    queryMock.mockImplementation(() => sdkStream([assistantText("out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(
      baseSpec([
        aiStep({ id: "granted", order: 0, allowNetwork: true }),
        aiStep({ id: "plain", order: 1 }),
      ]),
      {},
    );
    expect(result.ok).toBe(true);
    const granted = result.trace.find((t) => t.stepId === "granted");
    const plain = result.trace.find((t) => t.stepId === "plain");
    expect(granted?.capabilities).toEqual({
      allowNetwork: true,
      allowClientData: false,
      networkHonored: true,
      clientDataHonored: false,
    });
    expect(plain?.capabilities).toBeUndefined();
  });

  it("delivers clientContextText into the prompt of a step with allowClientData, and withholds it from every other step in the SAME run", async () => {
    const prompts: string[] = [];
    queryMock.mockImplementation((args: { prompt: string }) => {
      prompts.push(args.prompt);
      return sdkStream([assistantText("out"), resultOk()]);
    });
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const granted = aiStep({ id: "granted", order: 0, allowClientData: true, prompt: "Use the client's docs." });
    const ungranted = aiStep({ id: "ungranted", order: 1, prompt: "Do not see client docs." });
    const result = await runDynamicSteps(baseSpec([granted, ungranted]), {}, {
      clientContextText: "CONFIDENTIAL: this client's brand voice is playful.",
    });
    expect(result.ok).toBe(true);
    expect(prompts[0]).toContain("CONFIDENTIAL: this client's brand voice is playful.");
    expect(prompts[1]).not.toContain("CONFIDENTIAL");
  });

  it("a step with allowClientData but no clientContextText available (e.g. the client has no docs yet) still runs normally", async () => {
    queryMock.mockImplementation(() => sdkStream([assistantText("out"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep({ allowClientData: true })]), {}, {});
    expect(result.ok).toBe(true);
  });
});

/**
 * Topic guardrails and output de-duplication, at the PROMPT level
 * (docs/dynamic-agent-guardrails.md). The two injections have deliberately
 * different scopes, and that difference is the whole point of these tests:
 *
 *  - the guardrail goes into EVERY AI step, because a constraint that only one
 *    step sees is not a guardrail;
 *  - the history goes into the FINAL AI step only, because every earlier step
 *    is extraction or analysis where repetition is harmless, and paying tokens
 *    to tell a research step not to repeat itself is waste.
 */
describe("topic guardrails and output history injection", () => {
  function capturePrompts(): string[] {
    const prompts: string[] = [];
    queryMock.mockImplementation((args: { prompt: string }) => {
      prompts.push(args.prompt);
      return sdkStream([assistantText("out"), resultOk()]);
    });
    return prompts;
  }

  /* ── zero impact ── */

  it("injects nothing at all when neither feature is configured", async () => {
    const prompts = capturePrompts();
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep()]), {}, {});
    expect(result.ok).toBe(true);
    expect(prompts[0]).not.toContain("HARD CONSTRAINT");
    expect(prompts[0]).not.toContain("ALREADY PRODUCED");
    expect(result.guardrailInjectedStepIds).toEqual([]);
  });

  it("treats an EMPTY forbidden-topics list as no guardrails at all", async () => {
    const prompts = capturePrompts();
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec([aiStep()]), {}, { forbiddenTopics: [] });
    expect(prompts[0]).not.toContain("HARD CONSTRAINT");
    expect(result.guardrailInjectedStepIds).toEqual([]);
  });

  /* ── the guardrail reaches every AI step ── */

  it("injects the forbidden topics into EVERY AI step, not just the first or last", async () => {
    const prompts = capturePrompts();
    const steps = [aiStep({ id: "a", order: 0 }), aiStep({ id: "b", order: 1 }), aiStep({ id: "c", order: 2 })];
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec(steps), {}, { forbiddenTopics: ["competitor pricing"] });
    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("HARD CONSTRAINT");
      expect(prompt).toContain("competitor pricing");
    }
    expect(result.guardrailInjectedStepIds).toEqual(["a", "b", "c"]);
  });

  it("lists every configured topic, not only the first", async () => {
    const prompts = capturePrompts();
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(baseSpec([aiStep()]), {}, { forbiddenTopics: ["alpha", "beta", "gamma"] });
    for (const topic of ["alpha", "beta", "gamma"]) expect(prompts[0]).toContain(topic);
  });

  it("does not count a code step as guardrail-injected — a script reads no prompt", async () => {
    capturePrompts();
    runCodeStepMock.mockResolvedValue({ ok: true, output: { done: true } });
    const steps = [aiStep({ id: "a", order: 0 }), codeStep({ id: "b", order: 1 })];
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec(steps), {}, { forbiddenTopics: ["x"] });
    expect(result.guardrailInjectedStepIds).toEqual(["a"]);
  });

  it("records the steps that carried the guardrail even when the run FAILS partway", async () => {
    // A failed run still has to answer "was the constraint in force?" for the
    // steps that did execute.
    let call = 0;
    queryMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? sdkStream([assistantText("ok"), resultOk()]) : sdkStream([resultError("error_max_turns")]);
    });
    const steps = [aiStep({ id: "a", order: 0 }), aiStep({ id: "b", order: 1 })];
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec(steps), {}, { forbiddenTopics: ["x"] });
    expect(result.ok).toBe(false);
    expect(result.guardrailInjectedStepIds).toEqual(["a", "b"]);
  });

  /* ── history reaches the final AI step only ── */

  it("injects prior outputs into the FINAL AI step only", async () => {
    const prompts = capturePrompts();
    const steps = [aiStep({ id: "research", order: 0 }), aiStep({ id: "write", order: 1 })];
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec(steps), {}, {
      outputHistory: [{ jobId: "job-1", createdAt: 1, excerpt: "LAST MONTH'S POST BODY" }],
    });
    expect(result.ok).toBe(true);
    expect(prompts[0]).not.toContain("ALREADY PRODUCED");
    expect(prompts[0]).not.toContain("LAST MONTH'S POST BODY");
    expect(prompts[1]).toContain("ALREADY PRODUCED");
    expect(prompts[1]).toContain("LAST MONTH'S POST BODY");
  });

  it("picks the last AI step even when a code step comes after it", async () => {
    const prompts = capturePrompts();
    runCodeStepMock.mockResolvedValue({ ok: true, output: { done: true } });
    const steps = [aiStep({ id: "write", order: 0 }), codeStep({ id: "format", order: 1 })];
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(baseSpec(steps), {}, {
      outputHistory: [{ jobId: "job-1", createdAt: 1, excerpt: "PRIOR BODY" }],
    });
    expect(result.ok).toBe(true);
    expect(prompts[0]).toContain("PRIOR BODY");
  });

  it("labels prior outputs as what NOT to produce, so they cannot read as source material", async () => {
    const prompts = capturePrompts();
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(baseSpec([aiStep()]), {}, {
      outputHistory: [{ jobId: "job-1", createdAt: 1, excerpt: "PRIOR BODY" }],
    });
    expect(prompts[0]).toMatch(/NOT source material/i);
    expect(prompts[0]).toMatch(/must differ from|must be substantially different/i);
  });

  it("injects nothing for an empty history list", async () => {
    const prompts = capturePrompts();
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(baseSpec([aiStep()]), {}, { outputHistory: [] });
    expect(prompts[0]).not.toContain("ALREADY PRODUCED");
  });

  /* ── the two compose ── */

  it("carries both the guardrail and the history on the final step when both are configured", async () => {
    const prompts = capturePrompts();
    const steps = [aiStep({ id: "research", order: 0 }), aiStep({ id: "write", order: 1 })];
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(baseSpec(steps), {}, {
      forbiddenTopics: ["competitor pricing"],
      outputHistory: [{ jobId: "job-1", createdAt: 1, excerpt: "PRIOR BODY" }],
    });
    expect(prompts[0]).toContain("HARD CONSTRAINT");
    expect(prompts[0]).not.toContain("PRIOR BODY");
    expect(prompts[1]).toContain("HARD CONSTRAINT");
    expect(prompts[1]).toContain("PRIOR BODY");
  });

  it("keeps the admin's own prompt and the run context intact alongside the injections", async () => {
    // The injections ADD to the composed prompt; they must never replace what
    // the admin wrote or the context every step relies on.
    const prompts = capturePrompts();
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    await runDynamicSteps(baseSpec([aiStep({ prompt: "ADMIN AUTHORED BODY" })]), { topic: "x" }, {
      forbiddenTopics: ["y"],
      outputHistory: [{ jobId: "j", createdAt: 1, excerpt: "PRIOR" }],
    });
    expect(prompts[0]).toContain("ADMIN AUTHORED BODY");
    expect(prompts[0]).toContain("Full run context so far");
  });
});
