import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The dynamic-agent step bar, asked of the RENDER.
 *
 * Two things matter here beyond "does it paint": the tone assigned to each
 * step, and the fact that a stored per-step `error` — a raw engine diagnostic —
 * NEVER reaches the markup. That second one is the same guarantee
 * client-copy-boundary enforces for CampaignStepProgress's
 * `metadata.executionError`, and a source scan can't prove it: the field is
 * referenced in the props type either way, so only rendering a report that
 * carries an ugly error and then asserting the string is absent will do.
 */

vi.mock("server-only", () => ({}));

import { DynamicAgentStepProgress } from "@/components/dynamic-agent-step-progress";
import type { DynamicAgentRunReport, JobStatus } from "@/lib/types";

function report(patch: Partial<DynamicAgentRunReport> = {}): DynamicAgentRunReport {
  return {
    specId: "spec-1",
    specVersion: 3,
    steps: [
      { stepId: "research", type: "ai", label: "Research", status: "done", durationMs: 1200, model: "claude-sonnet-4-6" },
      { stepId: "draft", type: "ai", label: "Draft", status: "done", durationMs: 3400, model: "claude-opus-4-8" },
    ],
    ...patch,
  };
}

function paint(
  r: DynamicAgentRunReport,
  jobStatus: JobStatus = "review",
  plannedSteps?: Array<{ id: string; label: string; type: "ai" | "code" }>,
): string {
  return renderToStaticMarkup(
    <DynamicAgentStepProgress report={r} jobStatus={jobStatus} {...(plannedSteps ? { plannedSteps } : {})} />,
  );
}

describe("one row per step, toned by its own recorded status", () => {
  it("paints every executed step's label", () => {
    const html = paint(report());
    expect(html).toContain("Research");
    expect(html).toContain("Draft");
  });

  it("marks finished steps completed", () => {
    const html = paint(report());
    expect(html.match(/Completed/g)).toHaveLength(2);
    expect(html).not.toContain("Failed");
  });

  it("marks the failed step failed and the steps after it as not reached", () => {
    const html = paint(
      report({
        steps: [
          { stepId: "research", type: "ai", label: "Research", status: "done", durationMs: 10 },
          { stepId: "shape", type: "code", label: "Shape", status: "failed", durationMs: 20, error: "boom" },
        ],
        failedStepId: "shape",
        failedStepIndex: 1,
      }),
      "failed",
      [
        { id: "research", label: "Research", type: "ai" },
        { id: "shape", label: "Shape", type: "code" },
        { id: "polish", label: "Polish", type: "ai" },
      ],
    );
    expect(html).toContain("Completed");
    expect(html).toContain("Failed");
    expect(html).toContain("Not reached");
    expect(html).toContain("Polish");
  });

  it("shows only the FIRST unfinished step as working on an in-flight run", () => {
    const html = paint(
      report({ steps: [{ stepId: "a", type: "ai", label: "A", status: "done", durationMs: 5 }] }),
      "running",
      [
        { id: "a", label: "A", type: "ai" },
        { id: "b", label: "B", type: "ai" },
        { id: "c", label: "C", type: "ai" },
      ],
    );
    expect(html.match(/Working/g)).toHaveLength(1);
    expect(html.match(/Not started/g)).toHaveLength(1);
  });

  it("falls back to the executed steps when the caller has no spec snapshot to plan from", () => {
    const html = paint(report(), "review");
    expect(html).toContain("Research");
    expect(html).toContain("Draft");
    expect(html).not.toContain("Not reached");
  });
});

describe("what a client is allowed to read", () => {
  it("never prints the stored raw engine error, only the fixed sentence", () => {
    const html = paint(
      report({
        steps: [
          {
            stepId: "shape",
            type: "code",
            label: "Shape",
            status: "failed",
            durationMs: 3,
            error: "Traceback (most recent call last): KeyError 'company_name' at line 12",
          },
        ],
        failedStepId: "shape",
      }),
      "failed",
    );
    expect(html).not.toContain("Traceback");
    expect(html).not.toContain("KeyError");
    expect(html).not.toContain("line 12");
    expect(html).toContain("This step hit a problem. Your Karos team is on it.");
  });

  it("does not print the concrete model id — per-step routing is a staff detail", () => {
    const html = paint(report());
    expect(html).not.toContain("claude-opus-4-8");
    expect(html).not.toContain("claude-sonnet-4-6");
  });

  it("says the deliverable is incomplete when a failed run still produced partial output", () => {
    const html = paint(
      report({
        steps: [{ stepId: "a", type: "ai", label: "A", status: "done", durationMs: 1 }],
        failedStepId: "b",
        hasPartialOutput: true,
      }),
      "failed",
    );
    expect(html).toMatch(/stopped partway through/i);
    expect(html).toMatch(/incomplete/i);
  });

  it("does not claim partial output when there is none to show", () => {
    const html = paint(report({ failedStepId: "a", hasPartialOutput: false }), "failed");
    expect(html).not.toMatch(/stopped partway through/i);
  });

  it("is English-only", () => {
    expect(paint(report())).not.toMatch(/[֐-׿]/);
  });
});
