import { describe, expect, it } from "vitest";
import {
  MAX_FEEDBACK_CHARS,
  MAX_INJECTED_FEEDBACK,
  clampFeedbackText,
  renderFeedbackMarkdown,
  selectInjectedFeedback,
  validateFeedbackScope,
} from "@/lib/client-agent-feedback";
import type { ClientAgentFeedback } from "@/lib/types";

function row(overrides: Partial<ClientAgentFeedback> = {}): ClientAgentFeedback {
  return {
    id: overrides.id ?? "f1",
    clientId: "c1",
    clientAgentId: "c1__ig",
    scope: "agent",
    templateKey: null,
    text: "Keep it plain.",
    status: "active",
    createdBy: "u1",
    creatorRole: "client",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("clampFeedbackText", () => {
  it("caps at the documented length", () => {
    expect(clampFeedbackText("x".repeat(900))).toHaveLength(MAX_FEEDBACK_CHARS);
  });

  it("strips control characters that would reappear inside the agent's file", () => {
    expect(clampFeedbackText("no\u0000nulls\u0007here")).toBe("nonullshere");
  });

  it("normalizes line endings and collapses runaway blank lines", () => {
    expect(clampFeedbackText("a\r\n\n\n\n b ")).toBe("a\n\n b");
  });
});

describe("validateFeedbackScope", () => {
  const templates = [{ key: "numbers" }, { key: "playbook" }];

  it("clears agent scope without a template key", () => {
    expect(validateFeedbackScope({ scope: "agent", templateKey: "numbers", templates })).toEqual({
      ok: true,
      templateKey: null,
    });
  });

  it("requires a key for template scope, and requires it to exist", () => {
    expect(validateFeedbackScope({ scope: "template", templates }).ok).toBe(false);
    expect(
      validateFeedbackScope({ scope: "template", templateKey: "ghost", templates }).ok,
    ).toBe(false);
    expect(validateFeedbackScope({ scope: "template", templateKey: "numbers", templates })).toEqual({
      ok: true,
      templateKey: "numbers",
    });
  });
});

describe("selectInjectedFeedback", () => {
  it("injects active rows only — resolved ones are kept but stop shaping runs", () => {
    const rows = [row({ id: "a" }), row({ id: "b", status: "resolved" })];
    expect(selectInjectedFeedback(rows).map((r) => r.id)).toEqual(["a"]);
  });

  // The F77 ruling made structural: client text that accumulates without limit
  // and rides on EVERY future run inflates every prompt forever.
  it("caps the injected set at the newest N", () => {
    const rows = Array.from({ length: MAX_INJECTED_FEEDBACK + 20 }, (_, i) =>
      row({ id: `f${i}`, createdAt: i }),
    );
    const selected = selectInjectedFeedback(rows);
    expect(selected).toHaveLength(MAX_INJECTED_FEEDBACK);
    // Newest first, and the oldest 20 are the ones dropped.
    expect(selected[0].id).toBe(`f${MAX_INJECTED_FEEDBACK + 19}`);
    expect(selected.map((r) => r.id)).not.toContain("f0");
  });
});

describe("renderFeedbackMarkdown", () => {
  const templates = [
    { key: "numbers", name: "By The Numbers" },
    { key: "playbook", name: "Playbook" },
  ];

  it("returns null when there is nothing active — callers attach no file", () => {
    expect(
      renderFeedbackMarkdown({
        agentName: "Instagram Agent",
        rows: [row({ status: "resolved" })],
        templates,
      }),
    ).toBeNull();
  });

  it("puts the global section first and one section per template that has notes", () => {
    const markdown = renderFeedbackMarkdown({
      agentName: "Instagram Agent",
      rows: [
        row({ id: "g", text: "No emoji.", createdAt: 3 }),
        row({
          id: "t",
          scope: "template",
          templateKey: "numbers",
          text: "Lead with the figure.",
          createdAt: 2,
        }),
      ],
      templates,
    });
    expect(markdown).not.toBeNull();
    const text = markdown as string;
    expect(text.indexOf("Applies to everything")).toBeLessThan(
      text.indexOf("Applies only to"),
    );
    expect(text).toContain("By The Numbers");
    expect(text).toContain("template key: numbers");
    expect(text).toContain("No emoji.");
    expect(text).toContain("Lead with the figure.");
    // A template with no notes gets no empty heading.
    expect(text).not.toContain("Playbook");
  });

  it("still renders template sections when there is no global feedback", () => {
    const text = renderFeedbackMarkdown({
      agentName: "Instagram Agent",
      rows: [
        row({ id: "t", scope: "template", templateKey: "playbook", text: "Shorter intros." }),
      ],
      templates,
    }) as string;
    expect(text).toContain("- Nothing yet.");
    expect(text).toContain("Shorter intros.");
  });

  it("names who wrote each note so the agent can weigh client vs staff direction", () => {
    const text = renderFeedbackMarkdown({
      agentName: "X Agent",
      rows: [row({ creatorRole: "staff", text: "Avoid the pricing claim." })],
      templates: [],
    }) as string;
    expect(text).toContain("(Karos team)");
  });
});

/**
 * D5 — the length cap is a cap on the PROMPT, not on the textarea.
 *
 * clampFeedbackText runs in the two write actions, so anything typed through
 * the modal is bounded on the way in. What is READ is not: rows predating the
 * cap, rows written by any future path that forgets to clamp, and rows edited
 * directly in Firestore all reach the serializer unbounded — and its output
 * goes verbatim into the prompt of every run the agent makes from then on.
 */
describe("renderFeedbackMarkdown — re-clamps at the injection boundary (D5)", () => {
  it("truncates an over-long stored row instead of injecting it whole", () => {
    const oversized = "x".repeat(MAX_FEEDBACK_CHARS * 3);
    const markdown = renderFeedbackMarkdown({
      agentName: "Instagram agent",
      rows: [row({ text: oversized })],
      templates: [],
    }) as string;

    expect(markdown).toContain("x".repeat(MAX_FEEDBACK_CHARS));
    expect(markdown).not.toContain("x".repeat(MAX_FEEDBACK_CHARS + 1));
  });
});

describe("selectInjectedFeedback — only active rows reach a run (D7)", () => {
  it("drops withdrawn rows the same way it drops resolved ones", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", status: "resolved" }),
      row({ id: "c", status: "withdrawn" }),
    ];

    expect(selectInjectedFeedback(rows).map((r) => r.id)).toEqual(["a"]);
  });
});
