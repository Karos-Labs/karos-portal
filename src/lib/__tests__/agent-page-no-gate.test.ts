import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Albert, 2026-09-10, on an agent's page: "still looks like slop. a huge ai
 * button and then a pop up once you click it."
 *
 * The page opened with one large accent button wearing a Sparkles glyph, whose
 * only job was to open a dialog holding the fields that agent needs. Those
 * fields were never discovered on click — `custom-agent-launch.ts` declares
 * every agent's inputs as data, and the page already prefetches the intake — so
 * the press hid a known form behind a gate, and the dialog was a second place to
 * look for something the page was already about.
 *
 * These guards are about SHAPE, source-scanned on purpose: a render test would
 * pass on a page that brought the button back in a new file, and the whole
 * failure is that a gate-before-a-form is one line to re-add and always looks
 * tidy in isolation.
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const withoutComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const HERO = withoutComments(read("src/components/client-agents/agent-setup-hero.tsx"));
const RUN = withoutComments(read("src/components/custom-agents.tsx"));

describe("a client's setup form", () => {
  it("is loaded for every viewer, not staff only", () => {
    // CD-E1 kept it staff-only, so the setup section on a CLIENT's agent page
    // was a link to a separate page. The loader must not gate on the role.
    const PAGE = withoutComments(read("src/app/(app)/clients/[id]/agents/[agentId]/page.tsx"));
    const call = PAGE.slice(PAGE.indexOf("const [panes, inputDocs]"), PAGE.indexOf("readAgentInputDocs("));
    expect(call).toContain("agentIntakePane(");
    expect(call).not.toMatch(/isStaff\s*\?/);
  });
});

describe("an agent that is not set up yet", () => {
  it("shows its fields on the page instead of a button that opens them", () => {
    expect(HERO, "the setup form is drawn in the page").toMatch(/<RunCustomAgentModal[\s\S]*?\binline\b/);
    // No open/closed toggle: there is nothing to open.
    expect(HERO).not.toContain("useState");
    expect(HERO).not.toMatch(/setSettingUp|settingUp/);
  });

  it("does not put a sparkle on the thing that moves the client forward", () => {
    // A sparkle is the generic "a machine does magic here" mark. On a page that
    // is entirely about a machine it carries no information, only the tone.
    expect(HERO).not.toContain("Sparkles");
    expect(HERO).not.toMatch(/size="lg"/);
  });
});

describe("an agent that IS set up", () => {
  // The same gate lived one screen later: a "Create a new post" row with an
  // accent Sparkles button whose only job was to open the run dialog. Fixing the
  // not-set-up page alone would have moved the complaint, not answered it.
  const PANEL = withoutComments(read("src/components/client-agents/legacy-agent-panel.tsx"));

  it("draws the run form in the page", () => {
    // Which verdicts draw it is asserted on the render, in
    // legacy-panel-setup-in-page.test.tsx.
    expect(PANEL).toMatch(/<RunCustomAgentModal[\s\S]*?\binline\b/);
    expect(PANEL).not.toMatch(/setRunning|onClick=\{\(\) => setRunning/);
  });

  it("has no sparkle", () => {
    expect(PANEL).not.toContain("Sparkles");
  });

  it("shows what the run is doing when the engine has said", () => {
    expect(PANEL).toContain("<AgentRunProgress");
  });
});

describe("the run form, drawn in the page", () => {
  const at = RUN.indexOf("export function RunCustomAgentModal(");
  const body = RUN.slice(at, RUN.indexOf("function AgentEditorModal(", at));

  it("never opens a dialog of its own", () => {
    // Every frame goes through the shell switch; a bare <Modal> left in here
    // would pop a dialog out of the in-page form.
    expect(body).not.toMatch(/<Modal\b/);
  });

  it("has no dismiss button that does nothing in the page", () => {
    // Cancel, Not now, Close and Done close a dialog. In the page each must be
    // gated off (`!inline &&`) or replaced (`inline ? … :`).
    const closers = [...body.matchAll(/onClick=\{onClose\}/g)].map((m) => m.index!);
    expect(closers.length).toBeGreaterThanOrEqual(4);
    for (const i of closers) {
      const before = body.slice(Math.max(0, i - 900), i);
      expect(before, `an ungated dismiss at offset ${i}`).toMatch(/!inline &&|inline \?/);
    }
  });

  it("has one started state, driven by the watch", () => {
    expect(RUN.match(/if \(started\b/g) ?? []).toHaveLength(1);
    const branch = RUN.slice(RUN.indexOf("if (started) {"));
    expect(branch.slice(0, 4000)).toContain("outcomeOf(");
  });

  // No run duration either: the client-copy sweep (client-copy-boundary.test.ts)
  // fails on one anywhere a client reads, this form included.
});

describe("one name for the per-run steer", () => {
  it("is spelled the same way on every agent that has one", () => {
    const LAUNCH = read("src/lib/custom-agent-launch.ts");
    for (const stale of ["Anything to lean into this run?", "Anything to steer this run?"]) {
      expect(withoutComments(LAUNCH), `"${stale}" is back`).not.toContain(stale);
    }
  });
});
