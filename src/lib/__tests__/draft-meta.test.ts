import { describe, expect, it } from "vitest";
import { splitMetaLinks } from "@/lib/draft-meta";

describe("splitMetaLinks", () => {
  it("splits a bullet into words and links, keeping the words intact", () => {
    expect(splitMetaLinks("Source: https://karoslabs.com/playbook — the cost breakdown")).toEqual([
      { text: "Source: " },
      { text: "https://karoslabs.com/playbook", href: "https://karoslabs.com/playbook" },
      { text: " — the cost breakdown" },
    ]);
  });

  it("leaves sentence punctuation out of the link", () => {
    expect(splitMetaLinks("Grounded in https://karoslabs.com/playbook.")).toEqual([
      { text: "Grounded in " },
      { text: "https://karoslabs.com/playbook", href: "https://karoslabs.com/playbook" },
      { text: "." },
    ]);
  });

  it("returns a bullet without URLs as one plain run", () => {
    expect(splitMetaLinks("Source: market-strategy.md section 3")).toEqual([
      { text: "Source: market-strategy.md section 3" },
    ]);
  });
});
