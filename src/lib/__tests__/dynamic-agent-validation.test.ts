import { describe, expect, it } from "vitest";
import {
  validateAndNormalizeInputSchema,
  validateAndNormalizeSteps,
  validateGeneral,
  type DynamicAgentGeneralInput,
} from "@/lib/dynamic-agent-validation";
import type { DynamicAgentInputDef, DynamicAgentStepDef } from "@/lib/types";

function general(patch: Partial<DynamicAgentGeneralInput> = {}): DynamicAgentGeneralInput {
  return {
    name: "Case Study Drafter",
    description: "Drafts a case study from a client brief.",
    category: "Content",
    icon: "Sparkles",
    creditsCost: 5,
    active: true,
    allowedClientIds: [],
    ...patch,
  };
}

function field(patch: Partial<DynamicAgentInputDef> = {}): DynamicAgentInputDef {
  return { key: "company_name", type: "text", label: "Company name", required: true, order: 0, ...patch };
}

function aiStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "ai" }>> = {}): DynamicAgentStepDef {
  return { id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Research {{inputs.company_name}}", order: 0, ...patch };
}

function codeStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "code" }>> = {}): DynamicAgentStepDef {
  return { id: "format", type: "code", language: "node", label: "Format", code: "console.log('{}')", order: 1, ...patch };
}

describe("validateGeneral", () => {
  it("accepts a well-formed draft", () => {
    expect(validateGeneral(general())).toBeNull();
  });

  it("requires a name", () => {
    expect(validateGeneral(general({ name: "  " }))).toMatch(/name is required/i);
  });

  it("rejects a negative or fractional credits cost", () => {
    expect(validateGeneral(general({ creditsCost: -1 }))).toMatch(/whole number/i);
    expect(validateGeneral(general({ creditsCost: 1.5 }))).toMatch(/whole number/i);
  });

  it("accepts zero credits", () => {
    expect(validateGeneral(general({ creditsCost: 0 }))).toBeNull();
  });
});

describe("validateAndNormalizeInputSchema — key rules", () => {
  it("rejects a key with uppercase letters", () => {
    const result = validateAndNormalizeInputSchema([field({ key: "CompanyName" })]);
    expect(result.ok).toBe(false);
  });

  it("rejects a key starting with a digit", () => {
    const result = validateAndNormalizeInputSchema([field({ key: "1name" })]);
    expect(result.ok).toBe(false);
  });

  it("accepts a lowercase-with-underscores key", () => {
    const result = validateAndNormalizeInputSchema([field({ key: "company_name_2" })]);
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate keys within a spec", () => {
    const result = validateAndNormalizeInputSchema([
      field({ key: "company_name", order: 0 }),
      field({ key: "company_name", order: 1, label: "Duplicate" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate/i);
  });

  it("re-indexes order to be dense and 0-indexed after a reorder", () => {
    const result = validateAndNormalizeInputSchema([
      field({ key: "b", order: 5 }),
      field({ key: "a", order: 2 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputSchema.map((f) => f.key)).toEqual(["a", "b"]);
      expect(result.inputSchema.map((f) => f.order)).toEqual([0, 1]);
    }
  });
});

describe("validateAndNormalizeInputSchema — type-specific rules", () => {
  it("requires at least one option for a select field", () => {
    const result = validateAndNormalizeInputSchema([field({ key: "tone", type: "select", options: [] })]);
    expect(result.ok).toBe(false);
  });

  it("forbids options on a non-select field", () => {
    const result = validateAndNormalizeInputSchema([field({ type: "text", options: ["a"] })]);
    expect(result.ok).toBe(false);
  });

  it("forbids accept/maxSizeMb on a non-file/image field", () => {
    const result = validateAndNormalizeInputSchema([field({ type: "text", accept: "image/png" })]);
    expect(result.ok).toBe(false);
  });

  it("accepts a well-formed file field with accept + maxSizeMb", () => {
    const result = validateAndNormalizeInputSchema([
      field({ key: "logo", type: "image", label: "Logo", accept: "image/png", maxSizeMb: 5 }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an out-of-range maxSizeMb", () => {
    const result = validateAndNormalizeInputSchema([field({ type: "image", maxSizeMb: 0 })]);
    expect(result.ok).toBe(false);
  });
});

describe("validateAndNormalizeSteps — discriminated union narrowing", () => {
  it("requires model + prompt for an ai step", () => {
    const bad = { id: "s1", type: "ai", label: "Step", order: 0 } as unknown as DynamicAgentStepDef;
    const result = validateAndNormalizeSteps([bad]);
    expect(result.ok).toBe(false);
  });

  it("requires language + code for a code step", () => {
    const bad = { id: "s1", type: "code", label: "Step", order: 0 } as unknown as DynamicAgentStepDef;
    const result = validateAndNormalizeSteps([bad]);
    expect(result.ok).toBe(false);
  });

  it("narrows cleanly in a switch with no `any`", () => {
    const steps: DynamicAgentStepDef[] = [aiStep(), codeStep()];
    for (const step of steps) {
      switch (step.type) {
        case "ai":
          expect(step.model).toBeDefined();
          expect(step.prompt).toBeDefined();
          break;
        case "code":
          expect(step.language).toBeDefined();
          expect(step.code).toBeDefined();
          break;
      }
    }
  });

  it("accepts a mixed AI + Code chain and preserves order after normalization", () => {
    const result = validateAndNormalizeSteps([codeStep({ order: 1 }), aiStep({ order: 0 })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.steps.map((s) => s.id)).toEqual(["research", "format"]);
  });

  /**
   * PHASE 5's ACCEPTANCE, as a round trip: "an admin can build a mixed AI +
   * Code chain WITH A DIFFERENT MODEL PER STEP, save it, and reload it
   * identically". Save goes through this normalizer, so a normalizer that
   * dropped or collapsed per-step models would silently rewrite the admin's
   * pipeline on save and the reload would differ from what they built.
   */
  it("PHASE 5: a mixed chain with a different model per AI step survives save byte for byte", () => {
    const authored: DynamicAgentStepDef[] = [
      aiStep({ id: "research", model: "haiku", prompt: "cheap research", order: 0 }),
      codeStep({ id: "shape", language: "python", code: "print('{}')", timeoutMs: 15_000, order: 1 }),
      aiStep({ id: "write", model: "opus", prompt: "expensive writing", order: 2 }),
    ];
    const result = validateAndNormalizeSteps(authored);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.steps.map((s) => s.id)).toEqual(["research", "shape", "write"]);
    expect(result.steps.map((s) => s.type)).toEqual(["ai", "code", "ai"]);
    expect(result.steps.map((s) => (s.type === "ai" ? s.model : null))).toEqual(["haiku", null, "opus"]);
    expect(result.steps.map((s) => (s.type === "ai" ? s.prompt : s.code))).toEqual([
      "cheap research",
      "print('{}')",
      "expensive writing",
    ]);
    const code = result.steps.find((s) => s.type === "code");
    expect(code && code.type === "code" ? [code.language, code.timeoutMs] : null).toEqual(["python", 15_000]);
    expect(result.steps.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it("PHASE 5: reordering a mixed chain moves the model with its step, not by position", () => {
    // The admin drags the opus step to the front.
    const result = validateAndNormalizeSteps([
      aiStep({ id: "write", model: "opus", order: 0 }),
      aiStep({ id: "research", model: "haiku", order: 1 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps.map((s) => [s.id, s.type === "ai" ? s.model : null])).toEqual([
        ["write", "opus"],
        ["research", "haiku"],
      ]);
    }
  });

  it("requires at least one step", () => {
    expect(validateAndNormalizeSteps([]).ok).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const result = validateAndNormalizeSteps([aiStep({ id: "dup" }), codeStep({ id: "dup" })]);
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid model alias", () => {
    const bad = { ...aiStep(), model: "gpt-4" } as unknown as DynamicAgentStepDef;
    expect(validateAndNormalizeSteps([bad]).ok).toBe(false);
  });

  it("DECISION 1: rejects any step with a non-empty dependsOn", () => {
    const result = validateAndNormalizeSteps([aiStep({ dependsOn: ["other"] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dependsOn/i);
  });

  it("accepts an explicitly empty dependsOn (DAG-ready field present but inert)", () => {
    const result = validateAndNormalizeSteps([aiStep({ dependsOn: [] })]);
    expect(result.ok).toBe(true);
  });

  it("defaults a code step's timeoutMs when omitted", () => {
    const result = validateAndNormalizeSteps([codeStep({ timeoutMs: undefined })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const code = result.steps.find((s) => s.type === "code");
      expect(code && code.type === "code" ? code.timeoutMs : undefined).toBe(30_000);
    }
  });

  it("rejects a code step timeout above the hard cap", () => {
    const result = validateAndNormalizeSteps([codeStep({ timeoutMs: 999_999 })]);
    expect(result.ok).toBe(false);
  });
});

/**
 * SCRUM-133 asks for a per-field "Placeholder" property, and SCRUM-132 asks for
 * a "Short Summary" separate from the "Detailed Description". Neither appeared
 * in the epic document these types were first built from, so both arrived late —
 * these are their rules.
 */
describe("placeholder (SCRUM-133)", () => {
  it("is accepted on a text field and survives normalization", () => {
    const result = validateAndNormalizeInputSchema([field({ type: "text", placeholder: "e.g. Acme" })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputSchema[0]?.placeholder).toBe("e.g. Acme");
  });

  it("is accepted on a textarea", () => {
    const result = validateAndNormalizeInputSchema([
      field({ key: "brief", type: "textarea", placeholder: "Paste the brief here" }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("is refused on select / file / image, which have no placeholder to show", () => {
    for (const type of ["select", "file", "image"] as const) {
      const patch =
        type === "select"
          ? field({ key: "tone", type, options: ["a"], placeholder: "nope" })
          : field({ key: "doc", type, placeholder: "nope" });
      const result = validateAndNormalizeInputSchema([patch]);
      expect(result.ok, `${type} should refuse a placeholder`).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/no placeholder/i);
    }
  });

  it("is dropped rather than carried when a field's type changes away from text", () => {
    // The admin typed a placeholder, then switched the type to select. The
    // normalizer must not persist a value the renderer can never show.
    const result = validateAndNormalizeInputSchema([
      field({ key: "tone", type: "select", options: ["a"] }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputSchema[0]?.placeholder).toBeUndefined();
  });

  it("rejects one that is too long to be ghost text", () => {
    const result = validateAndNormalizeInputSchema([field({ type: "text", placeholder: "x".repeat(200) })]);
    expect(result.ok).toBe(false);
  });

  it("treats a whitespace-only placeholder as absent", () => {
    const result = validateAndNormalizeInputSchema([field({ type: "text", placeholder: "   " })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputSchema[0]?.placeholder).toBeUndefined();
  });
});

describe("summary (SCRUM-132)", () => {
  it("is optional — an agent with no summary still saves", () => {
    expect(validateGeneral(general({ summary: undefined }))).toBeNull();
    expect(validateGeneral(general({ summary: "" }))).toBeNull();
  });

  it("accepts a one-liner", () => {
    expect(validateGeneral(general({ summary: "Turns a brief into a case study." }))).toBeNull();
  });

  it("rejects one long enough to wrap the layout it exists for", () => {
    expect(validateGeneral(general({ summary: "x".repeat(200) }))).toMatch(/one-line pitch/i);
  });

  it("does not make description optional — the full text is still required", () => {
    expect(validateGeneral(general({ summary: "A one-liner", description: "" }))).toMatch(/description is required/i);
  });
});
