import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE RUN DIALOG'S href SETUP GATE DESCRIBES THE FORM IT LINKS (#113).
 *
 * `RunCustomAgentModal` takes over with a "set it up first" card when it is
 * handed an intake-driven agent that is NOT ready and whose form the page did
 * not prefetch. Its copy used to spell the intake's shape — "the company page, a
 * seat per person, and the ongoing drops" — which is X and LinkedIn's shape and
 * WRONG for the third agent the same branch serves: Reddit's intake is one
 * account plus how mentions are handled.
 *
 * It cannot be fixed by reaching for INTAKE_ASKS, and the reason is the branch's
 * own condition. `intake` is `intakeFor(setup)` and is null exactly when
 * `setup.kind` is absent, so the one fact this branch does not have is which of
 * the three agents it is looking at. What it does have is `label` and `href`,
 * both resolved per agent by the caller — so the fix is copy that names the form
 * and claims nothing about its contents.
 *
 * ASSERTED ON THE RENDER, in both directions. The existing source assertions in
 * agent-launch-ui.test.ts pin that the branch and its link still exist; a source
 * scan cannot tell whether the sentence beside them is true, and "does not
 * mention seats" is only meaningful against markup that was actually produced.
 * Hence the positive assertions first: if the gate stops rendering at all, the
 * negatives would pass on an empty string.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions", () => ({
  createCustomAgentAction: vi.fn(),
  deleteCustomAgentAction: vi.fn(),
  runCustomAgentAction: vi.fn(),
  runCustomAgentTestAction: vi.fn(),
  setClientCustomAgentsAction: vi.fn(),
  updateCustomAgentAction: vi.fn(),
}));
vi.mock("@/lib/actions/planned-run-actions", () => ({
  configureClientAgentScheduleAction: vi.fn(),
  setPlannedRunStatusAction: vi.fn(),
}));
vi.mock("@/lib/actions/external-job-actions", () => ({
  cancelClientAgentJobAction: vi.fn(),
  refreshJobStatusAction: vi.fn(),
  retryJobAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// `Modal` portals into `document.body` and this suite runs in node. The subject
// is the gate's own copy and its link, so the chrome around it is replaced by a
// passthrough rather than the runner being given a DOM for one file — the
// children asserted below are the same either way.
vi.mock("@/components/modal", () => ({
  Modal: ({
    title,
    children,
    footer,
  }: {
    title?: string;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
      {children}
      {footer}
    </div>
  ),
}));

import { RunCustomAgentModal, type AgentSetupState } from "@/components/custom-agents";

/** The three intake-driven agents, with the href-only setup state a page ships. */
const AGENTS = [
  {
    agent: { id: "a-x", key: "karos-x-agent", name: "X Agent" },
    setup: {
      ready: false,
      standUpDone: true,
      href: "/clients/c1/x-agent",
      label: "X agent data",
      clientLabel: "Your X details",
    },
  },
  {
    agent: { id: "a-li", key: "karos-linkedin-agent", name: "LinkedIn Agent" },
    setup: {
      ready: false,
      standUpDone: true,
      href: "/clients/c1/linkedin-agent",
      label: "LinkedIn agent data",
      clientLabel: "Your LinkedIn details",
    },
  },
  {
    agent: { id: "a-rd", key: "karos-reddit-agent", name: "Reddit Agent" },
    setup: {
      ready: false,
      standUpDone: true,
      href: "/clients/c1/reddit-agent",
      label: "Reddit agent data",
      clientLabel: "Your Reddit details",
    },
  },
] satisfies Array<{ agent: { id: string; key: string; name: string }; setup: AgentSetupState }>;

function gateMarkup(entry: {
  agent: { id: string; key: string; name: string };
  setup: AgentSetupState;
}): string {
  return renderToStaticMarkup(
    <RunCustomAgentModal
      agent={{
        ...entry.agent,
        clientBlurb: "Drafts posts for your team to review.",
        icon: "Sparkles",
        color: "#A3E635",
        enabled: true,
      }}
      clientId="c1"
      // The setup gate is upstream of any engine routing, and these agents'
      // clients are not cut over: the legacy dialog, as before (T-B21).
      engineDispatch={{}}
      contextItems={[]}
      viewerIsClient
      setup={entry.setup}
      onClose={() => {}}
    />,
  );
}

const textOf = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the run dialog's setup gate, for an agent whose form was not prefetched", () => {
  for (const entry of AGENTS) {
    it(`names ${entry.agent.name}'s own form and links it`, () => {
      const markup = gateMarkup(entry);
      const text = textOf(markup);

      // Positive first: this is the gate, and it is rendering.
      expect(text).toContain(`Set up the ${entry.setup.label} first.`);
      expect(markup).toContain(`href="${entry.setup.href}"`);
      expect(text).toContain("It takes a few minutes to fill in, once.");
    });

    it(`claims nothing about the shape of ${entry.agent.name}'s intake`, () => {
      const text = textOf(gateMarkup(entry));

      // The X/LinkedIn shape, which was printed for all three. Asserted for all
      // three rather than for Reddit alone: it happened to be true of two of
      // them, and a branch that cannot tell them apart has no business saying it
      // about any.
      expect(text).not.toMatch(/seat/i);
      expect(text).not.toMatch(/company page/i);
      expect(text).not.toMatch(/subreddit/i);
      expect(text).not.toMatch(/drops/i);
    });
  }

  it("does not take over once the intake is ready", () => {
    // Non-vacuity for every assertion above: the same agent with `ready: true`
    // renders the brief instead, so the gate is keyed to readiness and not to
    // something every render of this dialog would satisfy.
    const ready = { ...AGENTS[0], setup: { ...AGENTS[0].setup, ready: true } };
    const text = textOf(gateMarkup(ready));

    expect(text).not.toContain("Set up the X agent data first.");
    // round 6: the brief's confirm was "Start run" and is now the same words as
    // the trigger and the dialog title, noun-aware per agent (F1's three
    // vocabularies). The X agent makes a post, so its dialog says "Create post".
    expect(text).toContain("Create post");
  });
});
