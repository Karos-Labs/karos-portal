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
