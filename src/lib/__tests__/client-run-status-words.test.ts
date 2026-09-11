import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClientAgentRunHistory } from "@/components/client-agents/client-agent-run-history";
import { IntakeRunRows } from "@/components/intake-run-rows";
import { JOB_STATUS_META, jobStatusLabel } from "@/lib/job-status-copy";
import type { JobStatus } from "@/lib/types";

/**
 * A client is never told their work is being reviewed or was approved (the
 * portal-revamp SOW rule Albert kept on 2026-09-10). Run states were where it
 * still leaked: a run waiting at the human check read "In review" on the
 * client's own agent page, in both run histories.
 */
describe("the run states a client reads", () => {
  it("never name the review or the approval", () => {
    for (const status of Object.keys(JOB_STATUS_META) as JobStatus[]) {
      expect(jobStatusLabel(status, true), status).not.toMatch(/review|approv/i);
    }
    expect(jobStatusLabel("review", true)).toBe("Done");
    // Staff keep the real state: the review is theirs to do.
    expect(jobStatusLabel("review")).toBe("In review");
    expect(jobStatusLabel("approved")).toBe("Approved");
  });

  it("reach the intake card's run rows, for a client only", () => {
    const run = { id: "j1", status: "review" as const, createdAt: Date.UTC(2026, 8, 1) };
    const rows = (isStaff: boolean) =>
      renderToStaticMarkup(
        createElement(IntakeRunRows, { clientId: "c1", family: "linkedin", runs: [run], isStaff }),
      );
    expect(rows(false)).toContain("Done");
    expect(rows(false)).not.toContain("In review");
    expect(rows(true)).toContain("In review");
  });

  it("reach the agent page's run history, for staff too", () => {
    // It is the client's view of their runs; staff read the real state in
    // Control Room.
    const html = renderToStaticMarkup(
      createElement(ClientAgentRunHistory, {
        runs: [
          { id: "j1", agentName: "LinkedIn", label: "LinkedIn", status: "review", createdAt: 1, assetCount: 1 },
          { id: "j2", agentName: "LinkedIn", label: "LinkedIn", status: "approved", createdAt: 2, assetCount: 1 },
        ],
      }),
    );
    expect(html).toContain("Done");
    expect(html).not.toMatch(/In review|Approved/);
  });
});
