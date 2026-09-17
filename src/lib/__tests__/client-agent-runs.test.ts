import { describe, expect, it } from "vitest";
import {
  evaluateLegacyRunGate,
  evaluateTemplateRunGate,
  moveTemplateKey,
  noRunnableTemplateReason,
  templateRunPrompt,
  umbrellaOwnsClientCard,
  umbrellaRunBlock,
  visibleTemplates,
} from "@/lib/client-agent-runs";
import { rosterStatus } from "@/lib/client-agents";
import type { ClientAgentLaunchState, ClientAgentTemplate } from "@/lib/types";

function template(
  key: string,
  overrides: Partial<ClientAgentTemplate> = {},
): ClientAgentTemplate {
  return {
    key,
    name: key.replace(/-/g, " "),
    status: "active",
    position: 0,
    source: "launch",
    addedAt: 0,
    ...overrides,
  };
}

/* ─────────────────── §2 guard rail: not-live umbrellas ─────────────────── */

describe("umbrellaRunBlock", () => {
  it("lets a live umbrella through and blocks every other state", () => {
    expect(umbrellaRunBlock("live")).toBeNull();
    const blocked: ClientAgentLaunchState[] = [
      "not_launched",
      "launching",
      "curating",
      "launch_failed",
    ];
    for (const state of blocked) {
      const block = umbrellaRunBlock(state);
      expect(block, state).not.toBeNull();
      expect(block?.reason.length).toBeGreaterThan(0);
    }
  });

  it("says the same thing about launching and curating — 'curating' is staff vocabulary", () => {
    expect(umbrellaRunBlock("launching")).toEqual(umbrellaRunBlock("curating"));
  });

  it("never names content that might already exist", () => {
    const states: ClientAgentLaunchState[] = [
      "not_launched",
      "launching",
      "curating",
      "launch_failed",
    ];
    for (const state of states) {
      const reason = umbrellaRunBlock(state)?.reason ?? "";
      expect(reason.toLowerCase(), state).not.toMatch(/draft|batch|already (made|written|produced)/);
    }
  });
});

/* ─────────────────────── the per-template run gate ─────────────────────── */

describe("evaluateTemplateRunGate", () => {
  const base = { templateStatus: "active" as const, cost: 25 };

  it("refuses a run while the umbrella is not live, whatever the credits say", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      launchState: "launching",
      availableCredits: 10_000,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.code).toBe("setup_running");
  });

  // Order is the point: a client who is mid-setup AND broke must be told about
  // the setup, because that is what the server refuses on — "top up your
  // credits" would send them to buy something that still would not run.
  it("names the setup before the credits when both block", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      launchState: "not_launched",
      availableCredits: 0,
      creditBlockReason: "Not enough credits.",
    });
    expect(gate.allowed === false && gate.code).toBe("setup_not_started");
  });

  it("blocks a paused template on a live umbrella", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      templateStatus: "paused",
      launchState: "live",
      availableCredits: 500,
    });
    expect(gate.allowed === false && gate.code).toBe("template_paused");
  });

  it("passes the binding-limit line through rather than inventing one", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      launchState: "live",
      availableCredits: 5,
      creditBlockReason: "Weekly limit reached (100 of 100 used).",
    });
    expect(gate.allowed === false && gate.code).toBe("credits_short");
    expect(gate.allowed === false && gate.reason).toContain("Weekly limit");
  });

  it("charges nothing and blocks on nothing for a non-billable actor", () => {
    const gate = evaluateTemplateRunGate({ ...base, launchState: "live" });
    expect(gate).toEqual({ allowed: true, cost: 0 });
  });

  it("allows a live, active, affordable run at the agent's flat price", () => {
    expect(
      evaluateTemplateRunGate({ ...base, launchState: "live", availableCredits: 25 }),
    ).toEqual({ allowed: true, cost: 25 });
  });

  /*
   * The intake rung (F131 re-entry). A LIVE X/LinkedIn umbrella with no intake
   * used to clear this gate entirely, so the detail page painted "Set it up" in
   * its sidebar while "Create new post" sat enabled next to it — and the submit
   * core then refused, pre-charge, on exactly that intake.
   */
  const intake = { ready: false, clientLabel: "Your X details", href: "/clients/c1/x-agent" };

  it("blocks a live umbrella whose intake was never filled in", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      launchState: "live",
      setup: intake,
      availableCredits: 500,
    });
    expect(gate.allowed === false && gate.code).toBe("setup_missing");
    expect(gate.allowed === false && gate.reason).toContain("Your X details");
  });

  it("lets a ready intake through", () => {
    expect(
      evaluateTemplateRunGate({
        ...base,
        launchState: "live",
        setup: { ...intake, ready: true },
        availableCredits: 25,
      }),
    ).toEqual({ allowed: true, cost: 25 });
  });

  it("blocks a non-billable actor too — the submit core hard-gates intake for staff as well", () => {
    const gate = evaluateTemplateRunGate({ ...base, launchState: "live", setup: intake });
    expect(gate.allowed === false && gate.code).toBe("setup_missing");
  });

  // Ladder ordering, both directions around the new rung.
  it("puts the missing intake ABOVE credits — do not sell a run that cannot happen", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      launchState: "live",
      setup: intake,
      availableCredits: 0,
      creditBlockReason: "Weekly cap reached.",
    });
    expect(gate.allowed === false && gate.code).toBe("setup_missing");
  });

  it("puts the umbrella's own setup ABOVE the intake — the launch card is that story", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      launchState: "launching",
      setup: intake,
      availableCredits: 0,
    });
    expect(gate.allowed === false && gate.code).toBe("setup_running");
  });

  it("puts a paused format ABOVE the intake — the row's own switch is the nearer fix", () => {
    const gate = evaluateTemplateRunGate({
      ...base,
      templateStatus: "paused",
      launchState: "live",
      setup: intake,
      availableCredits: 0,
    });
    expect(gate.allowed === false && gate.code).toBe("template_paused");
  });

  it("matches evaluateLegacyRunGate's own intake ordering", () => {
    const template = evaluateTemplateRunGate({
      ...base,
      launchState: "live",
      setup: intake,
      availableCredits: 0,
    });
    const legacy = evaluateLegacyRunGate({
      serviceConfigured: true,
      setup: intake,
      cost: base.cost,
      availableCredits: 0,
    });
    expect(template.allowed === false && template.code).toBe(legacy.code);
    expect(template.allowed === false && template.reason).toBe(legacy.reason);
  });

  it("matches evaluateLegacyRunGate's STAND-UP rung too, word for word", () => {
    // The umbrella ladder is the less reachable of the two, and that is exactly
    // how the intake rung came to be missing from it — the test above exists
    // because of it. Same shape, same position, one shared string.
    const stoodDown = { ready: true, standUpDone: false, clientLabel: "Your LinkedIn details", href: "/clients/c1/linkedin-agent" };
    const template = evaluateTemplateRunGate({
      ...base,
      launchState: "live",
      setup: stoodDown,
      availableCredits: 0,
    });
    const legacy = evaluateLegacyRunGate({
      serviceConfigured: true,
      setup: stoodDown,
      cost: base.cost,
      availableCredits: 0,
    });
    expect(template.allowed === false && template.code).toBe("stand_up_required");
    expect(template.allowed === false && template.code).toBe(legacy.code);
    expect(template.allowed === false && template.reason).toBe(legacy.reason);
  });
});

/* ───────────── no template to run at all (empty live registry) ──────────── */

describe("noRunnableTemplateReason", () => {
  it("says nothing while the agent HAS formats — a gate is what explains those", () => {
    expect(noRunnableTemplateReason({ optionsMode: false, hasTemplates: true })).toBeNull();
    expect(noRunnableTemplateReason({ optionsMode: true, hasTemplates: true })).toBeNull();
  });

  it("explains the options-mode agent as a final shape, not a gap", () => {
    const reason = noRunnableTemplateReason({ optionsMode: true, hasTemplates: false });
    expect(reason).toContain("one post a day");
  });

  it("explains an unseeded registry as setup still in progress", () => {
    const reason = noRunnableTemplateReason({ optionsMode: false, hasTemplates: false });
    expect(reason).toContain("Karos team");
  });

  it("never says anything about work that may already exist (A3/A4)", () => {
    for (const optionsMode of [true, false]) {
      const reason = noRunnableTemplateReason({ optionsMode, hasTemplates: false }) ?? "";
      expect(reason.toLowerCase(), String(optionsMode)).not.toMatch(
        /draft|batch|queue|already (made|written|produced)/,
      );
    }
  });
});

/* ───────────────────────────── the pinned prompt ───────────────────────── */

describe("templateRunPrompt", () => {
  it("pins the run to exactly one post of the named template", () => {
    const prompt = templateRunPrompt({
      agentName: "Instagram Agent",
      templateName: "By The Numbers",
      templateKey: "by-the-numbers",
      rationale: "Their audience responds to hard figures.",
    });
    expect(prompt).toContain("exactly 1 post");
    expect(prompt).toContain("By The Numbers");
    expect(prompt).toContain("by-the-numbers");
    expect(prompt).toContain("hard figures");
  });

  it("works without a rationale", () => {
    const prompt = templateRunPrompt({
      agentName: "Instagram Agent",
      templateName: "Founder Story",
      templateKey: "founder-story",
    });
    expect(prompt).toContain("exactly 1 post");
    expect(prompt).not.toContain("undefined");
  });
});

/* ───────────────────────────── ordering helpers ────────────────────────── */

describe("moveTemplateKey", () => {
  const keys = ["a", "b", "c"];

  it("swaps with the neighbour in the named direction", () => {
    expect(moveTemplateKey(keys, "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveTemplateKey(keys, "b", "down")).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the ends and for an unknown key", () => {
    expect(moveTemplateKey(keys, "a", "up")).toEqual(keys);
    expect(moveTemplateKey(keys, "c", "down")).toEqual(keys);
    expect(moveTemplateKey(keys, "z", "up")).toEqual(keys);
  });
});

describe("visibleTemplates", () => {
  it("keeps paused rows (you cannot resume what you cannot see) and drops retired ones", () => {
    const rows = visibleTemplates({
      templates: [
        template("c", { position: 2 }),
        template("gone", { position: 1, status: "retired" }),
        template("a", { position: 0, status: "paused" }),
      ],
    });
    expect(rows.map((t) => t.key)).toEqual(["a", "c"]);
  });
});

/* ─────────────────────── which card a client is given ──────────────────── */

describe("umbrellaOwnsClientCard", () => {
  it("owns the card in every pre-live state", () => {
    for (const state of ["not_launched", "launching", "curating", "launch_failed"] as const) {
      expect(umbrellaOwnsClientCard({ launchState: state, templates: [] }), state).toBe(true);
    }
  });

  // W6: binding an already-producing agent used to take away its Run button
  // and its schedule row on the spot. A live umbrella with nothing to render
  // does not get to replace a working card.
  it("does NOT own the card while a live single-mode umbrella has no templates", () => {
    expect(umbrellaOwnsClientCard({ launchState: "live", templates: [], slotMode: "single" })).toBe(
      false,
    );
    expect(
      umbrellaOwnsClientCard({
        launchState: "live",
        templates: [template("numbers")],
        slotMode: "single",
      }),
    ).toBe(true);
  });

  it("owns the card for an options-mode umbrella, whose empty registry is final", () => {
    expect(umbrellaOwnsClientCard({ launchState: "live", templates: [], slotMode: "options" })).toBe(
      true,
    );
  });

  it("ignores retired templates — they are history, not something to render", () => {
    expect(
      umbrellaOwnsClientCard({
        launchState: "live",
        templates: [template("old", { status: "retired" })],
        slotMode: "single",
      }),
    ).toBe(false);
  });
});

/**
 * CD-H8 — the run gate for an agent with a live schedule and no umbrella.
 *
 * Karos Labs' own Instagram Agent is this shape: it predates the umbrella model
 * and its detail page used to render a stub. The gate is the sibling of
 * evaluateTemplateRunGate for a shape with no templates to gate on, and its
 * ORDER is the part worth pinning.
 */
describe("evaluateLegacyRunGate", () => {
  const base = { serviceConfigured: true, cost: 25, availableCredits: 100 };
  const intake = { ready: false, clientLabel: "Your X details", href: "/clients/c1/x-agent" };

  it("allows a run when the service is up, intake is ready and credits cover it", () => {
    expect(evaluateLegacyRunGate(base)).toEqual({ allowed: true });
  });

  it("treats a missing intake as blocking, and says where to fix it", () => {
    const gate = evaluateLegacyRunGate({ ...base, setup: intake });
    expect(gate).toMatchObject({ allowed: false, code: "setup_missing", href: intake.href });
    expect(gate.reason).toContain("Your X details");
  });

  it("blocks on credits with the limit that actually bit", () => {
    const gate = evaluateLegacyRunGate({
      ...base,
      availableCredits: 5,
      creditBlockReason: "Weekly cap reached.",
    });
    expect(gate).toMatchObject({ allowed: false, code: "credits_short" });
    expect(gate.reason).toBe("Weekly cap reached.");
  });

  it("lets a ready intake through", () => {
    expect(
      evaluateLegacyRunGate({ ...base, setup: { ...intake, ready: true } }),
    ).toEqual({ allowed: true });
  });

  it("never blocks a non-billable actor on credits", () => {
    // Staff pay nothing, so the credit rung cannot apply to them.
    const { availableCredits: _omitted, ...staff } = base;
    expect(evaluateLegacyRunGate(staff)).toEqual({ allowed: true });
  });

  it("puts an outage ABOVE a missing intake — filling it in would not help", () => {
    const gate = evaluateLegacyRunGate({
      ...base,
      serviceConfigured: false,
      setup: intake,
      availableCredits: 0,
    });
    expect(gate.code).toBe("service_down");
  });

  it("puts a missing intake ABOVE credits — do not sell a run that cannot happen", () => {
    const gate = evaluateLegacyRunGate({ ...base, setup: intake, availableCredits: 0 });
    expect(gate.code).toBe("setup_missing");
  });

  /* ── the LinkedIn v2 stand-up rung ── */

  const li = { ready: true, clientLabel: "Your LinkedIn details", href: "/clients/c1/linkedin-agent" };

  it("blocks a saved-but-never-stood-up agent, and points at the press that fixes it", () => {
    // The state Karos Labs was actually in: company form saved, three seats,
    // three news drops — and no `foundation` row, because the one-time stand-up
    // run had never fired. `ready` says yes and the submit core says no, so
    // without this rung the band offered a press that could only be refused.
    const gate = evaluateLegacyRunGate({ ...base, setup: { ...li, standUpDone: false } });
    expect(gate).toMatchObject({
      allowed: false,
      code: "stand_up_required",
      href: li.href,
      hrefLabel: "Set it up",
    });
    // Not phrased as missing answers — theirs are all in. It is a run that has
    // not happened.
    expect(gate.reason).not.toContain("missing");
  });

  it("does not fire for an agent that HAS been stood up", () => {
    expect(evaluateLegacyRunGate({ ...base, setup: { ...li, standUpDone: true } })).toEqual({
      allowed: true,
    });
  });

  it("does not fire for a caller that predates the field", () => {
    // Absent means "this family has no stand-up run" (X, Reddit) or "an older
    // caller" — either way it must not invent a refusal.
    expect(evaluateLegacyRunGate({ ...base, setup: li })).toEqual({ allowed: true });
  });

  it("puts stand-up ABOVE credits, and BELOW a missing intake", () => {
    // A client who cannot run at all must not first be told to buy credits.
    expect(
      evaluateLegacyRunGate({
        ...base,
        setup: { ...li, standUpDone: false },
        availableCredits: 0,
      }).code,
    ).toBe("stand_up_required");
    // And a form that was never saved outranks it: the stand-up run reads that
    // form, so asking for the run first would be the wrong instruction.
    expect(
      evaluateLegacyRunGate({
        ...base,
        setup: { ...li, ready: false, standUpDone: false },
      }).code,
    ).toBe("setup_missing");
  });
});

/* ─────────── the badge over the button: "Not set up yet" vs "Runs on request" ─────────── */

describe("rosterStatus tells the truth about an agent that has never been asked", () => {
  const base = { launchState: null, scheduleActive: false } as const;

  it("says Runs on request once it CAN run, not only once it HAS run", () => {
    // The bug this pins: the label used to key on delivered work alone, so a
    // fully stood-up agent that nobody had asked for anything yet read "Not set
    // up yet" — directly above a working Run button. Invisible on X (it has
    // delivered twice) and waiting for the first LinkedIn client the moment
    // their stand-up run finished.
    // round 6 review (C2): the readiness pair is handed over whole and
    // `agentReadyToRun` owns the conjunction, so no caller spells it.
    expect(
      rosterStatus({ ...base, hasDelivered: false, setup: { ready: true, standUpDone: true } }),
    ).toEqual({
      tone: "idle",
      label: "Runs on request",
    });
  });

  it("still says Not set up yet while either readiness question is unanswered", () => {
    // True for LinkedIn today: the forms are saved but the stand-up run has not
    // happened, so the phrase is accurate — and the band beneath it is what
    // explains which step is missing.
    // round 6 review (C2): either rung false is "not ready" — the conjunction
    // lives in `agentReadyToRun` now.
    expect(
      rosterStatus({ ...base, hasDelivered: false, setup: { ready: true, standUpDone: false } }),
    ).toEqual({
      tone: "idle",
      label: "Not set up yet",
    });
  });

  it("does not guess for an agent that runs on no intake at all", () => {
    // Absent means "cannot answer", which must fall back to the delivered-work
    // rule rather than to optimism.
    expect(rosterStatus({ ...base, hasDelivered: false })).toEqual({
      tone: "idle",
      label: "Not set up yet",
    });
    expect(rosterStatus({ ...base, hasDelivered: true })).toEqual({
      tone: "idle",
      label: "Runs on request",
    });
  });
});
