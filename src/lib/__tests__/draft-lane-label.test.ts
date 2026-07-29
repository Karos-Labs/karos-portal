import { describe, expect, it } from "vitest";
import { laneLabel } from "@/lib/draft-lane-label";

describe("laneLabel", () => {
  it("strips the lab's slot prefix and maps known lanes", () => {
    expect(laneLabel("Avenue 1 · Build-in-public")).toBe("Building in public");
    expect(laneLabel("Post 2 · POV thread")).toBe("Your point of view (thread)");
    expect(laneLabel("Post 1 · knowledge/explainer")).toBe("Explainer");
  });

  it("keeps a freshness flag as a readable suffix", () => {
    expect(laneLabel("Avenue 3 · News-reaction (live)")).toBe("Reacting to the news · live");
  });

  it("sentence-cases anything unmapped and survives junk", () => {
    expect(laneLabel("Avenue 9 · SOME_NEW-lane")).toBe("Some new lane");
    expect(laneLabel("")).toBe("Draft");
    expect(laneLabel("Draft 4 ·   ")).toBe("Draft");
  });
});
