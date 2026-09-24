import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./source-scan";

/**
 * THE LOOP HAS TO BE VISIBLE TO THE PERSON FEEDING IT.
 *
 * `text-diff.test.ts` owns the arithmetic. This owns the wiring, and the two
 * facts that make the feature honest rather than decorative:
 *
 *   1. it reads the stash the learning loop actually sends
 *      (`meta.engineOriginalContent`), not some other copy of the text — a
 *      comparison against the wrong "original" teaches the reviewer a wrong
 *      lesson about what the agent is learning;
 *   2. it renders NOTHING when nothing was edited. A permanent "no changes"
 *      panel on every card is furniture, and this card is already dense.
 *
 * A source scan rather than a render: the card is a `"use client"` component
 * whose behaviour is state and a server action, the same reason
 * `gate-review-lightbox.test.ts` gives for its own scan.
 */
const SRC = join(process.cwd(), "src");
const CARD = readSource(join(SRC, "components", "asset-card.tsx"));
const COMPARISON = readSource(join(SRC, "components", "version-comparison.tsx"));

describe("the comparison is wired to the pair the loop sends", () => {
  it("scanned the files it claims to have scanned", () => {
    expect(CARD.length).toBeGreaterThan(2000);
    expect(COMPARISON.length).toBeGreaterThan(800);
  });

  it("compares against the stash `markAssetPostedAction` sends, not another copy", () => {
    expect(CARD).toContain("asset.meta?.engineOriginalContent");
    expect(CARD).toContain("<VersionComparison");
    expect(CARD).toContain("current={asset.content}");
  });

  it("renders nothing at all on a draft nobody edited", () => {
    // Both halves: the card asks whether a stash exists, and the component
    // itself returns null when the two texts turn out identical anyway (an
    // edit that was undone, a whitespace-only change).
    expect(CARD).toContain('typeof asset.meta?.engineOriginalContent === "string" &&');
    expect(COMPARISON).toContain("if (summary.identical) return null;");
  });

  it("takes its arithmetic from the tested module rather than re-deciding it", () => {
    expect(COMPARISON).toContain('from "@/lib/text-diff"');
    expect(COMPARISON).toContain("diffWords");
    expect(COMPARISON).toContain("summarizeDiff");
  });

  it("opens on a press, so the text that ships stays the first thing read", () => {
    expect(COMPARISON).toContain("const [open, setOpen] = useState(false);");
  });
});
