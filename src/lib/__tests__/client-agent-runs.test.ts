import { describe, expect, it } from "vitest";
import {
  evaluateLegacyRunGate,
  evaluateTemplateRunGate,
  moveTemplateKey,
  templateRunPrompt,
  umbrellaOwnsClientCard,
  umbrellaRunBlock,
  visibleTemplates,
} from "@/lib/client-agent-runs";
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
  const intake = { ready: false, label: "X agent data", href: "/clients/c1/x-agent" };

  it("allows a run when the service is up, intake is ready and credits cover it", () => {
    expect(evaluateLegacyRunGate(base)).toEqual({ allowed: true });
  });

  it("treats a missing intake as blocking, and says where to fix it", () => {
    const gate = evaluateLegacyRunGate({ ...base, setup: intake });
    expect(gate).toMatchObject({ allowed: false, code: "setup_missing", href: intake.href });
    expect(gate.reason).toContain("X agent data");
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
});
