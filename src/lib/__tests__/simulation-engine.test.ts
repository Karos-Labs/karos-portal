import { afterEach, describe, expect, it, vi } from "vitest";

// Mocks are hoisted above imports; define them with vi.hoisted so the factories
// can reference them safely.
const { generateObjectMock, logUsageMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  logUsageMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateObject: generateObjectMock }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn(() => "mock-model") }));
// after() runs its callback synchronously so we can assert usage logging.
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: logUsageMock } }));

import {
  PERSONA_REGISTRY,
  MAX_PERSONAS,
  personaResultSchema,
  selectPersonasForIndustry,
  simulatePersona,
  runSimulation,
  type SimulationArtifact,
  type SimulationContext,
} from "@/lib/simulation-engine";

const artifact: SimulationArtifact = {
  title: "Launch announcement",
  content: "We just shipped the fastest onboarding in the category — live in 5 minutes.",
  type: "social_post",
};
const ctx: SimulationContext = { clientId: "c1", clientName: "Acme", industry: "saas" };

function goodVerdict() {
  return {
    object: { score: 7, sentiment: "positive", critique: "Strong, specific hook." },
    usage: { inputTokens: 120, outputTokens: 40 },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("selectPersonasForIndustry", () => {
  it("matches industry-specific personas by keyword", () => {
    const ids = selectPersonasForIndustry("B2B SaaS").map((p) => p.id);
    expect(ids).toContain("venture_capitalist");
    expect(ids).toContain("enterprise_tech_buyer");
  });

  it("selects consumer personas for a B2C industry", () => {
    const ids = selectPersonasForIndustry("Consumer retail / ecommerce").map((p) => p.id);
    expect(ids).toContain("high_volume_consumer");
    expect(ids).not.toContain("venture_capitalist");
  });

  it("falls back to a balanced default trio when nothing matches", () => {
    const ids = selectPersonasForIndustry("underwater basket weaving").map((p) => p.id);
    expect(ids).toEqual(["venture_capitalist", "enterprise_tech_buyer", "high_volume_consumer"]);
  });

  it("falls back when industry is missing", () => {
    expect(selectPersonasForIndustry(undefined)).toHaveLength(3);
    expect(selectPersonasForIndustry(null)).toHaveLength(3);
    expect(selectPersonasForIndustry("")).toHaveLength(3);
  });

  it("never returns more than MAX_PERSONAS", () => {
    // An industry string that hits many keywords at once.
    const many = selectPersonasForIndustry("saas software tech b2b enterprise consumer lifestyle services");
    expect(many.length).toBeLessThanOrEqual(MAX_PERSONAS);
  });

  it("returns personas from the registry (stable order)", () => {
    const selected = selectPersonasForIndustry("saas");
    const registryOrder = PERSONA_REGISTRY.map((p) => p.id);
    const selectedIds = selected.map((p) => p.id);
    const positions = selectedIds.map((id) => registryOrder.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("personaResultSchema (strict Zod parsing)", () => {
  it("accepts a well-formed verdict", () => {
    expect(personaResultSchema.parse({ score: 8, sentiment: "positive", critique: "Good." })).toEqual({
      score: 8,
      sentiment: "positive",
      critique: "Good.",
    });
  });

  it("rejects scores outside 1–10", () => {
    expect(() => personaResultSchema.parse({ score: 0, sentiment: "neutral", critique: "x" })).toThrow();
    expect(() => personaResultSchema.parse({ score: 11, sentiment: "neutral", critique: "x" })).toThrow();
  });

  it("rejects a non-integer score", () => {
    expect(() => personaResultSchema.parse({ score: 5.5, sentiment: "neutral", critique: "x" })).toThrow();
  });

  it("rejects an unknown sentiment", () => {
    expect(() => personaResultSchema.parse({ score: 5, sentiment: "meh", critique: "x" })).toThrow();
  });

  it("rejects an empty critique", () => {
    expect(() => personaResultSchema.parse({ score: 5, sentiment: "neutral", critique: "" })).toThrow();
  });
});

describe("simulatePersona", () => {
  it("returns the persona's verdict and logs usage", async () => {
    generateObjectMock.mockResolvedValue(goodVerdict());
    const persona = PERSONA_REGISTRY[0];

    const result = await simulatePersona(persona, artifact, ctx);

    expect(result.personaId).toBe(persona.id);
    expect(result.personaName).toBe(persona.name);
    expect(result.archetype).toBe(persona.archetype);
    expect(result.verdict).toEqual({ score: 7, sentiment: "positive", critique: "Strong, specific hook." });
    expect(logUsageMock).toHaveBeenCalledTimes(1);
    expect(logUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", operation: "audience_simulation" }),
    );
  });

  it("passes the persona's system prompt to the model", async () => {
    generateObjectMock.mockResolvedValue(goodVerdict());
    const persona = PERSONA_REGISTRY[0];
    await simulatePersona(persona, artifact, ctx);
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ system: persona.systemPrompt }),
    );
  });
});

describe("runSimulation (parallel + resilient)", () => {
  it("dispatches every persona and returns one result each", async () => {
    generateObjectMock.mockResolvedValue(goodVerdict());
    const personas = selectPersonasForIndustry("saas");

    const results = await runSimulation(artifact, personas, ctx);

    expect(generateObjectMock).toHaveBeenCalledTimes(personas.length);
    expect(results).toHaveLength(personas.length);
    results.forEach((r) => expect(r.verdict?.score).toBe(7));
  });

  it("isolates a single persona failure without dropping the others", async () => {
    generateObjectMock.mockImplementation(async ({ system }: { system: string }) => {
      if (system.includes("Series A venture capitalist")) throw new Error("model boom");
      return goodVerdict();
    });
    const personas = selectPersonasForIndustry("saas");

    const results = await runSimulation(artifact, personas, ctx);

    expect(results).toHaveLength(personas.length);
    const vc = results.find((r) => r.personaId === "venture_capitalist");
    expect(vc?.verdict).toBeUndefined();
    expect(vc?.error).toBe("model boom");

    const others = results.filter((r) => r.personaId !== "venture_capitalist");
    expect(others.length).toBeGreaterThan(0);
    others.forEach((r) => expect(r.verdict?.score).toBe(7));
  });

  it("carries persona identity onto failed entries so the UI can still label them", async () => {
    generateObjectMock.mockRejectedValue(new Error("down"));
    const personas = selectPersonasForIndustry("saas");

    const results = await runSimulation(artifact, personas, ctx);

    expect(results).toHaveLength(personas.length);
    results.forEach((r) => {
      expect(r.error).toBe("down");
      expect(r.personaName).toBeTruthy();
      expect(r.archetype).toBeTruthy();
    });
  });
});
