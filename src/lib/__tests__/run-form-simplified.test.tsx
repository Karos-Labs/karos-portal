import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The agent page's run form, with fewer things on it (Albert, 2026-09-10:
 * "still a little bit too much going on … reduce number of elements"). Gone: a
 * title that repeated the button, a description that repeated the page header,
 * the data chip above the question, three "Try:" chips, the helper line that
 * restated "(optional)", and "you can leave this page". The price is the
 * footer's one line, for staff too.
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

import { RunCustomAgentModal, type AgentSetupState } from "@/components/custom-agents";

function form(viewerIsClient: boolean): string {
  const setup = {
    ready: true,
    standUpDone: true,
    href: "/clients/c1/reddit-agent",
    label: "Reddit agent data",
    clientLabel: "Your Reddit details",
    kind: "reddit",
    data: { clientId: "c1", company: { name: "Acme" }, feedback: [], runs: [], isStaff: !viewerIsClient },
  } as unknown as AgentSetupState;
  return renderToStaticMarkup(
    <RunCustomAgentModal
      agent={{ id: "a-red", key: "karos-reddit-runner", name: "Reddit Agent" } as never}
      clientId="c1"
      engineDispatch={{} as never}
      contextItems={[]}
      viewerIsClient={viewerIsClient}
      setup={setup}
      inline
    />,
  );
}

describe("the agent page's run form", () => {
  it("is the question, one quiet row and the button", () => {
    const html = form(true);
    // Non-vacuity: the run form itself rendered.
    expect(html).toContain("Direction for this run (optional)");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("Try:");
    expect(html).not.toMatch(/you can leave this page/i);
    expect(html).not.toContain("The agent picks the thread");
    // The way to this agent's data is a quiet link in the client's words.
    expect(html).toMatch(/<button[^>]*>Your Reddit details<\/button>/);
  });

  it("puts the price in the footer for both readers, and says whose it is to staff", () => {
    expect(form(true)).not.toContain("billed to the client");
    expect(form(false)).toContain("billed to the client");
    expect(form(false)).toMatch(/<button[^>]*>Reddit agent data<\/button>/);
  });
});
