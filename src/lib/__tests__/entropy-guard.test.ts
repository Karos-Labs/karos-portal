import { describe, expect, it } from "vitest";
import {
  REPETITION_THRESHOLD,
  tokenize,
  overlapSimilarity,
  assessThemeFreshness,
  buildFreshnessConstraints,
  freshnessGuard,
} from "../entropy-guard";

describe("tokenize", () => {
  it("lowercases, strips punctuation, and drops stop words + short tokens", () => {
    const tokens = tokenize("The BEST ways to grow your SaaS revenue!");
    expect(tokens.has("saas")).toBe(true);
    expect(tokens.has("revenue")).toBe(true);
    expect(tokens.has("grow")).toBe(true);
    // stop words / short / filler removed
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("best")).toBe(false);
    expect(tokens.has("to")).toBe(false);
    expect(tokens.has("ways")).toBe(false);
  });

  it("returns an empty set for content-free text", () => {
    expect(tokenize("the a an to of").size).toBe(0);
  });
});

describe("overlapSimilarity (overlap coefficient)", () => {
  it("is 1 when the smaller set is fully contained in the larger", () => {
    const a = new Set(["onboarding", "speed"]);
    const b = new Set(["onboarding", "speed", "retention", "growth", "saas"]);
    expect(overlapSimilarity(a, b)).toBe(1);
  });

  it("is 0 for disjoint sets and for an empty set", () => {
    expect(overlapSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(overlapSimilarity(new Set(), new Set(["b"]))).toBe(0);
  });

  it("is symmetric", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["y", "z"]);
    expect(overlapSimilarity(a, b)).toBe(overlapSimilarity(b, a));
  });
});

describe("assessThemeFreshness", () => {
  const past = [
    "How to speed up SaaS customer onboarding and boost retention",
    "Our spring product roadmap and pricing changes",
  ];

  it("flags a theme that heavily echoes recent output", () => {
    const a = assessThemeFreshness("Speeding up SaaS onboarding for better retention", past);
    expect(a.isRepetitive).toBe(true);
    expect(a.maxSimilarity).toBeGreaterThanOrEqual(REPETITION_THRESHOLD);
    expect(a.collidingIndexes).toContain(0);
    expect(a.echoedKeywords).toEqual(expect.arrayContaining(["onboarding", "saas", "retention"]));
  });

  it("passes a genuinely fresh theme", () => {
    const a = assessThemeFreshness("A founder's guide to hiring your first sales rep", past);
    expect(a.isRepetitive).toBe(false);
    expect(a.maxSimilarity).toBeLessThan(REPETITION_THRESHOLD);
  });

  it("treats an empty corpus as always fresh", () => {
    const a = assessThemeFreshness("anything at all", []);
    expect(a.isRepetitive).toBe(false);
    expect(a.maxSimilarity).toBe(0);
  });

  it("treats a content-free theme as fresh (nothing to match)", () => {
    expect(assessThemeFreshness("the a to of", past).isRepetitive).toBe(false);
  });

  it("respects a custom threshold", () => {
    const strict = assessThemeFreshness("spring pricing update", past, 0.2);
    const lenient = assessThemeFreshness("spring pricing update", past, 0.99);
    expect(strict.isRepetitive).toBe(true);
    expect(lenient.isRepetitive).toBe(false);
  });
});

describe("buildFreshnessConstraints", () => {
  it("returns an empty string when the theme is fresh", () => {
    const a = assessThemeFreshness("a totally new angle on remote hiring", ["unrelated content here"]);
    expect(buildFreshnessConstraints(a)).toBe("");
  });

  it("emits strict constraints naming the echoed keywords when repetitive", () => {
    const a = assessThemeFreshness("SaaS onboarding retention", [
      "SaaS onboarding retention playbook",
    ]);
    const constraints = buildFreshnessConstraints(a);
    expect(constraints).toContain("CREATIVE ENTROPY GUARD");
    expect(constraints).toMatch(/onboarding/);
    expect(constraints).toMatch(/freshness/i);
  });
});

describe("freshnessGuard", () => {
  it("bundles assessment + constraints; constraints empty when fresh", () => {
    const fresh = freshnessGuard("brand new topic on logistics", ["cooking recipes"]);
    expect(fresh.constraints).toBe("");
    expect(fresh.assessment.isRepetitive).toBe(false);
  });

  it("returns non-empty constraints when repetitive", () => {
    const rep = freshnessGuard("onboarding speed retention", ["onboarding speed retention guide"]);
    expect(rep.constraints).not.toBe("");
    expect(rep.assessment.isRepetitive).toBe(true);
  });
});
