import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));

import { JobStepCostTable } from "@/components/job-step-cost-table";
import type { JobStepBreakdownEntry } from "@/lib/types";

function entry(patch: Partial<JobStepBreakdownEntry> = {}): JobStepBreakdownEntry {
  return { stepId: "a", stepName: "Angles", stepType: "ai", durationMs: 1000, status: "completed", ...patch };
}

describe("JobStepCostTable", () => {
  it("renders nothing when there are no steps", () => {
    expect(renderToStaticMarkup(<JobStepCostTable steps={[]} />)).toBe("");
  });

  it("shows the estimate disclaimer only when a row is marked estimated", () => {
    const exact = renderToStaticMarkup(<JobStepCostTable steps={[entry({ costUsd: 0.5 })]} />);
    expect(exact).not.toMatch(/estimated/i);

    const estimated = renderToStaticMarkup(<JobStepCostTable steps={[entry({ costUsd: 0.5, estimated: true })]} />);
    expect(estimated).toMatch(/estimated from step timing/i);
  });

  it("highlights the single most expensive step", () => {
    const html = renderToStaticMarkup(
      <JobStepCostTable
        steps={[
          entry({ stepId: "cheap", stepName: "Cheap", costUsd: 0.01 }),
          entry({ stepId: "pricey", stepName: "Pricey", costUsd: 5.0 }),
        ]}
      />,
    );
    // Sorted descending — the pricey step's name appears before the cheap one's.
    expect(html.indexOf("Pricey")).toBeLessThan(html.indexOf("Cheap"));
    expect(html).toContain("text-neon");
  });

  it("shows a dash instead of a fabricated $0 when cost is unknown for a step", () => {
    const html = renderToStaticMarkup(<JobStepCostTable steps={[entry({ costUsd: undefined })]} />);
    expect(html).toContain("-</td>");
  });

  it("shows a Failed badge for a failed step", () => {
    const html = renderToStaticMarkup(<JobStepCostTable steps={[entry({ status: "failed" })]} />);
    expect(html).toContain("Failed");
  });
});
