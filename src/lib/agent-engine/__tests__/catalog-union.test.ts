import { describe, expect, it } from "vitest";
import { agentStudioHref, buildEngineAgentCards } from "../catalog-union";
import type { MiddlewareAgent } from "../middleware-admin";

/**
 * Every agent-engine workflow renders, uniformly.
 *
 * This replaced a de-duplication against the lab-imported library that hid
 * five of the eleven behind legacy cards — they lost their stages, credit
 * cost, model and Studio link because a `customAgents` row happened to share
 * their product. The twin runs on a different executor, so "the same product"
 * was never quite true, and hiding a first-class agent to avoid showing two
 * cards traded a small duplication for a real omission.
 */
function mw(slug: string, overrides: Partial<MiddlewareAgent> = {}): MiddlewareAgent {
  return {
    id: slug,
    slug,
    name: slug,
    description: null,
    status: "active",
    agentType: null,
    model: null,
    modelParams: {},
    config: {},
    tags: [],
    createdAt: "",
    updatedAt: "",
    icon: null,
    category: null,
    creditCost: null,
    isPublic: true,
    requiredInputs: [],
    stages: [],
    stagesReadOnly: true,
    ...overrides,
  };
}

const ELEVEN = [
  "instagram-agent",
  "landing-builder-agent",
  "x-agent",
  "linkedin-agent",
  "reddit-agent",
  "branded-shorts-agent",
  "intel-report-agent",
  "blog-agent",
  "newsletter-agent",
  "reputation-agent",
  "seo-geo-agent",
];

describe("buildEngineAgentCards", () => {
  it("renders every agent, including the five that used to be hidden", () => {
    const cards = buildEngineAgentCards(ELEVEN.map((s) => mw(s)));

    expect(cards).toHaveLength(11);
    for (const slug of ELEVEN) {
      expect(cards.some((c) => c.slug === slug), `${slug} must render`).toBe(true);
    }
  });

  it("does not hide an agent because a lab-library twin exists", () => {
    // The regression this replaced: x-agent disappeared whenever
    // karos-x-agent-v2 was present, taking its stages and Studio link with it.
    const cards = buildEngineAgentCards([mw("x-agent"), mw("instagram-agent")]);

    expect(cards.map((c) => c.slug).sort()).toEqual(["instagram-agent", "x-agent"]);
  });

  it("carries the presentation fields a card needs", () => {
    const cards = buildEngineAgentCards([
      mw("x-agent", {
        name: "X / Twitter Content Specialist",
        icon: "AtSign",
        category: "social",
        creditCost: 6,
        model: "claude-sonnet-4-6-on-vertex",
        stages: [
          { id: "00-intake-check", label: "Intake check", description: null, isGate: false, kind: "ai" as const, modelId: null },
          { id: "15-batch-review", label: "Human review", description: null, isGate: true, kind: "gate" as const, modelId: null },
        ],
      }),
    ]);

    expect(cards[0]).toMatchObject({
      name: "X / Twitter Content Specialist",
      icon: "AtSign",
      creditCost: 6,
      stageCount: 2,
      model: "claude-sonnet-4-6-on-vertex",
    });
  });

  it("skips a row the middleware could not parse a slug from", () => {
    // prep's agents/ collection shares its name with karosCMO's since-removed
    // in-app engine and still holds one of its documents.
    const cards = buildEngineAgentCards([mw("", { id: "FcVYdiTM9RHrsap0Y6aQ", name: "Ghost" })]);

    expect(cards).toEqual([]);
  });

  it("sorts by name so the catalog is stable between loads", () => {
    const cards = buildEngineAgentCards([mw("z", { name: "Zebra" }), mw("a", { name: "Alpha" })]);

    expect(cards.map((c) => c.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("falls back to the slug when an agent has no name", () => {
    expect(buildEngineAgentCards([mw("nameless", { name: "" })])[0]!.name).toBe("nameless");
  });

  it("carries status through, so a disabled agent renders as one", () => {
    expect(buildEngineAgentCards([mw("x-agent", { status: "disabled" })])[0]!.status).toBe("disabled");
  });

  it("renders nothing when the control plane returned nothing", () => {
    // The degraded path: the catalog keeps its library section and loses only
    // the engine cards.
    expect(buildEngineAgentCards([])).toEqual([]);
  });
});

describe("agentStudioHref", () => {
  it("points at the agent's own Studio page, not an admin subpage", () => {
    expect(agentStudioHref("x-agent")).toBe("/agents/x-agent/studio");
  });

  it("encodes a slug that would otherwise break the path", () => {
    expect(agentStudioHref("weird/slug")).toBe("/agents/weird%2Fslug/studio");
  });
});
