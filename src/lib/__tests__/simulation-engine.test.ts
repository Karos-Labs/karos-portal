import { afterEach, describe, expect, it, vi } from "vitest";

// Mocks are hoisted above imports; define them with vi.hoisted so the factories
// can reference them safely.
const { generateObjectMock, generateTextMock, logUsageMock, logGenerationFailureMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  generateTextMock: vi.fn(),
  logUsageMock: vi.fn(),
  logGenerationFailureMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateObject: generateObjectMock, generateText: generateTextMock }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn(() => "mock-model") }));
// after() runs its callback synchronously so we can assert usage logging.
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/services/logger", () => ({
  logger: { logUsage: logUsageMock, logGenerationFailure: logGenerationFailureMock },
}));

import {
  MAX_PERSONAS,
  buildSimulationPersonas,
  personaResultSchema,
  simulatePersona,
  runSimulation,
  type SyntheticPersona,
  type SimulationArtifact,
  type SimulationContext,
} from "@/lib/simulation-engine";

const artifact: SimulationArtifact = {
  title: "Launch announcement",
  content: "We just shipped the fastest onboarding in the category — live in 5 minutes.",
  type: "social_post",
  format: "LinkedIn carousel post",
  channels: ["linkedin"],
};
const ctx: SimulationContext = {
  clientId: "c1",
  clientName: "Acme",
  category: "AI workflow automation",
  toneOfVoice: "Confident and technical",
  targetMarket: "Mid-market RevOps and sales teams",
  businessModel: "B2B",
};

function goodVerdict() {
  return {
    object: {
      score: 7,
      sentiment: "positive",
      critique: "Strong, specific hook.",
      actionableSuggestion: "Lead with quantified ROI in sentence one.",
    },
    usage: { inputTokens: 120, outputTokens: 40 },
  };
}

const personaA: SyntheticPersona = {
  id: "cto_tech_lead",
  name: "CTO / Tech Lead",
  archetype: "Technical decision owner evaluating feasibility and architecture risk",
  perspective: "Engineering feasibility, implementation risk, and integration depth.",
  painPoints: ["Vague architecture claims", "No integration specifics"],
  voice: "Pragmatic and detail-oriented",
  evaluationFocus: "Trust and technical depth",
};

const personaB: SyntheticPersona = {
  id: "finance_decision_maker",
  name: "Financial Decision Maker",
  archetype: "Budget owner focused on payback and risk-adjusted ROI",
  perspective: "Commercial clarity, unit economics, and downside risk.",
  painPoints: ["No ROI framing", "No proof of measurable outcomes"],
  voice: "Analytical and skeptical",
  evaluationFocus: "Budget approval confidence",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildSimulationPersonas", () => {
  it("builds a dynamic 2-4 persona panel tailored to context", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        personas: [
          {
            id: "CTO & Tech Lead",
            name: "CTO / Tech Lead",
            archetype: "Technical decision owner",
            perspective: "Engineering risk and implementation complexity",
            painPoints: ["No API specifics", "Security posture unclear"],
            voice: "Direct and technical",
            evaluationFocus: "Feasibility and trust",
          },
          {
            id: "Finance Decision Maker",
            name: "Financial Decision Maker",
            archetype: "Budget authority",
            perspective: "ROI, budget impact, and financial downside",
            painPoints: ["No quantified savings", "No payback horizon"],
            voice: "Analytical and skeptical",
            evaluationFocus: "Approval confidence",
          },
        ],
      },
      usage: { inputTokens: 80, outputTokens: 50 },
    });

    const personas = await buildSimulationPersonas(artifact, ctx);

    expect(personas).toHaveLength(2);
    expect(personas[0].id).toBe("cto_tech_lead");
    expect(personas[1].id).toBe("finance_decision_maker");
    expect(personas[0].painPoints.length).toBeGreaterThanOrEqual(2);
    expect(personas.length).toBeLessThanOrEqual(MAX_PERSONAS);
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("POST CONTEXT"),
      }),
    );
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Tone of voice: Confident and technical"),
      }),
    );
  });
});

describe("personaResultSchema (strict Zod parsing)", () => {
  it("accepts a well-formed verdict", () => {
    expect(
      personaResultSchema.parse({
        score: 8,
        sentiment: "positive",
        critique: "Good.",
        actionableSuggestion: "Open with a concrete customer outcome.",
      }),
    ).toEqual({
      score: 8,
      sentiment: "positive",
      critique: "Good.",
      actionableSuggestion: "Open with a concrete customer outcome.",
    });
  });

  it("rejects scores outside 1–10", () => {
    expect(() =>
      personaResultSchema.parse({
        score: 0,
        sentiment: "neutral",
        critique: "x",
        actionableSuggestion: "x",
      }),
    ).toThrow();
    expect(() =>
      personaResultSchema.parse({
        score: 11,
        sentiment: "neutral",
        critique: "x",
        actionableSuggestion: "x",
      }),
    ).toThrow();
  });

  it("rejects a non-integer score", () => {
    expect(() =>
      personaResultSchema.parse({
        score: 5.5,
        sentiment: "neutral",
        critique: "x",
        actionableSuggestion: "x",
      }),
    ).toThrow();
  });

  it("rejects an unknown sentiment", () => {
    expect(() =>
      personaResultSchema.parse({
        score: 5,
        sentiment: "meh",
        critique: "x",
        actionableSuggestion: "x",
      }),
    ).toThrow();
  });

  it("rejects an empty critique", () => {
    expect(() =>
      personaResultSchema.parse({
        score: 5,
        sentiment: "neutral",
        critique: "",
        actionableSuggestion: "x",
      }),
    ).toThrow();
  });

  it("rejects an empty actionable suggestion", () => {
    expect(() =>
      personaResultSchema.parse({
        score: 5,
        sentiment: "neutral",
        critique: "ok",
        actionableSuggestion: "",
      }),
    ).toThrow();
  });
});

describe("simulatePersona", () => {
  it("returns the persona's verdict and logs usage", async () => {
    generateObjectMock.mockResolvedValue(goodVerdict());
    const persona = personaA;

    const result = await simulatePersona(persona, artifact, ctx);

    expect(result.personaId).toBe(persona.id);
    expect(result.personaName).toBe(persona.name);
    expect(result.archetype).toBe(persona.archetype);
    expect(result.perspective).toBe(persona.perspective);
    expect(result.painPoints).toEqual(persona.painPoints);
    expect(result.verdict).toEqual({
      score: 7,
      sentiment: "positive",
      critique: "Strong, specific hook.",
      actionableSuggestion: "Lead with quantified ROI in sentence one.",
    });
    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", operation: "audience_simulation" }),
    );
  });

  it("passes the persona's system prompt to the model", async () => {
    generateObjectMock.mockResolvedValue(goodVerdict());
    const persona = personaA;
    await simulatePersona(persona, artifact, ctx);
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining(persona.name) }),
    );
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("POST FORMAT") }),
    );
  });

  it("falls back to relaxed verdict schema when strict generation fails", async () => {
    generateObjectMock
      .mockRejectedValueOnce(new Error("strict parse failed"))
      .mockResolvedValueOnce({
        object: {
          score: 7.4,
          sentiment: "neutral",
          critique: "Useful but too abstract.",
        },
        usage: { inputTokens: 90, outputTokens: 35 },
      });
    const persona = personaA;
    const result = await simulatePersona(persona, artifact, ctx);
    expect(result.verdict).toEqual({
      score: 7,
      sentiment: "neutral",
      critique: "Useful but too abstract.",
      actionableSuggestion: "Refine the message to address this persona's top concern directly and concretely.",
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to text parsing when both object generations fail", async () => {
    generateObjectMock
      .mockRejectedValueOnce(new Error("strict parse failed"))
      .mockRejectedValueOnce(new Error("relaxed parse failed"));
    generateTextMock.mockResolvedValueOnce({
      text: `Here you go:
{"score":"8","sentiment":"Positive","feedback":"Clear value prop but needs concrete example.","suggestion":"Add one concrete implementation example in the first paragraph."}`,
      usage: { inputTokens: 100, outputTokens: 42 },
    });

    const result = await simulatePersona(personaA, artifact, ctx);
    expect(result.verdict).toEqual({
      score: 8,
      sentiment: "positive",
      critique: "Clear value prop but needs concrete example.",
      actionableSuggestion: "Add one concrete implementation example in the first paragraph.",
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("parses plain-text fallback when model does not return JSON", async () => {
    generateObjectMock
      .mockRejectedValueOnce(new Error("strict parse failed"))
      .mockRejectedValueOnce(new Error("relaxed parse failed"));
    generateTextMock.mockResolvedValueOnce({
      text: `Score: 6/10
Sentiment: neutral
Feedback: The positioning is clear but still generic for a technical buyer.
Actionable suggestion: Add one concrete API integration example and expected implementation time.`,
      usage: { inputTokens: 110, outputTokens: 50 },
    });

    const result = await simulatePersona(personaA, artifact, ctx);
    expect(result.verdict).toEqual({
      score: 6,
      sentiment: "neutral",
      critique: "The positioning is clear but still generic for a technical buyer.",
      actionableSuggestion: "Add one concrete API integration example and expected implementation time.",
    });
  });
});

describe("runSimulation (parallel + resilient)", () => {
  it("dispatches every persona and returns one result each", async () => {
    generateObjectMock.mockResolvedValue(goodVerdict());
    const personas = [personaA, personaB];

    const results = await runSimulation(artifact, personas, ctx);

    expect(generateObjectMock).toHaveBeenCalledTimes(personas.length);
    expect(results).toHaveLength(personas.length);
    results.forEach((r) => expect(r.verdict?.score).toBe(7));
  });

  it("isolates a single persona failure without dropping the others", async () => {
    generateObjectMock.mockImplementation(async ({ system }: { system: string }) => {
      if (system.includes("CTO / Tech Lead")) throw new Error("model boom");
      return goodVerdict();
    });
    const personas = [personaA, personaB];

    const results = await runSimulation(artifact, personas, ctx);

    expect(results).toHaveLength(personas.length);
    const vc = results.find((r) => r.personaId === "cto_tech_lead");
    expect(vc?.verdict).toBeUndefined();
    expect(vc?.error).toBe("model boom");

    const others = results.filter((r) => r.personaId !== "cto_tech_lead");
    expect(others.length).toBeGreaterThan(0);
    others.forEach((r) => expect(r.verdict?.score).toBe(7));
  });

  it("carries persona identity onto failed entries so the UI can still label them", async () => {
    generateObjectMock.mockRejectedValue(new Error("down"));
    const personas = [personaA, personaB];

    const results = await runSimulation(artifact, personas, ctx);

    expect(results).toHaveLength(personas.length);
    results.forEach((r) => {
      expect(r.error).toBe("down");
      expect(r.personaName).toBeTruthy();
      expect(r.archetype).toBeTruthy();
      expect(r.perspective).toBeTruthy();
      expect(r.painPoints.length).toBeGreaterThan(0);
    });
  });
});
