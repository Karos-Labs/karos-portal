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
  jobDeliveredWork,
  lastRunFailedAgentIds,
  rosterStatus,
  IMPORTED_CONTENT_STAFF_NOTE,
  LAST_RUN_FAILED_STAFF_NOTE,
  SCHEDULE_REFUSAL_FRESH_MS,
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
  // An agent bound to no client at all — the common case, and the one that
  // makes the binding rung invisible to every other assertion here.
  agentKey: "karos-instagram-agent",
  clientSlug: "geektime",
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

  /**
   * Ruling 1. The binding and the umbrella are COMPLEMENTARY layers: an
   * umbrella says "this client bought this agent", the binding says "this agent
   * instance can only ever draft for the client its key names". Merging the two
   * branches without this rung produced an F131-class state — an enabled Launch
   * on a card whose every submit the core refuses before writing a job row.
   */
  describe("binding rung", () => {
    const INSTANCE = "karos-linkedin-company-karoslabs";

    it("refuses a per-client instance paired with another client", () => {
      const result = evaluateLaunchGate({
        ...baseGate,
        agentKey: INSTANCE,
        clientSlug: "geektime",
      });
      expect(result).toMatchObject({ allowed: false, code: "wrong_client_binding" });
      // Names the workspace it DOES belong to, so staff know which agent to use.
      expect(result).toMatchObject({ reason: expect.stringContaining("karoslabs") });
    });

    it("allows the instance for its own client, however the slug is written", () => {
      for (const slug of ["karoslabs", " Karoslabs ", "clients/karoslabs/outputs"]) {
        expect(evaluateLaunchGate({ ...baseGate, agentKey: INSTANCE, clientSlug: slug })).toEqual({
          allowed: true,
          cost: 120,
        });
      }
    });

    it("refuses when the client has no lab slug at all", () => {
      // The safe direction: an unmatched client earns no instance, rather than
      // every instance.
      for (const slug of [null, undefined, ""]) {
        expect(
          evaluateLaunchGate({ ...baseGate, agentKey: INSTANCE, clientSlug: slug }),
        ).toMatchObject({ allowed: false, code: "wrong_client_binding" });
      }
    });

    it("leaves unbound agents launchable for everyone", () => {
      for (const key of ["karos-x-agent", "karos-linkedin-agent", "karos-reddit-agent"]) {
        expect(evaluateLaunchGate({ ...baseGate, agentKey: key, clientSlug: "sitti" })).toEqual({
          allowed: true,
          cost: 120,
        });
      }
    });

    it("outranks the intake rung — no form fills a binding in", () => {
      // Told to go and fill in intake, a reader would do the work and come back
      // to the same refusal, because the core refuses on identity.
      const result = evaluateLaunchGate({
        ...baseGate,
        agentKey: INSTANCE,
        clientSlug: "geektime",
        intakeReady: false,
        intakeLabel: "LinkedIn agent data",
      });
      expect(result).toMatchObject({ code: "wrong_client_binding" });
    });

    it("still hides an ungranted agent behind 'not found' first", () => {
      // Which agents exist beyond a client's allowlist is not theirs to learn,
      // and that outranks every other rung.
      expect(
        evaluateLaunchGate({
          ...baseGate,
          granted: false,
          agentKey: INSTANCE,
          clientSlug: "geektime",
        }),
      ).toMatchObject({ code: "not_granted" });
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
      // Must match the detail page hero for the same agent — a card promising
      // "Ready to start" that opens onto "Not set up yet" lied about its page.
      label: "Not set up yet",
    });
  });

  it("stops calling a delivered, unscheduled agent 'Not set up yet'", () => {
    // The self-contradiction this rung exists to kill: the status strip printed
    // "NOT SET UP YET · Last delivered 7d ago · Deliverables 2" in one line.
    // An agent that has produced is set up; what it lacks is a schedule, so it
    // runs when somebody asks. Idle tone either way — the word is what changes.
    expect(
      rosterStatus({ launchState: null, scheduleActive: false, hasDelivered: true }),
    ).toEqual({ tone: "idle", label: "Runs on request" });
  });

  it("keeps a live schedule and a refusal outranking delivered work", () => {
    // hasDelivered is the LOWEST rung of the no-umbrella branch: it may not
    // demote an agent that is actually firing, and it may not paint over the
    // F24/F129 refusal precedence.
    expect(
      rosterStatus({ launchState: null, scheduleActive: true, hasDelivered: true }),
    ).toMatchObject({ label: "Live" });
    expect(
      rosterStatus({
        launchState: null,
        scheduleActive: true,
        hasDelivered: true,
        scheduleRefusal: "Turned away on its last scheduled run.",
      }),
    ).toMatchObject({ tone: "attention", label: "Needs attention" });
  });

  it("leaves the umbrella states alone — a bound umbrella owns its own word", () => {
    // "Not set up yet" for a `not_launched` UMBRELLA is a statement about the
    // launch run, which delivered work says nothing about: staff bound it and
    // have not launched it, and the launch card is that story.
    expect(rosterStatus({ launchState: "not_launched", hasDelivered: true })).toMatchObject({
      label: "Not set up yet",
    });
  });

  /* ── a failed last run is an Internal line, never a word (round 6) ── */

  // round 6: these four pins are INVERTED on purpose. The failed-last-run rung
  // used to return "Needs attention" for staff and nothing for a client, which
  // made this function the one place in the product whose WORD depended on who
  // was looking — the same agent reading "Live" to the client and "Needs
  // attention" to the person beside them. The parity ruling forbids that and
  // AF-14 forbids the other direction, so the failure became additive: the word
  // is the client's, staff get LAST_RUN_FAILED_STAFF_NOTE next to it.

  it("never lets a failed run change the word, for either reader", () => {
    // The production case that produced the old rung: the pilot's Instagram
    // Agent, green "Live" badge, one run two days earlier reading "Failed". It
    // is still worth telling staff about; it is not worth two vocabularies.
    for (const viewerIsStaff of [true, false]) {
      expect(
        rosterStatus({ launchState: "live", lastRunFailed: true, viewerIsStaff }),
        `viewerIsStaff=${viewerIsStaff}`,
      ).toMatchObject({ tone: "live", label: "Live" });
      expect(
        rosterStatus({
          launchState: null,
          scheduleActive: true,
          lastRunFailed: true,
          viewerIsStaff,
        }),
        `unbound, scheduled, viewerIsStaff=${viewerIsStaff}`,
      ).toMatchObject({ tone: "live", label: "Live" });
    }
  });

  it("tells STAFF about it on the Internal line, and a client nothing (AF-14)", () => {
    expect(
      rosterStatus({ launchState: "live", lastRunFailed: true, viewerIsStaff: true }).staffNote,
    ).toBe(LAST_RUN_FAILED_STAFF_NOTE);
    // A client's payload does not carry the sentence at all, rather than
    // carrying it unpainted.
    expect(rosterStatus({ launchState: "live", lastRunFailed: true }).staffNote).toBeUndefined();
    expect(
      rosterStatus({ launchState: "live", lastRunFailed: true, viewerIsStaff: false }).staffNote,
    ).toBeUndefined();
    // And nothing to say means no line: the note is the failure, not a slot that
    // always renders.
    expect(rosterStatus({ launchState: "live", viewerIsStaff: true }).staffNote).toBeUndefined();
  });

  it("joins the two Internal facts rather than losing one", () => {
    // An imported stream whose last internal fire broke is BOTH facts at once,
    // and AF-5 got to the slot first. A note that overwrote the other would drop
    // whichever arrived second.
    const note = rosterStatus({
      launchState: null,
      hasUpcomingContent: true,
      lastRunFailed: true,
      viewerIsStaff: true,
    }).staffNote;
    expect(note).toContain(IMPORTED_CONTENT_STAFF_NOTE);
    expect(note).toContain(LAST_RUN_FAILED_STAFF_NOTE);
  });

  it("says the same word to staff and to a client for every shape (parity)", () => {
    // The ruling as a test: `viewerIsStaff` may add a sentence and may not touch
    // the word. Asked over every input that could plausibly carry a viewer split.
    const shapes = [
      { launchState: "live" as const, lastRunFailed: true },
      { launchState: "launching" as const, lastRunFailed: true },
      { launchState: "curating" as const, lastRunFailed: true },
      { launchState: "launch_failed" as const, lastRunFailed: true },
      { launchState: null, scheduleActive: true, lastRunFailed: true },
      { launchState: null, hasDelivered: true, lastRunFailed: true },
      { launchState: null, hasUpcomingContent: true, lastRunFailed: true },
      { launchState: "live" as const, scheduleRefusal: "Out of credits.", lastRunFailed: true },
    ];
    for (const shape of shapes) {
      const client = rosterStatus(shape);
      const staff = rosterStatus({ ...shape, viewerIsStaff: true });
      expect([staff.tone, staff.label], JSON.stringify(shape)).toEqual([
        client.tone,
        client.label,
      ]);
    }
  });

  it("keeps a schedule REFUSAL loud for a client, failed run or not (F24/F129)", () => {
    // The viewer split is about failures that are ours. A refusal is the
    // scheduler turning a fire away for a reason the client owns — out of
    // credits, an empty intake — and telling them is the entire point of it.
    expect(
      rosterStatus({ launchState: "live", scheduleRefusal: "Out of credits." }),
    ).toMatchObject({ tone: "attention", label: "Needs attention" });
  });

  it("keeps the launch narration exactly as it was", () => {
    // A setup in flight is a NEWER event than any completed run, and the launch
    // card is already narrating it in three phases. Asked as STAFF, so the
    // failed-run fact is live and demonstrably not reaching the word.
    const staff = { lastRunFailed: true, viewerIsStaff: true } as const;
    expect(rosterStatus({ launchState: "launching", ...staff })).toMatchObject({
      tone: "progress",
      label: "Setting up",
    });
    expect(rosterStatus({ launchState: "curating", ...staff })).toMatchObject({
      tone: "progress",
    });
    // Its own alarm, in its own words — it is the SETUP that failed.
    expect(rosterStatus({ launchState: "launch_failed", ...staff })).toMatchObject({
      tone: "attention",
      label: "Setup needs attention",
    });
  });

  /* ── a refusal ages out (read-path only, nothing is written) ── */

  it("stops a stale refusal forcing 'Needs attention' forever", () => {
    const now = 1_800_000_000_000;
    const refusal = { launchState: "live" as const, scheduleRefusal: "Turned away.", now };
    // Fresh: still the client's current state.
    expect(
      rosterStatus({ ...refusal, scheduleRefusalAt: now - 60 * 60 * 1000 }),
    ).toMatchObject({ tone: "attention", label: "Needs attention" });
    // Just inside the window.
    expect(
      rosterStatus({ ...refusal, scheduleRefusalAt: now - SCHEDULE_REFUSAL_FRESH_MS + 1 }),
    ).toMatchObject({ tone: "attention" });
    // Past it: lastError only clears on the next CLEAN fire, so on a weekly
    // cadence a refusal a top-up fixed an hour later kept saying "Needs
    // attention" for another week.
    expect(
      rosterStatus({ ...refusal, scheduleRefusalAt: now - SCHEDULE_REFUSAL_FRESH_MS - 1 }),
    ).toEqual({ tone: "live", label: "Live" });
  });

  it("shows an undated refusal rather than hiding an alarm it cannot age", () => {
    // Every writer sets lastErrorAt in the same patch as lastError, so an
    // undated refusal is a row we cannot date, not one we know to be old.
    expect(
      rosterStatus({ launchState: "live", scheduleRefusal: "Turned away.", now: 1 }),
    ).toMatchObject({ tone: "attention" });
  });

  it("still tells staff about a failed run once the refusal has aged out", () => {
    // round 6: the word goes back to Live for both readers (the refusal is stale
    // and a failed run is no longer a rung), and the failure survives as the
    // Internal line — losing the fact along with the word would be the
    // over-correction.
    const now = 1_800_000_000_000;
    const state = {
      launchState: "live" as const,
      scheduleRefusal: "Turned away.",
      scheduleRefusalAt: now - SCHEDULE_REFUSAL_FRESH_MS - 1,
      lastRunFailed: true,
      now,
    };
    expect(rosterStatus(state)).toEqual({ tone: "live", label: "Live" });
    expect(rosterStatus({ ...state, viewerIsStaff: true })).toEqual({
      tone: "live",
      label: "Live",
      staffNote: LAST_RUN_FAILED_STAFF_NOTE,
    });
  });

  /* ── AF-5: live means live ── */

  describe("upcoming content on the calendar (AF-5)", () => {
    // Albert: "it should still show that it's live even though we're creating it
    // internally… if there's items on the calendar like Instagram or TikTok
    // items, it should show us live." The stream has no cron of its own — we
    // produce its posts by hand and import them — so every other rung answers
    // idle for an agent the client can watch filling next week.

    it("turns 'Runs on request' into Live", () => {
      const idle = { launchState: null, scheduleActive: false, hasDelivered: true } as const;
      expect(rosterStatus(idle)).toMatchObject({ tone: "idle", label: "Runs on request" });
      expect(rosterStatus({ ...idle, hasUpcomingContent: true })).toMatchObject({
        tone: "live",
        label: "Live",
      });
    });

    it("turns 'Not set up yet' into Live, bound or unbound", () => {
      // The imported-stream case in both of its shapes: an agent nobody ever
      // bound an umbrella for, and one bound but never launched because the
      // launch run is not how its posts get made.
      //
      // An agent with NO intake keeps the promotion (`setup` absent): that is
      // this rung's whole reason to exist. What round 6 took away is the
      // intake-driven agent still asking for its form — see the pin below.
      expect(rosterStatus({ launchState: null })).toMatchObject({ label: "Not set up yet" });
      expect(rosterStatus({ launchState: null, hasUpcomingContent: true })).toMatchObject({
        tone: "live",
        label: "Live",
      });
      expect(rosterStatus({ launchState: "not_launched" })).toMatchObject({
        label: "Not set up yet",
      });
      expect(
        rosterStatus({ launchState: "not_launched", hasUpcomingContent: true }),
      ).toMatchObject({ tone: "live", label: "Live" });
    });

    // round 6 (verify-BDE): THE ONE IDLE AGENT AF-5 MAY NOT PROMOTE.
    //
    // An intake-driven agent whose form is not saved and stood up renders
    // `AgentSetupHero` on its own page — "it starts producing for you" — and
    // this rung painted "Live" directly above it, telling the client the
    // opposite of what the screen said.
    //
    // round 6 review (C2/C3): the input is the SETUP OBJECT, not a
    // pre-computed `readyToRun` boolean, and the gate is `agentNeedsSetup` —
    // literally the detail page's `needsSetup`, rather than a second spelling
    // of it. `null`/absent (an agent that runs on no intake) is untouched,
    // because it has no setup to finish.
    it("does not paint Live over an agent's own setup hero", () => {
      const upcoming = { launchState: null, hasUpcomingContent: true } as const;
      const unsaved = { ready: false, standUpDone: false };
      expect(rosterStatus({ ...upcoming, setup: unsaved })).toMatchObject({
        tone: "idle",
        label: "Not set up yet",
      });
      // Half-ready is still not ready: the conjunction is `agentReadyToRun`'s,
      // and no caller spells it any more.
      expect(
        rosterStatus({ ...upcoming, setup: { ready: true, standUpDone: false } }),
      ).toMatchObject({ tone: "idle", label: "Not set up yet" });
      // Delivered work is past setup whatever the rungs say right now — the
      // same escape `needsSetup` gives itself.
      expect(rosterStatus({ ...upcoming, setup: unsaved, hasDelivered: true })).toMatchObject({
        label: "Live",
      });
      // Saved and stood up: the promotion is back.
      expect(
        rosterStatus({ ...upcoming, setup: { ready: true, standUpDone: true } }),
      ).toMatchObject({ label: "Live" });
      // No intake at all: never blocked.
      expect(rosterStatus(upcoming)).toMatchObject({ label: "Live" });
    });

    it("carries a staff note saying WHY the word disagrees with the schedule", () => {
      // The client sees the word; staff see the word plus the operational truth,
      // which is the other half of the ruling. Only this rung sets it.
      const promoted = rosterStatus({ launchState: null, hasUpcomingContent: true });
      expect(promoted.staffNote).toBe(IMPORTED_CONTENT_STAFF_NOTE);
      expect(rosterStatus({ launchState: "live" }).staffNote).toBeUndefined();
      expect(
        rosterStatus({ launchState: null, scheduleActive: true, hasUpcomingContent: true })
          .staffNote,
        "a schedule that IS firing needs no explanation",
      ).toBeUndefined();
    });

    it("never reaches past a refusal or a launch narration", () => {
      // The ruling is that we stop calling a PRODUCING agent idle, not that we
      // start calling a broken one live. Only an idle outcome is eligible.
      expect(
        rosterStatus({
          launchState: "live",
          scheduleRefusal: "Out of credits.",
          hasUpcomingContent: true,
        }),
      ).toMatchObject({ tone: "attention", label: "Needs attention" });
      expect(
        rosterStatus({ launchState: "launching", hasUpcomingContent: true }),
      ).toMatchObject({ tone: "progress", label: "Setting up" });
      expect(
        rosterStatus({ launchState: "launch_failed", hasUpcomingContent: true }),
      ).toMatchObject({ tone: "attention", label: "Setup needs attention" });
    });

    it("reads Live to both readers when the last internal fire broke", () => {
      // round 6: the agents AF-5 was written for are exactly the ones whose runs
      // we fire internally, so the failed-run fact met this promotion most
      // often. It used to WIN for staff, which is how one agent read "Live" to
      // the client and "Needs attention" to us at the same instant.
      const state = { launchState: null, lastRunFailed: true, hasUpcomingContent: true } as const;
      expect(rosterStatus(state)).toEqual({
        tone: "live",
        label: "Live",
        staffNote: IMPORTED_CONTENT_STAFF_NOTE,
      });
      const staff = rosterStatus({ ...state, viewerIsStaff: true });
      expect([staff.tone, staff.label]).toEqual(["live", "Live"]);
      expect(staff.staffNote).toContain(LAST_RUN_FAILED_STAFF_NOTE);
    });
  });
});

/**
 * The admin pause (main's coming-soon roster). `enabled: false` outranks every
 * other input — including AF-5's upcoming-content promotion — because a paused
 * agent isn't live, failing, or idle: it simply isn't running for anyone.
 */
describe("rosterStatus · Coming Soon", () => {
  it("defaults to enabled when the caller omits it, unaffected", () => {
    expect(rosterStatus({ launchState: "live" })).toEqual({ tone: "live", label: "Live" });
  });

  it("says Coming Soon for a paused agent, outranking every other input", () => {
    expect(
      rosterStatus({
        launchState: "live",
        scheduleActive: true,
        hasDelivered: true,
        hasUpcomingContent: true,
        enabled: false,
      }),
    ).toEqual({ tone: "disabled", label: "Coming Soon" });
  });

  it("says Coming Soon for a paused agent with no umbrella at all", () => {
    expect(rosterStatus({ launchState: null, enabled: false })).toEqual({
      tone: "disabled",
      label: "Coming Soon",
    });
  });
});

/**
 * The ordering rule behind the badge: only the most recent run WITH A VERDICT
 * counts. An old failure followed by a success is an agent that had a bad day
 * and then worked — and a badge that remembers the failure forever is the
 * stale-refusal defect wearing a different hat.
 */
describe("lastRunFailedAgentIds", () => {
  const byName = new Map([["Instagram Agent", "ca-ig"]]);
  const job = (over: Record<string, unknown>) =>
    ({
      id: "j1",
      clientId: "c1",
      agentId: "agent-service",
      agentName: "Instagram Agent",
      status: "failed",
      createdAt: 1_000,
      external: { taskType: "custom" },
      ...over,
    }) as never;

  it("flags an agent whose most recent run failed", () => {
    expect([...lastRunFailedAgentIds([job({ customAgentId: "ca-ig" })], byName, { staff: false })]).toEqual(["ca-ig"]);
  });

  it("clears the flag when a later run succeeded — order-independently", () => {
    const older = job({ customAgentId: "ca-ig", status: "failed", createdAt: 1_000 });
    const newer = job({ customAgentId: "ca-ig", status: "delivered", createdAt: 2_000 });
    // Both input orders, because listJobs' sort is not this helper's business.
    expect(lastRunFailedAgentIds([older, newer], byName, { staff: false }).size).toBe(0);
    expect(lastRunFailedAgentIds([newer, older], byName, { staff: false }).size).toBe(0);
    // And the reverse: a success followed by a failure IS flagged.
    expect(
      lastRunFailedAgentIds(
        [
          job({ customAgentId: "ca-ig", status: "delivered", createdAt: 1_000 }),
          job({ customAgentId: "ca-ig", status: "failed", createdAt: 2_000 }),
        ],
        byName,
        { staff: false },
      ).size,
    ).toBe(1);
  });

  it("does not treat a run in flight as a failure, or as a fix", () => {
    // No verdict yet: a queued/running job alone flags nothing…
    for (const status of ["queued", "running"]) {
      expect(lastRunFailedAgentIds([job({ customAgentId: "ca-ig", status })], byName, { staff: false }).size).toBe(0);
    }
    // …and a retry now in flight does not clear the failure it is retrying.
    expect(
      lastRunFailedAgentIds(
        [
          job({ customAgentId: "ca-ig", status: "failed", createdAt: 1_000 }),
          job({ customAgentId: "ca-ig", status: "running", createdAt: 2_000 }),
        ],
        byName,
        { staff: false },
      ).size,
    ).toBe(1);
  });

  it("ignores a cancelled run — a human stopping a run is not a verdict", () => {
    expect(lastRunFailedAgentIds([job({ customAgentId: "ca-ig", status: "cancelled" })], byName, { staff: false }).size).toBe(0);
    expect(
      lastRunFailedAgentIds(
        [
          job({ customAgentId: "ca-ig", status: "failed", createdAt: 1_000 }),
          job({ customAgentId: "ca-ig", status: "cancelled", createdAt: 2_000 }),
        ],
        byName,
        { staff: false },
      ).size,
    ).toBe(1);
  });

  it("counts review and approved as landings, like jobDeliveredWork does", () => {
    for (const status of ["review", "approved", "delivered"]) {
      expect(
        lastRunFailedAgentIds(
          [
            job({ customAgentId: "ca-ig", status: "failed", createdAt: 1_000 }),
            job({ customAgentId: "ca-ig", status, createdAt: 2_000 }),
          ],
          byName,
          { staff: false },
        ).size,
      ).toBe(0);
    }
  });

  it("does not let a staff-only run move a client's badge", () => {
    // A staff member testing an agent, or a launch run, is invisible to the
    // client's run list (client-agent-rows filters both) — so neither may put
    // "Needs attention" on the client's card, pointing at a failure they can
    // neither see nor have caused. Staff, who CAN see those runs, still do.
    for (const runType of ["launch", "test"] as const) {
      const staffOnly = [job({ customAgentId: "ca-ig", status: "failed", runType })];
      expect(lastRunFailedAgentIds(staffOnly, byName, { staff: false }).size).toBe(0);
      expect(lastRunFailedAgentIds(staffOnly, byName, { staff: true }).has("ca-ig")).toBe(true);
    }
    // A client's own failed run still counts, for both.
    const clientRun = [job({ customAgentId: "ca-ig", status: "failed", runType: "scheduled" })];
    expect(lastRunFailedAgentIds(clientRun, byName, { staff: false }).has("ca-ig")).toBe(true);
  });

  it("keeps the same job scope and name fallback as its sibling", () => {
    // Non-custom jobs are not this roster's runs.
    expect(
      lastRunFailedAgentIds(
        [job({ customAgentId: "ca-ig", external: { taskType: "social_post" } })],
        byName,
        { staff: false },
      ).size,
    ).toBe(0);
    // Runs fired before customAgentId existed still attribute by name…
    expect([...lastRunFailedAgentIds([job({})], byName, { staff: false })]).toEqual(["ca-ig"]);
    // …and what cannot be attributed is dropped rather than guessed at.
    expect(lastRunFailedAgentIds([job({ agentName: "Someone Else" })], byName, { staff: false }).size).toBe(0);
  });

  it("answers per agent, not per client", () => {
    const twoAgents = new Map([
      ["Instagram Agent", "ca-ig"],
      ["X Agent", "ca-x"],
    ]);
    expect([
      ...lastRunFailedAgentIds(
        [
          job({ customAgentId: "ca-ig", status: "failed" }),
          job({ customAgentId: "ca-x", agentName: "X Agent", status: "delivered" }),
        ],
        twoAgents,
        { staff: false },
      ),
    ]).toEqual(["ca-ig"]);
  });
});

/**
 * The JOB half of "has this agent ever produced for us".
 *
 * Scope is the point of the name: this join sees jobs and nothing else, so a
 * lab import (`jobId: null`) is invisible to it. The surfaces ask
 * `agentsWithDeliveredWork`, which is this plus the asset attribution rungs —
 * see agent-detail-archetypes.test.ts for the tests that pin that, including
 * the tripwire that keeps this function's caller count at one and the agreement
 * test that pins two same-named agents to one answer each.
 *
 * It returns FACTS ABOUT THE JOBS — two sets of attribution keys — and takes no
 * agent list at all. That is what makes the caller's per-agent read independent
 * of the other agents it asked about; the tests below are about the two sets'
 * contents, not about any agent.
 */
describe("jobDeliveredWork", () => {
  const job = (over: Record<string, unknown>) =>
    ({
      id: "j1",
      clientId: "c1",
      agentId: "agent-service",
      agentName: "Instagram Agent",
      status: "delivered",
      external: { taskType: "custom" },
      ...over,
    }) as never;

  it("counts review, approved and delivered — the work exists in all three", () => {
    for (const status of ["review", "approved", "delivered"]) {
      const work = jobDeliveredWork([job({ status, customAgentId: "ca-ig" })]);
      expect([...work.ids], status).toEqual(["ca-ig"]);
    }
  });

  it("ignores runs that never landed, and non-custom jobs", () => {
    const work = jobDeliveredWork([
      job({ status: "failed", customAgentId: "ca-ig" }),
      job({ status: "queued", customAgentId: "ca-ig" }),
      job({ status: "delivered", customAgentId: "ca-ig", external: { taskType: "social_post" } }),
    ]);
    expect(work.ids.size).toBe(0);
    // Nor may a job the status/scope filter dropped leak in through the name set.
    expect(work.names.size).toBe(0);
  });

  it("keeps the agent NAME of runs fired before customAgentId existed, verbatim", () => {
    const work = jobDeliveredWork([job({})]);
    expect(work.ids.size).toBe(0);
    expect([...work.names]).toEqual(["Instagram Agent"]);
  });

  it("drops a job it can attribute by neither key rather than guessing", () => {
    // `agentName` is typed as required, but this runs over whatever Firestore
    // holds, and a nameless unbound job must not become an empty-string key that
    // some agent could match.
    const work = jobDeliveredWork([job({ agentName: "" }), job({ agentName: undefined })]);
    expect(work.ids.size).toBe(0);
    expect(work.names.size).toBe(0);
  });

  it("does NOT put a bound job's name in the name set", () => {
    // The name set is the fallback for a job with no binding, exactly as the old
    // `customAgentId ?? agentIdByName.get(name)` chain was. If a bound job's name
    // went in too, an agent that merely SHARES a display name with the agent the
    // job names would be credited with that run — a mis-credit, and wider than
    // what either surface answered before. Red if the `else` becomes unconditional.
    const work = jobDeliveredWork([job({ customAgentId: "ca-ig" })]);
    expect([...work.ids]).toEqual(["ca-ig"]);
    expect(work.names.size).toBe(0);
  });
});
