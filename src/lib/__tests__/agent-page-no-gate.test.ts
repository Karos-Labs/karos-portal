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

  it("draws the run form in the page, gated by the server's verdict", () => {
    expect(PANEL).toMatch(/<RunCustomAgentModal[\s\S]*?\binline\b/);
    expect(PANEL).toMatch(/gate\.allowed \?/);
    expect(PANEL).not.toMatch(/setRunning|onClick=\{\(\) => setRunning/);
  });

  it("has no sparkle and no quoted duration", () => {
    expect(PANEL).not.toContain("Sparkles");
    expect(PANEL).not.toContain("RUN_ESTIMATE_SENTENCE");
  });

  it("shows what the run is doing when the engine has said", () => {
    expect(PANEL).toContain("<AgentRunProgress");
  });
});

describe("the run form, drawn in the page", () => {
  it("chooses its frame with one switch, so the run logic is shared", () => {
    expect(RUN).toContain("const Shell = inline ? InlinePanel : Modal");
    // Every frame inside the run component goes through that switch — a bare
    // <Modal> left behind would pop a dialog out of the in-page form.
    const at = RUN.indexOf("export function RunCustomAgentModal(");
    const end = RUN.indexOf("function AgentEditorModal(", at);
    const body = RUN.slice(at, end);
    expect(body).not.toMatch(/<Modal\b/);
  });

  it("offers no dismiss button that does nothing in the page", () => {
    // "Cancel", "Not now" and "Close" close a dialog. In the page they would be
    // controls with no effect, which is worse than no control.
    const at = RUN.indexOf("export function RunCustomAgentModal(");
    const body = RUN.slice(at, RUN.indexOf("function AgentEditorModal(", at));
    for (const label of ["Cancel", "Not now"]) {
      const i = body.indexOf(`>\n                    ${label}`) >= 0 ? body.indexOf(label) : body.indexOf(label);
      if (i < 0) continue;
      const before = body.slice(Math.max(0, i - 260), i);
      expect(before, `"${label}" is not gated off the in-page form`).toMatch(/!inline &&/);
    }
  });

  it("has ONE started state, drawn through the same shell, driven by the watch", () => {
    // The dialog that said "your post is on its way, ready in N minutes" was a
    // dead end. SCRUM-416 (Shlomi) replaced its content with the run's live
    // status from the shell-level watch; this branch then gave it an in-page
    // frame. What must not happen is a SECOND renderer for the same state — a
    // separate in-page branch did exist briefly, and two answers to "is my run
    // working" is the drift this file keeps paying for.
    expect(RUN.match(/if \(started\b/g) ?? []).toHaveLength(1);
    const at = RUN.indexOf("if (started) {");
    const branch = RUN.slice(at, RUN.indexOf("\n  }\n", at));
    expect(branch).toContain("<Shell");
    expect(branch).toContain("outcomeOf(");
    // In the page there is no dialog to close, so its next gesture is another run.
    expect(branch).toMatch(/inline \?[\s\S]*?Start another/);
  });

  it("promises no readiness time before the run starts", () => {
    // A run goes to review before it reaches anyone, so it is not READY when
    // the agent finishes, at any number of minutes.
    expect(RUN).not.toMatch(/`ready in \$\{RUN_ESTIMATE_SENTENCE\}`/);
  });
});

describe("one name for the per-run steer", () => {
  it("is spelled the same way on every agent that has one", () => {
    const LAUNCH = read("src/lib/custom-agent-launch.ts");
    for (const stale of ["Anything to lean into this run?", "Anything to steer this run?"]) {
      expect(withoutComments(LAUNCH), `"${stale}" is back`).not.toContain(stale);
    }
  });
});
