import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * "More options" opens onto something, for staff too. The row was always drawn
 * for staff on the grounds that they always had the file library behind it, and
 * since SCRUM-413 the reputation runner has no file slot: a staff member opened
 * it onto an empty "Staff only" frame.
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

import { RunCustomAgentModal } from "@/components/custom-agents";

function staffForm(agent: { id: string; key: string; name: string }): string {
  return renderToStaticMarkup(
    <RunCustomAgentModal
      agent={agent as never}
      clientId="c1"
      engineDispatch={{} as never}
      contextItems={[]}
      viewerIsClient={false}
      inline
    />,
  );
}

describe("the run form's More options, for staff", () => {
  it("is not drawn when nothing is behind it", () => {
    const html = staffForm({ id: "a-rep", key: "karos-reputation-runner", name: "Reputation Runner" });
    // Non-vacuity: the form itself rendered.
    expect(html).toContain("Direction for this run (optional)");
    expect(html).not.toContain("More options");
    expect(html).not.toContain("Staff only");
  });

  it("is drawn when the file library is behind it", () => {
    const html = staffForm({ id: "a-gen", key: "some-agent", name: "Some Agent" });
    expect(html).toContain("More options");
    expect(html).toContain("Staff only");
  });
});
