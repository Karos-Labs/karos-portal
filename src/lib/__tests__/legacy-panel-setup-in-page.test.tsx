import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A delivered agent whose data went missing since is set up again ON its page
 * (Albert, 2026-09-10: clients fill setup on the agent page). It used to show a
 * refusal and a link to another page, while an agent that had never delivered
 * got the in-page form: the same missing data, two different answers.
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/" }));

import { LegacyAgentPanel } from "@/components/client-agents/legacy-agent-panel";
import type { AgentSetupState } from "@/components/custom-agents";

const BASE = {
  ready: false,
  standUpDone: true,
  href: "/clients/c1/reddit-agent",
  label: "Reddit agent data",
  clientLabel: "Your Reddit details",
};
const GATE = {
  allowed: false as const,
  code: "setup_missing" as const,
  reason: "Your Reddit details are missing. This agent needs them before it can make a reply.",
  href: BASE.href,
  hrefLabel: BASE.clientLabel,
};

function panel(setup: AgentSetupState): string {
  return renderToStaticMarkup(
    <LegacyAgentPanel
      clientId="c1"
      agent={{ id: "a1", key: "karos-reddit-runner", name: "Reddit Runner" } as never}
      engineDispatch={{} as never}
      gate={GATE}
      noun="reply"
      setup={setup}
      contextItems={[]}
      viewerIsClient
    />,
  );
}

describe("a delivered agent with its data missing", () => {
  it("opens the data form in the page", () => {
    const html = panel({
      ...BASE,
      kind: "reddit",
      data: { clientId: "c1", company: null, feedback: [], runs: [], isStaff: false },
    } as AgentSetupState);
    expect(html).toContain("Your Reddit details");
    expect(html).not.toContain("is not available yet");
  });

  it("falls back to the link when the page has no form to draw", () => {
    const html = panel(BASE as AgentSetupState);
    expect(html).toContain("Making a reply now is not available yet.");
    expect(html).toContain(`href="${BASE.href}"`);
  });
});
