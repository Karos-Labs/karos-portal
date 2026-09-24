import { describe, expect, it } from "vitest";
import {
  indexAfterListChange,
  keyEventIsForQueue,
  queueKeyAction,
  queuePosition,
  stepIndex,
} from "@/lib/review-queue";

/**
 * Every rule here is about a reviewer's POSITION when the list moves under
 * them, which is the only part of a review queue that can silently lose work:
 * a teleport to the top re-reads decisions already made, and a teleport past an
 * item means a draft nobody ever saw gets approved by the next person who
 * assumes the queue was complete.
 */

describe("moving through the queue", () => {
  it("does not wrap at the end — a queue exists to be finished", () => {
    // Wrapping turns "am I done?" into a question you cannot answer without
    // counting, which is the whole value of a queue over a grid.
    expect(stepIndex(3, 2, 1)).toBe(2);
    expect(stepIndex(3, 0, -1)).toBe(0);
  });

  it("moves one at a time in both directions", () => {
    expect(stepIndex(5, 2, 1)).toBe(3);
    expect(stepIndex(5, 2, -1)).toBe(1);
  });

  it("survives an index that is already out of range", () => {
    // A filter above the queue can shrink the list between a render and a
    // keypress; this must not return -1 or 9 into an array read.
    expect(stepIndex(3, 99, 1)).toBe(2);
    expect(stepIndex(3, -4, -1)).toBe(0);
    expect(stepIndex(0, 4, 1)).toBe(0);
  });

  it("counts from one, because nobody reads '0 of 12'", () => {
    expect(queuePosition(12, 0)).toBe("1 of 12");
    expect(queuePosition(12, 11)).toBe("12 of 12");
    expect(queuePosition(0, 0)).toBe("0 of 0");
  });
});

describe("where the reviewer lands when the list changes under them", () => {
  it("follows the draft they are reading when something ABOVE it is decided", () => {
    // The case that looks like nothing happened and must therefore feel like
    // nothing happened: a colleague approves an earlier draft, every index
    // below it shifts by one, and this reviewer is still on the same post.
    const before = ["a", "b", "c", "d"];
    const after = ["a", "c", "d"]; // "b" was approved elsewhere
    expect(indexAfterListChange(before, after, 2)).toBe(1); // still on "c"
  });

  it("hands the place to whatever took it when their OWN draft is decided", () => {
    // Approving item 3 of 12 should land on the new item 3, not on item 4
    // (which skips a draft) and not at the top (which re-reads two).
    const before = ["a", "b", "c", "d"];
    const after = ["a", "b", "d"]; // they approved "c"
    expect(indexAfterListChange(before, after, 2)).toBe(2); // now "d"
  });

  it("walks backwards at the end of the list", () => {
    const before = ["a", "b", "c"];
    const after = ["a", "b"]; // they approved the last one
    expect(indexAfterListChange(before, after, 2)).toBe(1);
  });

  it("says FINISHED rather than index 0 when the queue empties", () => {
    // `0` would render "1 of 0" and read an undefined asset; the queue has to
    // be able to say it is done.
    expect(indexAfterListChange(["a"], [], 0)).toBeNull();
  });

  it("does not lose a reviewer whose index was stale", () => {
    expect(indexAfterListChange(["a", "b"], ["a", "b"], 7)).toBe(1);
  });
});

describe("what the keys mean", () => {
  it("moves on both the arrows and j/k", () => {
    // Two audiences: someone who lives in this queue reaches for j/k, someone
    // who arrived from the grid reaches for the arrows.
    for (const key of ["ArrowRight", "ArrowDown", "j"]) expect(queueKeyAction(key)).toBe("next");
    for (const key of ["ArrowLeft", "ArrowUp", "k"]) expect(queueKeyAction(key)).toBe("previous");
  });

  it("leaves modified keys to the browser", () => {
    // ⌘← is "back", ctrl+K is the browser's, alt+arrow is the reader's. A queue
    // that swallows them is a queue people close.
    expect(queueKeyAction("ArrowLeft", { meta: true })).toBeNull();
    expect(queueKeyAction("j", { ctrl: true })).toBeNull();
    expect(queueKeyAction("ArrowRight", { alt: true })).toBeNull();
  });

  it("binds escape to leaving and 'a' to approving", () => {
    expect(queueKeyAction("Escape")).toBe("close");
    expect(queueKeyAction("a")).toBe("approve");
  });

  it("claims nothing else", () => {
    for (const key of ["z", "Enter", "Tab", " ", "A", "J"]) expect(queueKeyAction(key)).toBeNull();
  });
});

describe("whose keypress it is", () => {
  it("leaves every key alone while the reviewer is typing", () => {
    // Approving a post mid-sentence because the draft contained the letter "a"
    // is worse than having no shortcut at all.
    expect(keyEventIsForQueue({ tagName: "TEXTAREA" })).toBe(false);
    expect(keyEventIsForQueue({ tagName: "input" })).toBe(false);
    expect(keyEventIsForQueue({ tagName: "SELECT" })).toBe(false);
    expect(keyEventIsForQueue({ tagName: "DIV", isContentEditable: true })).toBe(false);
  });

  it("takes the key when the reviewer is just reading", () => {
    expect(keyEventIsForQueue({ tagName: "DIV" })).toBe(true);
    expect(keyEventIsForQueue({ tagName: "BUTTON" })).toBe(true);
    expect(keyEventIsForQueue(null)).toBe(true);
  });
});
