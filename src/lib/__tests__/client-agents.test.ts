import { describe, expect, it } from "vitest";
import {
  LAUNCH_BLOCK_REASON,
  LAUNCH_STAGE_SPLIT_MS,
  agentKeySlug,
  agentSlotDocId,
  canSubmitLaunch,
  clientAgentDocId,
  clientLaunchPhase,
  compareDateKeys,
  dateKeyInZone,
  effectiveRotation,
  evaluateLaunchGate,
  intakeBlockReason,
  isLaunchInFlight,
  isOptionsMode,
  shiftDateKey,
  weekdayOfDateKey,
  activeTemplates,
  rosterStatus,
} from "@/lib/client-agents";
import type { ClientAgentTemplate } from "@/lib/types";

/* ───────────────────────── deterministic ids ───────────────────────── */

describe("deterministic ids", () => {
  it("slugs an agent key into a legal doc-id segment", () => {
    expect(agentKeySlug("products/live/Instagram-Agent")).toBe("products-live-instagram-agent");
    expect(agentKeySlug("karos-x-agent")).toBe("karos-x-agent");
    expect(agentKeySlug("Weird  Key!!")).toBe("weird-key");
  });

  it("is stable — the same pair always maps to the same umbrella", () => {
    expect(clientAgentDocId("client-1", "karos-x-agent")).toBe(
      clientAgentDocId("client-1", "KAROS-X-AGENT"),
    );
    expect(clientAgentDocId("client-1", "a")).not.toBe(clientAgentDocId("client-2", "a"));
  });

  it("keys one slot per umbrella per day", () => {
    expect(agentSlotDocId("client-1__ig", "2026-07-28")).toBe("client-1__ig__2026-07-28");
  });
});

/* ──────────────────────────── day keys ─────────────────────────────── */

describe("calendar day keys", () => {
  it("reads an instant in the schedule's zone, not the runtime's", () => {
    // 2026-07-28T23:30Z is already the 29th in Tokyo and still the 28th in NY.
    const at = Date.UTC(2026, 6, 28, 23, 30);
    expect(dateKeyInZone(at, "Asia/Tokyo")).toBe("2026-07-29");
    expect(dateKeyInZone(at, "America/New_York")).toBe("2026-07-28");
  });

  it("shifts across month and year boundaries", () => {
    expect(shiftDateKey("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2026-07-01", 28)).toBe("2026-07-29");
  });

  it("sorts lexicographically and knows weekdays", () => {
    expect(compareDateKeys("2026-07-28", "2026-08-01")).toBe(-1);
    expect(weekdayOfDateKey("2026-07-28")).toBe(2); // a Tuesday
  });
});

/* ───────────────────────── launch state machine ────────────────────── */

describe("launch state machine", () => {
  it("allows a launch only from not_launched / launch_failed", () => {
    expect(canSubmitLaunch("not_launched")).toBe(true);
    expect(canSubmitLaunch("launch_failed")).toBe(true);
    expect(canSubmitLaunch("launching")).toBe(false);
    expect(canSubmitLaunch("curating")).toBe(false);
    expect(canSubmitLaunch("live")).toBe(false);
  });

  it("treats launching and curating as in flight", () => {
    expect(isLaunchInFlight("launching")).toBe(true);
    expect(isLaunchInFlight("curating")).toBe(true);
    expect(isLaunchInFlight("live")).toBe(false);
  });

  it("collapses the five internal states into the client's three phases", () => {
    const startedAt = 1_000_000;
    expect(clientLaunchPhase("not_launched")).toBe("not_started");
    expect(clientLaunchPhase("launching", { startedAt, now: startedAt + 60_000 })).toBe("researching");
    expect(
      clientLaunchPhase("launching", { startedAt, now: startedAt + LAUNCH_STAGE_SPLIT_MS + 1 }),
    ).toBe("designing");
    // Staff vocabulary never reaches the client: "curating" reads as designing.
    expect(clientLaunchPhase("curating")).toBe("designing");
    expect(clientLaunchPhase("live")).toBe("live");
    expect(clientLaunchPhase("launch_failed")).toBe("failed");
  });
});

/* ─────────────────────────── the gate ladder ───────────────────────── */

const baseGate = {
  launchState: "not_launched" as const,
  granted: true,
  intakeReady: true,
  launchCreditCost: 120,
  availableCredits: 500,
};

describe("evaluateLaunchGate", () => {
  it("allows a fully-ready client launch at the agent's launch price", () => {
    expect(evaluateLaunchGate(baseGate)).toEqual({ allowed: true, cost: 120 });
  });

  it("hides unknown agents behind the same message as missing ones", () => {
    const result = evaluateLaunchGate({ ...baseGate, granted: false });
    expect(result).toEqual({
      allowed: false,
      code: "not_granted",
      reason: LAUNCH_BLOCK_REASON.not_granted,
    });
  });

  it("blocks a second launch while one is in flight", () => {
    expect(evaluateLaunchGate({ ...baseGate, launchState: "launching" })).toMatchObject({
      allowed: false,
      code: "launch_in_flight",
    });
    expect(evaluateLaunchGate({ ...baseGate, launchState: "curating" })).toMatchObject({
      allowed: false,
      code: "launch_in_flight",
    });
    expect(evaluateLaunchGate({ ...baseGate, launchState: "live" })).toMatchObject({
      allowed: false,
      code: "already_live",
    });
  });

  it("names the intake page when the agent drafts from stored intake", () => {
    const result = evaluateLaunchGate({
      ...baseGate,
      intakeReady: false,
      intakeLabel: "X agent data",
    });
    expect(result).toEqual({
      allowed: false,
      code: "intake_required",
      reason: intakeBlockReason("X agent data"),
    });
  });

  it("gates a client launch while the price is uncalibrated (Q10)", () => {
    expect(evaluateLaunchGate({ ...baseGate, launchCreditCost: null })).toEqual({
      allowed: false,
      code: "pricing_uncalibrated",
      reason: LAUNCH_BLOCK_REASON.pricing_uncalibrated,
    });
  });

  it("treats 0, negatives and fractions as uncalibrated, not as a free launch", () => {
    // A zero price would charge nothing, write NO ledger row, and still quote
    // the client a price on the card. "No price a human set" includes these.
    for (const cost of [0, -25, 12.5, Number.NaN]) {
      expect(evaluateLaunchGate({ ...baseGate, launchCreditCost: cost })).toMatchObject({
        allowed: false,
        code: "pricing_uncalibrated",
      });
    }
  });

  it("lets STAFF launch an uncalibrated agent for free — those runs are the measurement", () => {
    expect(
      evaluateLaunchGate({ ...baseGate, launchCreditCost: null, availableCredits: undefined }),
    ).toEqual({ allowed: true, cost: 0 });
  });

  it("surfaces the binding credit limit, not a generic top-up line", () => {
    const result = evaluateLaunchGate({
      ...baseGate,
      availableCredits: 10,
      creditBlockReason: "Weekly limit reached — resets Monday.",
    });
    expect(result).toEqual({
      allowed: false,
      code: "credits_short",
      reason: "Weekly limit reached — resets Monday.",
    });
  });

  it("checks the rungs in the server's order — intake before pricing before credits", () => {
    // Everything is broken at once; the client is told about the one they can fix.
    const result = evaluateLaunchGate({
      ...baseGate,
      intakeReady: false,
      intakeLabel: "X agent data",
      launchCreditCost: null,
      availableCredits: 0,
    });
    expect(result).toMatchObject({ code: "intake_required" });
  });
});

/* ────────────────────────── template registry ──────────────────────── */

function template(overrides: Partial<ClientAgentTemplate> & { key: string }): ClientAgentTemplate {
  return {
    name: overrides.key,
    status: "active",
    position: 0,
    source: "launch",
    addedAt: 1,
    ...overrides,
  };
}

describe("template registry", () => {
  const agent = {
    templates: [
      template({ key: "numbers", position: 1 }),
      template({ key: "playbook", position: 0 }),
      template({ key: "old", position: 2, status: "retired" }),
      template({ key: "resting", position: 3, status: "paused" }),
    ],
    rotation: ["numbers", "old", "numbers"],
  };

  it("lists only active templates, in position order", () => {
    expect(activeTemplates(agent).map((t) => t.key)).toEqual(["playbook", "numbers"]);
  });

  it("drops dead/duplicate rotation entries and appends forgotten active ones", () => {
    expect(effectiveRotation(agent)).toEqual(["numbers", "playbook"]);
  });

  // W3: mode is a decision made at bind time, not a leftover. Inferring it
  // from a missing chainFamily made every agent the family classifier could
  // not place (research, SEO, an unfamiliar import) an options-mode umbrella.
  it("reads options mode from the stored slot mode, never from a missing chain family", () => {
    expect(isOptionsMode({ slotMode: "options" })).toBe(true);
    expect(isOptionsMode({ slotMode: "single" })).toBe(false);
    // An unclassifiable agent bound before the field existed reads as single —
    // the safe answer: an empty rotation plans no days at all, where a wrongly
    // inferred options mode would plan days it has no candidates for.
    expect(isOptionsMode({ slotMode: undefined })).toBe(false);
  });
});

/**
 * CD-G1 — the one status word a roster card carries.
 *
 * The precedence is the load-bearing part: a schedule refusal outranks "Live",
 * inheriting F24/F129. An agent whose every scheduled fire is being turned away
 * is not live, whatever its umbrella's launchState says, and painting it green
 * because a database field reads `live` is the exact lie those defects were about.
 */
describe("rosterStatus", () => {
  it("lets a schedule refusal outrank Live (F24/F129 precedence)", () => {
    expect(
      rosterStatus({
        launchState: "live",
        scheduleRefusal: "This agent could not start on its last scheduled run.",
        scheduleActive: true,
      }),
    ).toEqual({ tone: "attention", label: "Needs attention" });
  });

  it("ignores a blank refusal rather than treating it as one", () => {
    expect(rosterStatus({ launchState: "live", scheduleRefusal: "   " })).toMatchObject({
      tone: "live",
    });
  });

  it("calls a live umbrella Live", () => {
    expect(rosterStatus({ launchState: "live" })).toEqual({ tone: "live", label: "Live" });
  });

  it("maps each in-flight and failed launch state to its own word", () => {
    expect(rosterStatus({ launchState: "launching" })).toMatchObject({ tone: "progress" });
    expect(rosterStatus({ launchState: "curating" })).toMatchObject({ tone: "progress" });
    expect(rosterStatus({ launchState: "launch_failed" })).toMatchObject({ tone: "attention" });
    expect(rosterStatus({ launchState: "not_launched" })).toMatchObject({ tone: "idle" });
  });

  it("treats an agent with no umbrella as live only when a schedule is producing", () => {
    expect(rosterStatus({ launchState: null, scheduleActive: true })).toEqual({
      tone: "live",
      label: "Live",
    });
    expect(rosterStatus({ launchState: null, scheduleActive: false })).toEqual({
      tone: "idle",
      label: "Ready to start",
    });
  });
});
