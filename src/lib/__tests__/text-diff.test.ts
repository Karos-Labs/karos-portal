import { describe, expect, it } from "vitest";
import { DIFF_WORD_CEILING, diffWords, summarizeDiff } from "@/lib/text-diff";

/**
 * The edit pair is the strongest voice signal this system gets: the agent's
 * own text beside the words a person put in its place. The portal has been
 * storing it since `engineOriginalContent` shipped and sending it to the next
 * draft, and nobody has ever been able to SEE it.
 *
 * Two properties carry the rendering and both are easy to get subtly wrong:
 * joining the segments must reproduce the text exactly (or the comparison is
 * not of the post that will go out), and an unchanged run must be ONE segment
 * (or a paragraph renders as a span per word).
 */

describe("what changed between two drafts", () => {
  it("marks only the words that moved", () => {
    const segments = diffWords("We measured every queue in the study", "We measured every intake queue in the study");
    expect(segments.filter((s) => s.kind === "added").map((s) => s.text.trim())).toEqual(["intake"]);
    expect(segments.filter((s) => s.kind === "removed")).toEqual([]);
  });

  it("reproduces the new text exactly when the segments are joined", () => {
    // The comparison has to be OF the post: a diff that loses a line break or
    // doubles a space is showing the reviewer something that will not ship.
    const after = "Line one.\n\nLine two, with  odd spacing.";
    const joined = diffWords("Line one.\n\nSomething else.", after)
      .filter((s) => s.kind !== "removed")
      .map((s) => s.text)
      .join("");
    expect(joined).toBe(after);
  });

  it("merges a run into one segment, so a paragraph is not a span per word", () => {
    const segments = diffWords("one two three four five", "one two three four five six");
    expect(segments.filter((s) => s.kind === "same")).toHaveLength(1);
    expect(segments.filter((s) => s.kind === "added").map((s) => s.text.trim())).toEqual(["six"]);
  });

  it("reads a replacement as a removal and an addition in place", () => {
    const segments = diffWords("the queue was slow", "the queue was glacial");
    expect(segments.map((s) => s.kind)).toEqual(["same", "removed", "added"]);
  });

  it("handles an empty side without inventing a comparison", () => {
    expect(diffWords("", "").length).toBe(0);
    expect(diffWords("", "new copy")).toEqual([{ kind: "added", text: "new copy" }]);
    expect(diffWords("old copy", "")).toEqual([{ kind: "removed", text: "old copy" }]);
  });

  it("answers a wholesale rewrite honestly rather than hanging on it", () => {
    // A review surface must never be the thing that freezes a reviewer's
    // browser. Past the ceiling the answer is "all of it changed", which is
    // what a rewrite IS.
    const before = Array.from({ length: DIFF_WORD_CEILING + 50 }, (_, i) => `before${i}`).join(" ");
    const after = Array.from({ length: DIFF_WORD_CEILING + 50 }, (_, i) => `after${i}`).join(" ");
    const started = Date.now();
    const segments = diffWords(before, after);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(segments.map((s) => s.kind)).toEqual(["removed", "added"]);
  });
});

describe("the one line above the comparison", () => {
  it("counts words, not segments", () => {
    const summary = summarizeDiff(diffWords("the queue was slow today", "the intake queue was glacial"));
    expect(summary.added).toBeGreaterThan(0);
    expect(summary.removed).toBeGreaterThan(0);
    expect(summary.identical).toBe(false);
  });

  it("says nothing changed when nothing did", () => {
    expect(summarizeDiff(diffWords("same words", "same words")).identical).toBe(true);
  });

  it("does not count whitespace-only changes as edits", () => {
    // A reviewer who fixed a double space did not rewrite the post, and a
    // comparison that says "2 words changed" for it teaches the loop nothing.
    expect(summarizeDiff(diffWords("one  two", "one two")).identical).toBe(true);
  });
});
