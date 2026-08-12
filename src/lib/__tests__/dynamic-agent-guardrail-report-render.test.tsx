import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The staff-facing findings card (docs/dynamic-agent-guardrails.md).
 *
 * Same `renderToStaticMarkup` recipe the rest of this repo's "use client"
 * render tests use. The assertions worth having are the ones about what the
 * card says in each state — a check that did not run must not paint like a
 * check that passed, which is the single most misleading thing this component
 * could do.
 */

vi.mock("server-only", () => ({}));

import { DynamicAgentGuardrailReportCard } from "@/components/dynamic-agent-guardrail-report";
import type { DynamicAgentDedupeReport, DynamicAgentGuardrailReport } from "@/lib/types";

function paint(props: { guardrail?: DynamicAgentGuardrailReport; dedupe?: DynamicAgentDedupeReport }): string {
  return renderToStaticMarkup(<DynamicAgentGuardrailReportCard {...props} />);
}

describe("renders nothing when neither check ran", () => {
  it("returns no markup at all", () => {
    // A job from before this existed, or one where both features were off,
    // must look exactly as it did.
    expect(paint({})).toBe("");
  });
});

describe("topic guardrails", () => {
  const base: DynamicAgentGuardrailReport = {
    forbiddenTopics: ["competitor pricing", "pending litigation"],
    injectedStepIds: ["research", "write"],
  };

  it("shows a clean verdict", () => {
    const html = paint({
      guardrail: { ...base, verification: { status: "clean", violatedTopics: [], durationMs: 100 } },
    });
    expect(html).toMatch(/clean/i);
    expect(html).toContain("2 topics in force");
    expect(html).toContain("2 steps");
  });

  it("names the violated topic and quotes the evidence", () => {
    const html = paint({
      guardrail: {
        ...base,
        verification: {
          status: "violation",
          violatedTopics: ["competitor pricing"],
          evidence: "we beat them on price",
          durationMs: 100,
        },
      },
    });
    expect(html).toMatch(/flagged/i);
    expect(html).toContain("competitor pricing");
    expect(html).toContain("we beat them on price");
  });

  it("says the check could not be completed on an error — never that it passed", () => {
    const html = paint({
      guardrail: { ...base, verification: { status: "error", violatedTopics: [], durationMs: 100 } },
    });
    expect(html).toMatch(/could not be completed/i);
    expect(html).not.toMatch(/clean/i);
  });

  it("says NOT CHECKED when the run never produced a deliverable", () => {
    // A failed run records which steps carried the constraint but has no
    // verification. Painting a green tick here would be a lie.
    const html = paint({ guardrail: base });
    expect(html).toMatch(/not checked/i);
    expect(html).not.toMatch(/clean/i);
  });

  it("uses singular wording for a single topic", () => {
    const html = paint({
      guardrail: { forbiddenTopics: ["x"], injectedStepIds: ["a"] },
    });
    expect(html).toContain("1 topic in force");
    expect(html).toContain("1 step");
  });
});

describe("repetition check", () => {
  it("reports a distinct draft with the closest score", () => {
    const html = paint({
      dedupe: { status: "ok", comparedCount: 3, maxSimilarity: 0.12, threshold: 0.4 },
    });
    expect(html).toMatch(/distinct/i);
    expect(html).toContain("12%");
    expect(html).toContain("3 earlier drafts");
  });

  it("flags a near-duplicate with its score", () => {
    const html = paint({
      dedupe: { status: "similar", comparedCount: 2, maxSimilarity: 0.71, threshold: 0.4, mostSimilarJobId: "job-old" },
    });
    expect(html).toMatch(/flagged/i);
    expect(html).toContain("71%");
  });

  it("says there is nothing to compare against on a first run", () => {
    const html = paint({ dedupe: { status: "no_history", comparedCount: 0, maxSimilarity: 0, threshold: 0.4 } });
    expect(html).toMatch(/no earlier drafts/i);
    // No "0 earlier drafts compared" line — there was nothing to compare.
    expect(html).not.toContain("Compared against");
  });

  it("states the threshold it judged against", () => {
    const html = paint({ dedupe: { status: "ok", comparedCount: 1, maxSimilarity: 0.1, threshold: 0.4 } });
    expect(html).toContain("40%");
  });
});

describe("the two sections are independent", () => {
  it("renders the guardrail alone", () => {
    const html = paint({ guardrail: { forbiddenTopics: ["x"], injectedStepIds: ["a"] } });
    expect(html).toContain("Topic guardrails");
    expect(html).not.toContain("Repetition check");
  });

  it("renders the repetition check alone", () => {
    const html = paint({ dedupe: { status: "ok", comparedCount: 1, maxSimilarity: 0.1, threshold: 0.4 } });
    expect(html).toContain("Repetition check");
    expect(html).not.toContain("Topic guardrails");
  });

  it("renders both together", () => {
    const html = paint({
      guardrail: { forbiddenTopics: ["x"], injectedStepIds: ["a"] },
      dedupe: { status: "ok", comparedCount: 1, maxSimilarity: 0.1, threshold: 0.4 },
    });
    expect(html).toContain("Topic guardrails");
    expect(html).toContain("Repetition check");
  });
});
