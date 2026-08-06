import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicAgentSpec } from "../src/dynamic-types.js";
import { AGENT_MODEL_ALIASES } from "../src/task-types.js";

/**
 * PHASE 7'S ACCEPTANCE, end to end.
 *
 * "the engine runs an end-to-end dynamic agent (AI → Code → AI) with a
 * different model per step, passes data correctly between steps, and produces a
 * final output plus a per-step trace. With DYNAMIC_CODE_STEPS_ENABLED=false, an
 * AI-only spec still runs end to end."
 *
 * Only the SDK is mocked. The code step runs for real, in the real sandbox, in
 * a real subprocess — so this exercises the actual stdin-JSON-in /
 * stdout-JSON-out contract and the actual guards, not a stand-in for them. That
 * is the whole point of an acceptance test for a data-passing engine: a mocked
 * code step would pass even if context threading were broken.
 */

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

async function* sdkStream(messages: unknown[]) {
  for (const m of messages) yield m;
}
function assistantText(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}
function resultOk() {
  return { type: "result", subtype: "success" };
}

/** AI → Code → AI, a different model alias on each AI step. */
function chainSpec(): DynamicAgentSpec {
  return {
    id: "spec-e2e",
    name: "Case study chain",
    description: "research, reshape, write",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 3,
    active: true,
    version: 1,
    inputSchema: [{ key: "company_name", type: "text", label: "Company", required: true, order: 0 }],
    steps: [
      {
        id: "research",
        type: "ai",
        label: "Research",
        model: "haiku",
        prompt: "Research {{inputs.company_name}}",
        order: 0,
      },
      {
        id: "shape",
        type: "code",
        label: "Shape the findings",
        language: "node",
        // Reads the FULL accumulated context off stdin and reshapes the
        // preceding AI step's output — the data-passing assertion in the middle.
        code: `
          let raw = "";
          process.stdin.on("data", (c) => (raw += c));
          process.stdin.on("end", () => {
            const ctx = JSON.parse(raw);
            const research = ctx.outputs.research;
            console.log(JSON.stringify({
              company: ctx.inputs.company_name,
              wordCount: String(research).split(/\\s+/).length,
              upper: String(research).toUpperCase(),
            }));
          });
        `,
        order: 1,
      },
      {
        id: "write",
        type: "ai",
        label: "Write the case study",
        model: "opus",
        prompt: "Using {{outputs.shape}}, write it up.",
        order: 2,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u-admin",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI → Code → AI, end to end", () => {
  it("runs all three steps, routes each AI step to its own model, threads data through the code step, and returns a final output plus a per-step trace", async () => {
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";
    const seenModels: Array<string | undefined> = [];
    const seenPrompts: string[] = [];
    queryMock.mockImplementation((args: { prompt: string; options?: { model?: string } }) => {
      seenModels.push(args.options?.model);
      seenPrompts.push(args.prompt);
      const nth = seenPrompts.length;
      return sdkStream([assistantText(nth === 1 ? "Acme builds widgets" : "Final case study text"), resultOk()]);
    });

    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(chainSpec(), { company_name: "Acme" }, {});

    expect(result.ok, `run failed: ${result.error}`).toBe(true);

    // a different model per AI step, resolved from the alias
    expect(seenModels).toEqual([AGENT_MODEL_ALIASES.haiku, AGENT_MODEL_ALIASES.opus]);

    // step 1's client input reached its prompt
    expect(seenPrompts[0]).toContain("Research Acme");

    // step 2 (real subprocess) saw step 1's output and the client's input
    expect(result.outputs?.shape).toEqual({
      company: "Acme",
      wordCount: 3,
      upper: "ACME BUILDS WIDGETS",
    });

    // step 3's prompt carried step 2's structured output
    expect(seenPrompts[1]).toContain("ACME BUILDS WIDGETS");

    // the run's deliverable is the LAST step's own output
    expect(result.finalOutput).toBe("Final case study text");

    // a per-step trace, in order, with each step's type and model recorded
    expect(result.trace.map((t) => [t.stepId, t.type, t.status])).toEqual([
      ["research", "ai", "done"],
      ["shape", "code", "done"],
      ["write", "ai", "done"],
    ]);
    expect(result.trace[0]?.model).toBe(AGENT_MODEL_ALIASES.haiku);
    expect(result.trace[1]?.model).toBeUndefined(); // a code step has no model
    expect(result.trace[2]?.model).toBe(AGENT_MODEL_ALIASES.opus);
    for (const entry of result.trace) expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("emits running/done progress for every step, in order", async () => {
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";
    queryMock.mockImplementation(() => sdkStream([assistantText("text"), resultOk()]));
    const events: string[] = [];
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(chainSpec(), { company_name: "Acme" }, {
      onProgress: (e) => events.push(`${e.stepId}:${e.status}:${e.index}/${e.total}`),
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      "research:running:0/3",
      "research:done:0/3",
      "shape:running:1/3",
      "shape:done:1/3",
      "write:running:2/3",
      "write:done:2/3",
    ]);
  }, 60_000);

  it("normalizes AI dashes end to end, without touching a code fence", async () => {
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";
    queryMock.mockImplementation(() =>
      sdkStream([assistantText("Acme — a widget maker\n```sh\nnpm t -- --watch\n```"), resultOk()]),
    );
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const spec = chainSpec();
    spec.steps = [spec.steps[0]!]; // just the first AI step
    const result = await runDynamicSteps(spec, { company_name: "Acme" }, {});
    expect(result.ok).toBe(true);
    expect(result.finalOutput).toContain("Acme - a widget maker");
    expect(result.finalOutput).toContain("npm t -- --watch");
  }, 30_000);
});

describe("with DYNAMIC_CODE_STEPS_ENABLED unset", () => {
  it("an AI-ONLY spec still runs end to end", async () => {
    delete process.env.DYNAMIC_CODE_STEPS_ENABLED;
    queryMock.mockImplementation((args: { options?: { model?: string } }) =>
      sdkStream([assistantText(`from ${args.options?.model}`), resultOk()]),
    );
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const spec = chainSpec();
    spec.steps = [
      { id: "research", type: "ai", label: "Research", model: "haiku", prompt: "Research {{inputs.company_name}}", order: 0 },
      { id: "write", type: "ai", label: "Write", model: "sonnet", prompt: "Use {{outputs.research}}", order: 1 },
    ];
    const result = await runDynamicSteps(spec, { company_name: "Acme" }, {});
    expect(result.ok, `AI-only run failed with the flag off: ${result.error}`).toBe(true);
    expect(result.outputs).toEqual({
      research: `from ${AGENT_MODEL_ALIASES.haiku}`,
      write: `from ${AGENT_MODEL_ALIASES.sonnet}`,
    });
    expect(result.trace).toHaveLength(2);
  }, 30_000);

  it("the SAME mixed spec fails at its code step, with the earlier AI step's output preserved as partial context", async () => {
    delete process.env.DYNAMIC_CODE_STEPS_ENABLED;
    queryMock.mockImplementation(() => sdkStream([assistantText("Acme builds widgets"), resultOk()]));
    const { runDynamicSteps } = await import("../runner/src/dynamic/step-runner.js");
    const result = await runDynamicSteps(chainSpec(), { company_name: "Acme" }, {});
    expect(result.ok).toBe(false);
    expect(result.failedStepId).toBe("shape");
    expect(result.failedStepIndex).toBe(1);
    expect(result.error).toMatch(/disabled/i);
    expect(result.partialOutputs).toEqual({ research: "Acme builds widgets" });
    // the third step never ran
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(result.trace.map((t) => t.status)).toEqual(["done", "failed"]);
  }, 30_000);
});
