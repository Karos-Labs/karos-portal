import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Control Room's agent-data chip GOES TO the agent's data page (Albert,
 * 2026-09-10). It used to open the run dialog on its data pane: a popup doing
 * what that page already does, and the last thing in Control Room that opened
 * the run form at all.
 */

vi.mock("server-only", () => ({}));
// The controls' module graph reaches the server-action barrel and two of its
// siblings. Nothing rendered here calls them.
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

import { StaffAgentControls, type AgentSetupState, type RunnableAgentSummary } from "@/components/custom-agents";

const AGENT = {
  id: "a1",
  key: "karos-x-agent-v2",
  name: "X Agent",
  enabled: true,
} as RunnableAgentSummary;

const SETUP = {
  ready: true,
  standUpDone: true,
  href: "/clients/c1/x-agent",
  label: "X agent data",
  clientLabel: "Your X details",
  kind: "x",
  data: { company: { name: "Acme" } },
} as unknown as AgentSetupState;

describe("the Control Room's agent data chip", () => {
  it("links the agent's data page", () => {
    const html = renderToStaticMarkup(
      <StaffAgentControls clientId="c1" agent={AGENT} setup={SETUP} reviewHref="/clients/c1/assets" />,
    );
    expect(html).toMatch(/<a [^>]*href="\/clients\/c1\/x-agent"[^>]*>[\s\S]*?X agent data/);
  });
});
