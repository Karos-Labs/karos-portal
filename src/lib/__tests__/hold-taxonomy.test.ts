import { describe, expect, it } from "vitest";
import { classifyHold } from "@/lib/hold-taxonomy";

/**
 * Every fixture here is a real `heldReason` from prep, copied verbatim.
 *
 * That matters more than usual. The failure taxonomy's own header records what
 * happens when these patterns are written from imagination: a rotated token
 * produced "Agent service request failed (401)", the generic `\b401\b` rule
 * matched it, and staff were sent to check the model provider's API key while
 * the broken thing was this portal's own token. A wrong reason costs more than
 * no reason.
 *
 * So the families below were read off the held jobs in prep, and the one thing
 * each test really pins is whether RE-RUNNING can produce a different outcome.
 * That is the difference between a button that helps and a button that spends
 * a client's money to be declined again.
 */

const REAL = {
  noFootage: "no source footage from any tier — user-asset: no media attached to this run",
  noCandidate: "no unused commentary-clip candidate to clip (topics.reserve: content_fail)",
  noImage: "no viable image found for slide(s) 1, 2, 3, 4, 5, 6 — holding the whole carousel",
  tooShort: "selected moment is not clippable: snapped clip is 2.0s, under the 20s floor",
  selfCheck: "step 07's self-check never passed after 3 attempt(s) (initial + 2 returns)",
  noSchema: "no drafting attempt produced copy that cleared its own schema (3 attempts)",
  numbers: "numbers not sourced: text makes 17 numeric claim(s) whose figure does not appear in the sources",
  tooLong: "thread part 3 exceeds the X character limit (283 chars)",
  credit: "the caption does not carry the source credit, and an on-clip attribution was not placed",
};

describe("what re-running can and cannot fix", () => {
  it.each([
    ["a missing attachment", REAL.noFootage],
    ["no candidate to clip", REAL.noCandidate],
    ["no usable image", REAL.noImage],
    ["a source with no long-enough moment", REAL.tooShort],
  ])("does not offer a re-run for %s", (_name, reason) => {
    // The family the Retry button would have been most wrong about: another run
    // finds the same empty shelf, and charges the client to find it.
    const hold = classifyHold(reason)!;
    expect(hold.rerunnable).toBe(false);
    expect(hold.action).toMatch(/attach|source pool|recording|widen/i);
  });

  it.each([
    ["a self-check that never passed", REAL.selfCheck],
    ["copy that never cleared its schema", REAL.noSchema],
    ["figures the gate could not trace", REAL.numbers],
    ["a thread part over the limit", REAL.tooLong],
  ])("offers a re-run for %s, because each attempt samples fresh", (_name, reason) => {
    expect(classifyHold(reason)!.rerunnable).toBe(true);
  });

  it("does not offer a re-run for a missing credit", () => {
    // A compliance rule declining, not a sampling accident. Another run
    // declines again, and the fix is an edit a person makes.
    const hold = classifyHold(REAL.credit)!;
    expect(hold.rerunnable).toBe(false);
    expect(hold.family).toBe("attribution_missing");
  });
});

describe("the families", () => {
  it.each([
    [REAL.noFootage, "no_source_material"],
    [REAL.selfCheck, "self_check_never_passed"],
    [REAL.numbers, "numbers_unsourced"],
    [REAL.tooLong, "platform_limit"],
    [REAL.credit, "attribution_missing"],
  ])("classifies %s", (reason, family) => {
    expect(classifyHold(reason)!.family).toBe(family);
  });

  it("keeps the raw reason on every classification", () => {
    // Nothing is lost when the guess is wrong — the same rule the failure
    // taxonomy follows, and the reason the raw line still renders.
    for (const reason of Object.values(REAL)) {
      expect(classifyHold(reason)!.raw).toBe(reason);
    }
  });
});

describe("a hold nobody has seen", () => {
  it("says nothing rather than guessing", () => {
    const hold = classifyHold("something entirely new happened in the workflow")!;
    expect(hold.family).toBe("unclassified");
    expect(hold.action).toBeUndefined();
    expect(hold.rerunnable).toBe(false);
    // The raw reason is still there. It is what was already on screen.
    expect(hold.raw).toContain("something entirely new");
  });

  it("returns nothing at all for an empty reason", () => {
    expect(classifyHold("")).toBeUndefined();
    expect(classifyHold(null)).toBeUndefined();
    expect(classifyHold(undefined)).toBeUndefined();
  });
});
