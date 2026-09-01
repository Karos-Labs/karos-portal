import { describe, expect, it, vi } from "vitest";

// Hoisted before anything that transitively pulls in server-only
// (context-doc-routing.ts -> provider.ts).
vi.mock("server-only", () => ({}));

import {
  HIGH_COMPLEXITY_MODEL,
  HIGH_COMPLEXITY_THRESHOLD,
  LARGE_CONTEXT_MODEL,
  assessContextDocComplexity,
  complexitySignalsForDocument,
  routeContextDocCondensation,
} from "../context-doc-routing";

/** A document with `n` extra `## ` sections beyond a short baseline body. */
function docWithSections(n: number): string {
  const baseline = "# Title\n\n## Overview\n\nShort.\n\n## Notes\n\nShort.\n\n";
  const extra = Array.from({ length: n }, (_, i) => `## Extra ${i}\n\nSome text.\n\n`).join("");
  return baseline + extra;
}

describe("assessContextDocComplexity", () => {
  it("scores a short, few-section document as standard", () => {
    const result = assessContextDocComplexity({ sectionCount: 2, contentChars: 500 });
    expect(result.tier).toBe("standard");
    expect(result.score).toBeLessThan(HIGH_COMPLEXITY_THRESHOLD);
  });

  it("scores a document with many sections as high, from section count alone", () => {
    const result = assessContextDocComplexity({ sectionCount: 8, contentChars: 500 });
    expect(result.tier).toBe("high");
    expect(result.reasons.some((r) => r.includes("sections"))).toBe(true);
  });

  it("scores a document with a large character volume as high, from content alone", () => {
    const result = assessContextDocComplexity({ sectionCount: 2, contentChars: 40_000 });
    expect(result.tier).toBe("high");
    expect(result.reasons.some((r) => r.includes("estimated prompt tokens"))).toBe(true);
  });

  it("clamps negative/non-finite signals to zero rather than throwing or going negative", () => {
    const result = assessContextDocComplexity({ sectionCount: Number.NaN, contentChars: -500 });
    expect(result.tier).toBe("standard");
    expect(result.score).toBe(0);
    expect(result.estimatedPromptTokens).toBe(0);
  });

  it("is deterministic — identical signals always score identically", () => {
    const a = assessContextDocComplexity({ sectionCount: 6, contentChars: 12_000 });
    const b = assessContextDocComplexity({ sectionCount: 6, contentChars: 12_000 });
    expect(a).toEqual(b);
  });
});

describe("complexitySignalsForDocument", () => {
  it("counts '## ' headings and characters directly off the document text", () => {
    const doc = docWithSections(3); // 2 baseline + 3 extra = 5 headings
    const signals = complexitySignalsForDocument(doc);
    expect(signals.sectionCount).toBe(5);
    expect(signals.contentChars).toBe(doc.length);
  });

  it("returns zero sections for a document with no '## ' headings", () => {
    expect(complexitySignalsForDocument("just prose, no headings").sectionCount).toBe(0);
  });
});

/**
 * THE acceptance-criterion proof: two documents of different complexity
 * select DIFFERENT models. This is also the adversarial-proof target — see
 * this ticket's report for the revert/restore result.
 */
describe("routeContextDocCondensation — complexity-driven Opus/Gemini selection", () => {
  it("routes a short, simple document to the Sonnet baseline, Vertex-primary/Anthropic-fallback", () => {
    const route = routeContextDocCondensation("brand-voice", docWithSections(0));
    expect(route.complexity.tier).toBe("standard");
    expect(route.escalated).toBe(false);
    expect(route.attempts.map((a) => a.vendor)).toEqual(["vertex", "anthropic"]);
    // Both candidates target the same (Sonnet-tier) model id — only the vendor differs.
    expect(route.attempts[0]!.modelId).toBe(route.attempts[1]!.modelId);
    expect(route.attempts[0]!.modelId).not.toBe(HIGH_COMPLEXITY_MODEL);
  });

  it("routes a long, many-section document to Opus — a DIFFERENT model than the standard-complexity route above", () => {
    const simple = routeContextDocCondensation("brand-voice", docWithSections(0));
    const complex = routeContextDocCondensation("competitor-analysis", docWithSections(10));

    expect(simple.complexity.tier).toBe("standard");
    expect(complex.complexity.tier).toBe("high");

    // The actual proof: different complexity -> different selected model.
    expect(complex.attempts[0]!.modelId).not.toBe(simple.attempts[0]!.modelId);
    expect(complex.attempts[0]!.modelId).toBe(HIGH_COMPLEXITY_MODEL);
    expect(complex.attempts[0]!.vendor).toBe("anthropic");
    expect(complex.escalated).toBe(true);
    // The escalation is a single, same-vendor candidate — no Vertex hop for
    // this model (see context-doc-routing.ts's HIGH_COMPLEXITY_MODEL comment).
    expect(complex.attempts).toHaveLength(1);
  });

  it("routes a document too large to fit Claude's window to Gemini, regardless of section count", () => {
    // ~600,000 chars ~= 171,000 estimated tokens, comfortably over the
    // 160,000-usable-token line (200,000 * 0.8) even before the reserved
    // output is added.
    const huge = docWithSections(0) + "x".repeat(600_000);
    const route = routeContextDocCondensation("market-strategy", huge, { maxOutputTokens: 8_000 });
    expect(route.escalated).toBe(true);
    expect(route.attempts).toHaveLength(1);
    expect(route.attempts[0]!.vendor).toBe("google");
    expect(route.attempts[0]!.modelId).toBe(LARGE_CONTEXT_MODEL);
  });

  it("checks fit BEFORE complexity — an oversized-but-otherwise-simple document still goes to Gemini, not Opus", () => {
    // Only 1 section (well under the high-complexity section threshold) but
    // enormous in characters — the overflow branch must win regardless.
    const huge = "# Title\n\n## Only section\n\n" + "x".repeat(600_000);
    const route = routeContextDocCondensation("product-information", huge);
    expect(route.attempts[0]!.vendor).toBe("google");
    expect(route.attempts[0]!.modelId).toBe(LARGE_CONTEXT_MODEL);
  });

  it("names the rationale in a way that is safe to log verbatim and cites the actual numbers", () => {
    const route = routeContextDocCondensation("brand-voice", docWithSections(10));
    expect(route.rationale).toContain("brand-voice");
    expect(route.rationale).toContain(String(route.complexity.score));
    expect(route.rationale).toContain(HIGH_COMPLEXITY_MODEL);
  });
});
