import { describe, expect, it } from "vitest";
import { checkDanglingReferences } from "@/lib/dynamic-agent-reference-check";
import type { DynamicAgentInputDef, DynamicAgentStepDef } from "@/lib/types";

function field(patch: Partial<DynamicAgentInputDef> = {}): DynamicAgentInputDef {
  return { key: "company_name", type: "text", label: "Company name", required: true, order: 0, ...patch };
}

function aiStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "ai" }>> = {}): DynamicAgentStepDef {
  return { id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0, ...patch };
}

function codeStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "code" }>> = {}): DynamicAgentStepDef {
  return { id: "format", type: "code", language: "node", label: "Format", code: "console.log('{}')", order: 1, ...patch };
}

describe("checkDanglingReferences", () => {
  it("finds nothing wrong with a clean pipeline", () => {
    const messages = checkDanglingReferences(
      [field()],
      [
        aiStep({ id: "research", order: 0, prompt: "Research {{inputs.company_name}}" }),
        aiStep({ id: "write", order: 1, prompt: "Use {{outputs.research}}" }),
      ],
    );
    expect(messages).toEqual([]);
  });

  it("catches a {{inputs.x}} whose key does not exist", () => {
    const messages = checkDanglingReferences([field({ key: "company_name" })], [
      aiStep({ prompt: "Research {{inputs.not_a_real_key}}" }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/not_a_real_key/);
  });

  it("catches a {{outputs.y}} whose step does not exist", () => {
    const messages = checkDanglingReferences([], [aiStep({ prompt: "Use {{outputs.nonexistent}}" })]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/no step with that id/);
  });

  it("catches a {{outputs.y}} referring to a LATER step", () => {
    const messages = checkDanglingReferences(
      [],
      [
        aiStep({ id: "a", order: 0, prompt: "Use {{outputs.b}}" }),
        aiStep({ id: "b", order: 1, prompt: "Go" }),
      ],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/LATER step/);
  });

  it("catches a step referencing its own output", () => {
    const messages = checkDanglingReferences([], [aiStep({ id: "a", prompt: "Use {{outputs.a}}" })]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/its own output/);
  });

  it("never scans a code step's code for references", () => {
    const messages = checkDanglingReferences(
      [],
      [codeStep({ code: "// {{outputs.nonexistent}} is just a comment in this script" })],
    );
    expect(messages).toEqual([]);
  });

  it("resolves a longer dotted path against its first two segments only", () => {
    const messages = checkDanglingReferences(
      [],
      [
        aiStep({ id: "a", order: 0, prompt: "Go" }),
        aiStep({ id: "b", order: 1, prompt: "Use {{outputs.a.summary.headline}}" }),
      ],
    );
    expect(messages).toEqual([]);
  });

  it("finds multiple dangling references across a multi-step pipeline", () => {
    const messages = checkDanglingReferences(
      [field({ key: "company_name" })],
      [
        aiStep({ id: "a", order: 0, prompt: "{{inputs.missing_key}}" }),
        aiStep({ id: "b", order: 1, prompt: "{{outputs.c}}" }),
        aiStep({ id: "c", order: 2, prompt: "Go" }),
      ],
    );
    expect(messages).toHaveLength(2);
  });
});
