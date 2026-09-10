import { describe, expect, it } from "vitest";
import { groupRecommendationsByOwner, type RecOwner } from "../routable-recommendation";
import { REC_OWNER_RUN_STATUS, REC_OWNERS_WITH_DOCUMENTED_RUN_STATUS } from "../rec-owner-run-status";

/**
 * [SCRUM-392] "Whichever way it resolves, a test asserts that every
 * `RecOwner` member has a run path or is documented as needing none. That is
 * the assertion whose absence let a third of the split go unnoticed" (the
 * ticket's own required test).
 *
 * The set of real `RecOwner` members is derived structurally —
 * `groupRecommendationsByOwner([])`'s return type is
 * `Record<RecOwner, RoutableRecommendation[]>`, so its keys are exactly the
 * union's members, enforced by `tsc` rather than a second hand-copied
 * literal list this test could silently drift from `routable-recommendation.ts`'s
 * own `RecOwner` type.
 */
function realRecOwners(): RecOwner[] {
  return Object.keys(groupRecommendationsByOwner([])) as RecOwner[];
}

describe("REC_OWNER_RUN_STATUS (SCRUM-392) — every RecOwner has a run path or a documented reason it needs none", () => {
  it("has exactly one row per real RecOwner member — no owner is silently undocumented, no stale row for a retired one", () => {
    expect(Object.keys(REC_OWNER_RUN_STATUS).sort()).toEqual(realRecOwners().sort());
    expect(REC_OWNERS_WITH_DOCUMENTED_RUN_STATUS.slice().sort()).toEqual(realRecOwners().sort());
  });

  it("every row either has a real run path, or a non-empty rationale for why it doesn't — never neither", () => {
    for (const owner of realRecOwners()) {
      const row = REC_OWNER_RUN_STATUS[owner];
      expect(row, `${owner} should have a REC_OWNER_RUN_STATUS row`).toBeDefined();
      expect(row.owner).toBe(owner);
      if (!row.hasRunPath) {
        expect(row.rationale.trim().length, `${owner}'s rationale for having no run path`).toBeGreaterThan(0);
      }
    }
  });

  it("karos_agent has a real run path (dispatchSeoGeoRecommendationRun, T-B15/SCRUM-260)", () => {
    expect(REC_OWNER_RUN_STATUS.karos_agent.hasRunPath).toBe(true);
  });

  it("karos_tool is ratified as documented-needing-none (SCRUM-392): T-A17 was inspected and found artifact-only, no tool-runner primitive exists", () => {
    expect(REC_OWNER_RUN_STATUS.karos_tool.hasRunPath).toBe(false);
    expect(REC_OWNER_RUN_STATUS.karos_tool.rationale).toContain("SCRUM-392");
    expect(REC_OWNER_RUN_STATUS.karos_tool.rationale).toContain("artifact-only");
  });

  it("client_manual needs no runner by definition — the client always acts", () => {
    expect(REC_OWNER_RUN_STATUS.client_manual.hasRunPath).toBe(false);
    expect(REC_OWNER_RUN_STATUS.client_manual.rationale.length).toBeGreaterThan(0);
  });
});
