import { describe, expect, it } from "vitest";
import {
  ACTION_DEFINITIONS,
  ACTION_DISMISS_COOLDOWN_MS,
  computeActionDone,
  resolveActionList,
  selectTopActions,
  shouldStartExpanded,
  type ActionSignals,
} from "../action-list";

const NOW = 1_800_000_000_000;

function signals(overrides: Partial<ActionSignals> = {}): ActionSignals {
  return {
    profileComplete: false,
    hasGrantedAgent: false,
    grantedAgentCount: 0,
    hasRun: false,
    runCount: 0,
    hasOutput: false,
    hasStarredAgent: false,
    hasManualCompetitor: false,
    hasUsableChannel: false,
    seatCount: 0,
    connectedPlatformIds: [],
    hasBillingConfigured: false,
    ...overrides,
  };
}

describe("ACTION_DEFINITIONS", () => {
  it("is the original fifteen plus the 2026-08 onboarding extension (16-24), in order", () => {
    // The original 15 were the whole list, ids untouched here on purpose — no
    // ClientActionState migration for existing clients. 16-24 are the
    // extension (see the module docstring for the reversed "never worded
    // after a platform" decision).
    expect(ACTION_DEFINITIONS).toHaveLength(24);
    expect(ACTION_DEFINITIONS.map((a) => a.id)).toEqual([
      "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15",
      "16", "17", "18", "19", "20", "21", "22", "23", "24",
    ]);
  });

  it("ids 16-20 are the only ones naming a platform — REVERSED 2026-08", () => {
    // This is the inverse of the test that used to stand here
    // ("never names a platform or a single agent in its label"). That rule
    // was a locked decision the product owner explicitly reversed: a
    // mandatory onboarding checklist that cannot say WHICH platform to
    // connect is not actionable. Kept as a NAMED exemption rather than
    // deleted outright, so a sixth platform-named row added later without
    // updating this list still fails here.
    //
    // "X" (id 17) is excluded from the generic word-boundary regex below —
    // a single letter is not a safe pattern to run against arbitrary prose —
    // and asserted by its own exact label instead.
    const platformWords = /instagram|linkedin|tiktok|facebook|twitter|reddit|youtube|google business|newsletter|blog/i;
    const PLATFORM_NAMED_IDS = new Set(["16", "17", "18", "19", "20"]);
    expect(ACTION_DEFINITIONS.find((a) => a.id === "17")?.label).toBe("Connect X");
    for (const a of ACTION_DEFINITIONS) {
      if (a.id === "17") continue;
      if (PLATFORM_NAMED_IDS.has(a.id)) {
        expect(a.label, a.id).toMatch(platformWords);
      } else {
        expect(a.label, a.id).not.toMatch(platformWords);
      }
    }
  });

  it("every action links somewhere", () => {
    for (const a of ACTION_DEFINITIONS) {
      expect(a.hrefFor("c1"), a.id).toMatch(/^\//);
    }
  });
});

describe("computeActionDone", () => {
  it("is all false with no signals at all", () => {
    const done = computeActionDone(signals());
    for (const [id, value] of Object.entries(done)) {
      expect(value, id).toBe(false);
    }
  });

  it("02 tracks 03 — no video-open event exists, so setup itself stands in", () => {
    const done = computeActionDone(signals({ hasGrantedAgent: true }));
    expect(done["02"]).toBe(true);
    expect(done["03"]).toBe(true);
  });

  it("08 needs a SECOND granted agent, not just one", () => {
    expect(computeActionDone(signals({ grantedAgentCount: 1 }))["08"]).toBe(false);
    expect(computeActionDone(signals({ grantedAgentCount: 2 }))["08"]).toBe(true);
  });

  it("09 needs at least one run per granted agent", () => {
    const under = signals({ hasGrantedAgent: true, grantedAgentCount: 2, runCount: 1 });
    const at = signals({ hasGrantedAgent: true, grantedAgentCount: 2, runCount: 2 });
    expect(computeActionDone(under)["09"]).toBe(false);
    expect(computeActionDone(at)["09"]).toBe(true);
  });

  it("07 needs a MANUAL competitor, not just an auto-seeded one existing", () => {
    // The intel pipeline seeds "report" competitors with no client action at
    // all — this must not silently complete the action.
    expect(computeActionDone(signals({ hasManualCompetitor: false }))["07"]).toBe(false);
    expect(computeActionDone(signals({ hasManualCompetitor: true }))["07"]).toBe(true);
  });

  it("11 needs a SECOND seat, not just one", () => {
    expect(computeActionDone(signals({ seatCount: 1 }))["11"]).toBe(false);
    expect(computeActionDone(signals({ seatCount: 2 }))["11"]).toBe(true);
  });

  it("16-20 each check their own platform's membership in connectedPlatformIds, not just any connection", () => {
    const withLinkedin = computeActionDone(signals({ connectedPlatformIds: ["linkedin"] }));
    expect(withLinkedin["16"]).toBe(true);
    expect(withLinkedin["17"]).toBe(false);
    expect(withLinkedin["18"]).toBe(false);
    expect(withLinkedin["19"]).toBe(false);
    expect(withLinkedin["20"]).toBe(false);

    const allFive = computeActionDone(
      signals({ connectedPlatformIds: ["linkedin", "twitter", "instagram", "youtube", "google_business_profile"] }),
    );
    expect(allFive["16"]).toBe(true);
    expect(allFive["17"]).toBe(true);
    expect(allFive["18"]).toBe(true);
    expect(allFive["19"]).toBe(true);
    expect(allFive["20"]).toBe(true);
  });

  it("24 needs billing actually configured, not just the lazily-created default doc", () => {
    expect(computeActionDone(signals({ hasBillingConfigured: false }))["24"]).toBe(false);
    expect(computeActionDone(signals({ hasBillingConfigured: true }))["24"]).toBe(true);
  });
});

describe("resolveActionList", () => {
  const noStates = new Map();

  it("marks an event-tracked action (12/13/14) eligible, never done, from signals alone", () => {
    // These three have no ActionSignals field at all — computeActionDone
    // cannot answer for them, and resolveActionList must not invent an
    // answer either.
    const resolved = resolveActionList(signals(), noStates, NOW);
    const byId = new Map(resolved.map((a) => [a.id, a.status]));
    expect(byId.get("12")).toBe("eligible");
    expect(byId.get("13")).toBe("eligible");
    expect(byId.get("14")).toBe("eligible");
  });

  it("21/22/23 (brand voice, persona, competitor analysis docs) are event-tracked the same way", () => {
    const resolved = resolveActionList(signals(), noStates, NOW);
    const byId = new Map(resolved.map((a) => [a.id, a.status]));
    expect(byId.get("21")).toBe("eligible");
    expect(byId.get("22")).toBe("eligible");
    expect(byId.get("23")).toBe("eligible");

    const opened = new Map([["22", { status: "done" as const, updatedAt: NOW }]]);
    expect(resolveActionList(signals(), opened, NOW).find((a) => a.id === "22")?.status).toBe("done");
  });

  it("reads a stored done row for an event-tracked action", () => {
    const states = new Map([["12", { status: "done" as const, updatedAt: NOW }]]);
    const resolved = resolveActionList(signals(), states, NOW);
    expect(resolved.find((a) => a.id === "12")?.status).toBe("done");
  });

  it("computes done for a live-signal action with no stored row at all", () => {
    const resolved = resolveActionList(signals({ profileComplete: true }), noStates, NOW);
    expect(resolved.find((a) => a.id === "01")?.status).toBe("done");
  });

  it("not_relevant is permanent and overrides even a done signal", () => {
    const states = new Map([["01", { status: "not_relevant" as const, updatedAt: NOW }]]);
    const resolved = resolveActionList(signals({ profileComplete: true }), states, NOW);
    expect(resolved.find((a) => a.id === "01")?.status).toBe("not_relevant");
  });

  it("dismissed hides the action only within the cooldown window", () => {
    const states = new Map([["01", { status: "dismissed" as const, updatedAt: NOW }]]);
    const stillHidden = resolveActionList(signals(), states, NOW + ACTION_DISMISS_COOLDOWN_MS - 1);
    const rotatedBack = resolveActionList(signals(), states, NOW + ACTION_DISMISS_COOLDOWN_MS + 1);
    expect(stillHidden.find((a) => a.id === "01")?.status).toBe("dismissed");
    expect(rotatedBack.find((a) => a.id === "01")?.status).toBe("eligible");
  });

  it("a dismissed action that becomes done stops being dismissed", () => {
    // Completion outranks a temporary dismissal — the whole point of
    // "temporary" is that the state underneath it can still change.
    const states = new Map([["01", { status: "dismissed" as const, updatedAt: NOW }]]);
    const resolved = resolveActionList(signals({ profileComplete: true }), states, NOW + 1000);
    expect(resolved.find((a) => a.id === "01")?.status).toBe("done");
  });
});

describe("selectTopActions", () => {
  it("takes the first N eligible actions, in definition order", () => {
    const resolved = resolveActionList(signals(), new Map(), NOW);
    const top = selectTopActions(resolved, 3);
    expect(top.map((a) => a.id)).toEqual(["01", "02", "03"]);
  });

  it("skips done, dismissed and not_relevant actions entirely", () => {
    const states = new Map([
      ["02", { status: "done" as const, updatedAt: NOW }],
      ["03", { status: "done" as const, updatedAt: NOW }],
      ["04", { status: "not_relevant" as const, updatedAt: NOW }],
    ]);
    const resolved = resolveActionList(signals({ profileComplete: true }), states, NOW);
    const top = selectTopActions(resolved, 3);
    expect(top.map((a) => a.id)).toEqual(["05", "06", "07"]);
  });

  it("never returns more than count", () => {
    const resolved = resolveActionList(signals(), new Map(), NOW);
    expect(selectTopActions(resolved, 3)).toHaveLength(3);
    expect(selectTopActions(resolved, 100).length).toBeLessThanOrEqual(ACTION_DEFINITIONS.length);
  });
});

describe("shouldStartExpanded", () => {
  it("expands for a client who has barely started", () => {
    const resolved = resolveActionList(signals(), new Map(), NOW);
    expect(shouldStartExpanded(resolved)).toBe(true);
  });

  it("collapses once a client has made real progress", () => {
    const states = new Map(
      ACTION_DEFINITIONS.slice(0, 20).map((a) => [a.id, { status: "done" as const, updatedAt: NOW }]),
    );
    const resolved = resolveActionList(signals(), states, NOW);
    expect(shouldStartExpanded(resolved)).toBe(false);
  });

  it("never throws on an empty list", () => {
    expect(shouldStartExpanded([])).toBe(false);
  });
});
