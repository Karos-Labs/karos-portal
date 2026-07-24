import { describe, expect, it } from "vitest";
import { TRACKED_COMPETITOR_LIMIT, computeTrackedCompetitors } from "../competitor-priority";
import type { ClientCompetitor } from "../types";

function competitor(patch: Partial<ClientCompetitor> = {}): ClientCompetitor {
  return {
    id: "id",
    clientId: "c1",
    company: "Acme",
    marketTier: "Other",
    overlap: "Low",
    deepDive: false,
    keyStrengths: [],
    keyWeaknesses: [],
    source: "report",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe("computeTrackedCompetitors", () => {
  it("puts manual competitors first, backfilled by highest-priority auto-seeded ones", () => {
    const manual = competitor({ id: "m1", source: "manual", createdAt: 1 });
    const highThreat = competitor({ id: "a1", threatLevel: "HIGH", marketTier: "Leader", overlap: "High" });
    const lowThreat = competitor({ id: "a2", threatLevel: "LOW" });

    const result = computeTrackedCompetitors([lowThreat, highThreat, manual], 2);

    expect(result.map((c) => c.id)).toEqual(["m1", "a1"]);
  });

  it("keeps the most recently added manual competitors when there are more than the limit", () => {
    const manual = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      competitor({ id: `m${n}`, source: "manual", createdAt: n }),
    );

    const result = computeTrackedCompetitors(manual, TRACKED_COMPETITOR_LIMIT);

    expect(result).toHaveLength(TRACKED_COMPETITOR_LIMIT);
    expect(result.map((c) => c.id)).toEqual(["m7", "m6", "m5", "m4", "m3"]);
  });

  it("returns nothing but manual once manual entries fill the limit", () => {
    const manual = [1, 2].map((n) => competitor({ id: `m${n}`, source: "manual", createdAt: n }));
    const auto = competitor({ id: "a1", threatLevel: "HIGH" });

    const result = computeTrackedCompetitors([...manual, auto], 2);

    expect(result.map((c) => c.id)).toEqual(["m2", "m1"]);
  });
});

describe("LLM-visibility weighting", () => {
  it("ranks a measured AI-visible rival above any analyst-scored one", () => {
    const analystFavorite = competitor({
      id: "analyst",
      threatLevel: "HIGH",
      marketTier: "Leader",
      overlap: "High",
    });
    const aiVisible = competitor({ id: "ai", threatLevel: "LOW", llmMentions: 2 });

    const result = computeTrackedCompetitors([analystFavorite, aiVisible], 1);
    expect(result.map((c) => c.id)).toEqual(["ai"]);
  });

  it("breaks llmMentions ties with the analyst signals", () => {
    const a = competitor({ id: "a", llmMentions: 3, threatLevel: "LOW" });
    const b = competitor({ id: "b", llmMentions: 3, threatLevel: "HIGH" });
    const result = computeTrackedCompetitors([a, b], 2);
    expect(result.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("treats measured-zero and never-measured the same as no boost", () => {
    const zero = competitor({ id: "zero", llmMentions: 0, threatLevel: "MEDIUM" });
    const unmeasured = competitor({ id: "un", threatLevel: "HIGH" });
    const result = computeTrackedCompetitors([zero, unmeasured], 2);
    expect(result.map((c) => c.id)).toEqual(["un", "zero"]);
  });

  it("still lets manual competitors occupy the first slots regardless of llmMentions", () => {
    const manual = competitor({ id: "m", source: "manual", createdAt: 5 });
    const aiVisible = competitor({ id: "ai", llmMentions: 9 });
    const result = computeTrackedCompetitors([aiVisible, manual], 1);
    expect(result.map((c) => c.id)).toEqual(["m"]);
  });
});
