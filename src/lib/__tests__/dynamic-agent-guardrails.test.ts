import { describe, expect, it } from "vitest";
import {
  MAX_FORBIDDEN_TOPICS,
  MAX_FORBIDDEN_TOPIC_CHARS,
  formatForbiddenTopics,
  hasForbiddenTopics,
  parseForbiddenTopics,
  validateForbiddenTopics,
} from "@/lib/dynamic-agent-guardrails";

/**
 * The forbidden-topics parsing rules (docs/dynamic-agent-guardrails.md §1.1).
 *
 * Pure, so this is where the editing behaviour is actually pinned: the box is
 * free text typed by staff, and every rule below exists because the naive
 * version of it produces a worse outcome for them — a duplicate rule injected
 * twice, a save refused over a stray blank line, or a cleared box that
 * silently keeps the old list.
 */

describe("parseForbiddenTopics", () => {
  it("splits on newlines and trims each entry", () => {
    expect(parseForbiddenTopics("  competitor pricing \n pending litigation  ")).toEqual([
      "competitor pricing",
      "pending litigation",
    ]);
  });

  it("drops blank lines rather than storing empty rules", () => {
    expect(parseForbiddenTopics("alpha\n\n\n   \nbeta")).toEqual(["alpha", "beta"]);
  });

  it("handles Windows line endings", () => {
    expect(parseForbiddenTopics("alpha\r\nbeta")).toEqual(["alpha", "beta"]);
  });

  it("de-duplicates case-insensitively, keeping the spelling that was typed first", () => {
    // Storing both would inject the same constraint twice for no benefit.
    expect(parseForbiddenTopics("Competitor Pricing\ncompetitor pricing\nCOMPETITOR PRICING")).toEqual([
      "Competitor Pricing",
    ]);
  });

  it("truncates an over-long entry instead of refusing the whole save", () => {
    const long = "x".repeat(MAX_FORBIDDEN_TOPIC_CHARS + 50);
    const parsed = parseForbiddenTopics(long);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(MAX_FORBIDDEN_TOPIC_CHARS);
  });

  it("stops at the maximum number of topics", () => {
    const many = Array.from({ length: MAX_FORBIDDEN_TOPICS + 10 }, (_, i) => `topic ${i}`).join("\n");
    expect(parseForbiddenTopics(many)).toHaveLength(MAX_FORBIDDEN_TOPICS);
  });

  it("returns an empty array for an empty box — which is how the feature is turned off", () => {
    expect(parseForbiddenTopics("")).toEqual([]);
    expect(parseForbiddenTopics("   \n  \n ")).toEqual([]);
  });

  it("is idempotent: parsing its own formatted output changes nothing", () => {
    const once = parseForbiddenTopics("Alpha\nbeta\n\ngamma");
    expect(parseForbiddenTopics(formatForbiddenTopics(once))).toEqual(once);
  });
});

describe("formatForbiddenTopics", () => {
  it("renders one topic per line", () => {
    expect(formatForbiddenTopics(["a", "b"])).toBe("a\nb");
  });

  it("renders an empty string for an absent list, so the editor shows an empty box", () => {
    expect(formatForbiddenTopics(undefined)).toBe("");
    expect(formatForbiddenTopics([])).toBe("");
  });
});

describe("validateForbiddenTopics", () => {
  it("accepts a normal list", () => {
    expect(validateForbiddenTopics(["competitor pricing"])).toBeNull();
  });

  it("accepts an empty list — no guardrails is a valid configuration", () => {
    expect(validateForbiddenTopics([])).toBeNull();
  });

  it("rejects more topics than the cap", () => {
    const many = Array.from({ length: MAX_FORBIDDEN_TOPICS + 1 }, (_, i) => `t${i}`);
    expect(validateForbiddenTopics(many)).toMatch(/at most/i);
  });

  it("rejects a blank topic", () => {
    expect(validateForbiddenTopics(["ok", "   "])).toMatch(/blank/i);
  });

  it("rejects an over-long topic", () => {
    expect(validateForbiddenTopics(["x".repeat(MAX_FORBIDDEN_TOPIC_CHARS + 1)])).toMatch(/too long/i);
  });

  it("passes anything parseForbiddenTopics produces — the parser cannot make an invalid list", () => {
    const nasty = ["", "   ", "x".repeat(500), ...Array.from({ length: 100 }, (_, i) => `t${i}`)].join("\n");
    expect(validateForbiddenTopics(parseForbiddenTopics(nasty))).toBeNull();
  });
});

describe("hasForbiddenTopics", () => {
  it("treats absent and empty identically — both mean the feature is off", () => {
    expect(hasForbiddenTopics(undefined)).toBe(false);
    expect(hasForbiddenTopics([])).toBe(false);
  });

  it("is true only for a non-empty list", () => {
    expect(hasForbiddenTopics(["x"])).toBe(true);
  });
});
