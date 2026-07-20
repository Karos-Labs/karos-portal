import { describe, expect, it } from "vitest";
import { captionText } from "@/components/copy-caption-button";

/**
 * The card and the detail modal both copy via this helper. They used to be one
 * implementation and one gap (the modal had no copy control at all), so the
 * thing worth pinning down is that whatever a user copies is the same text and
 * includes the hashtags — a phone paste that silently drops them is the whole
 * point of the feature failing.
 */
describe("captionText", () => {
  it("appends hashtags below the caption", () => {
    expect(captionText({ content: "The moment that named us.", meta: { hashtags: ["kairos", "brand"] } })).toBe(
      "The moment that named us.\n\n#kairos #brand",
    );
  });

  it("returns the bare caption when there are no hashtags", () => {
    expect(captionText({ content: "Just the copy." })).toBe("Just the copy.");
    expect(captionText({ content: "Just the copy.", meta: { hashtags: [] } })).toBe("Just the copy.");
  });

  it("survives meta shapes that aren't a hashtag list", () => {
    expect(captionText({ content: "Body", meta: { hashtags: "not-an-array" } as never })).toBe("Body");
    expect(captionText({ content: "Body", meta: {} })).toBe("Body");
  });
});
