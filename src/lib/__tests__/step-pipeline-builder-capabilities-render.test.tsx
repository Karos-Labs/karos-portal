import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Feature: per-AI-step capability grants (network access / client data
 * access). What the toggles and the on-step warning actually paint — the same
 * `renderToStaticMarkup` recipe dynamic-agent-intake-render.test.tsx
 * establishes for this repo's "use client" form components, since a source
 * scan can't tell "the JSX exists" apart from "the JSX renders for this step".
 */

vi.mock("server-only", () => ({}));

import { StepPipelineBuilder } from "@/components/admin/agent-studio/step-pipeline-builder";
import type { DynamicAgentStepDef } from "@/lib/types";

function aiStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "ai" }>> = {}): DynamicAgentStepDef {
  return { id: "research", type: "ai", label: "Research", model: "sonnet", prompt: "Go", order: 0, ...patch };
}

function codeStep(patch: Partial<Extract<DynamicAgentStepDef, { type: "code" }>> = {}): DynamicAgentStepDef {
  return { id: "format", type: "code", language: "node", label: "Format", code: "console.log('{}')", order: 0, ...patch };
}

function paint(steps: DynamicAgentStepDef[]): string {
  return renderToStaticMarkup(
    <StepPipelineBuilder
      initial={steps}
      inputSchema={[]}
      codeStepsEnabled={false}
      pending={false}
      error={null}
      onSave={() => {}}
    />,
  );
}

describe("AI step capability toggles", () => {
  it("renders both toggles, unchecked by default", () => {
    const html = paint([aiStep()]);
    expect(html).toContain("Network access");
    expect(html).toContain("Client data access");
    // Two checkboxes for the grants (there may be others elsewhere in the
    // tree, so scope to the checkbox inputs specifically).
    const checkboxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    for (const box of checkboxes) expect(box).not.toContain("checked");
  });

  it("a code step renders neither toggle", () => {
    const html = paint([codeStep()]);
    expect(html).not.toContain("Network access");
    expect(html).not.toContain("Client data access");
  });

  it("checks the toggle that matches the step's own true flag, and no other", () => {
    const html = paint([aiStep({ allowNetwork: true, allowClientData: false })]);
    const checkboxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    const checked = checkboxes.filter((c) => c.includes("checked"));
    expect(checked).toHaveLength(1);
  });

  it("shows a visible on-step warning when both grants are on together, and not otherwise", () => {
    const warningPhrase = /off the platform/i;
    const both = paint([aiStep({ allowNetwork: true, allowClientData: true })]);
    expect(both).toMatch(warningPhrase);

    const neither = paint([aiStep()]);
    expect(neither).not.toMatch(warningPhrase);

    const onlyOne = paint([aiStep({ allowNetwork: true })]);
    expect(onlyOne).not.toMatch(warningPhrase);
  });

  it("the pipeline summary line marks a step that carries either grant, and not a step with neither", () => {
    const withGrant = paint([aiStep({ allowNetwork: true }), aiStep({ id: "write", order: 1 })]);
    expect(withGrant).toContain('title="Network access"');

    const withNeither = paint([aiStep(), aiStep({ id: "write", order: 1 })]);
    expect(withNeither).not.toContain('title="Network access"');
  });
});
