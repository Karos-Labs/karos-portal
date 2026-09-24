import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./source-scan";

/**
 * THE QUEUE IS A VIEW OF THE GRID, NOT A SECOND PLACE TO APPROVE.
 *
 * `review-queue.test.ts` owns the arithmetic — where a reviewer lands when the
 * list moves under them, and what each key means. This owns the wiring, which
 * is the half that cannot be unit-tested and is exactly where a second approve
 * path would appear: a queue that grew its own Approve button would be a second
 * home for the publish tier, the schedule, the platform list and the server
 * action, and the two would drift within a release.
 *
 * A source scan rather than a render: both files are `"use client"` components
 * whose behaviour lives in `useEffect` and a server action, the same reason
 * `gate-review-lightbox.test.ts` states for its own scan. What is pinned is the
 * MECHANISM — one card, one action, the filters shared, the shortcut reaching
 * for a real control. Copy, classes and icon names are free to move.
 */
const SRC = join(process.cwd(), "src");
const QUEUE = readSource(join(SRC, "components", "review-queue.tsx"));
const VIEW = readSource(join(SRC, "components", "assets-view.tsx"));
const CARD = readSource(join(SRC, "components", "asset-card.tsx"));

describe("the review queue reuses the grid's card and its one approve path", () => {
  it("scanned the three files it claims to have scanned", () => {
    // The premise. A typo'd path reads "" and passes every `not.toContain`.
    expect(QUEUE.length).toBeGreaterThan(1500);
    expect(VIEW.length).toBeGreaterThan(2000);
    expect(CARD.length).toBeGreaterThan(2000);
  });

  it("renders AssetCard rather than its own copy of one", () => {
    expect(QUEUE).toContain('from "@/components/asset-card"');
    expect(QUEUE).toContain("<AssetCard");
  });

  it("never calls an approve or schedule action itself", () => {
    // The whole reason it reuses the card. If this ever fails, the queue has
    // grown a second write path over the same documents.
    expect(QUEUE).not.toContain("approveAssetAction");
    expect(QUEUE).not.toContain("recommendAssetScheduleAction");
    // The panel is named in this file's own prose, so the assertion is about
    // USE: no import of it, and no element.
    expect(QUEUE).not.toContain(`from "@/components/approve-panel"`);
    expect(QUEUE).not.toContain("<ApprovePanel");
  });

  it("presses the card's real Approve control for the keyboard shortcut", () => {
    // A CROSS-FILE CONTRACT, which is the kind that rots silently: the shortcut
    // clicks a marked button inside the card, so the marker has to exist over
    // there. Asserted in both files, because a comment in one is not a contract.
    expect(QUEUE).toContain("data-approve-trigger");
    expect(CARD).toContain('data-approve-trigger="true"');
  });

  it("takes its rules from the tested module rather than re-deciding them inline", () => {
    expect(QUEUE).toContain('from "@/lib/review-queue"');
    expect(QUEUE).toContain("queueKeyAction");
    expect(QUEUE).toContain("keyEventIsForQueue");
    expect(QUEUE).toContain("indexAfterListChange");
    // No hand-rolled key chain beside the one the tests describe.
    expect(QUEUE).not.toContain('event.key === "ArrowRight"');
  });

  it("removes its keydown listener when it closes", () => {
    // A queue that leaves a document-level handler behind approves drafts from
    // a page nobody is looking at.
    expect(QUEUE).toContain("removeEventListener");
  });
});

describe("what the assets page hands the queue", () => {
  it("gives it drafts only", () => {
    // A queue that walked past published posts would ask a reviewer to decide
    // on things already decided.
    expect(VIEW).toContain('reviewable: matching.filter((asset) => asset.status === "draft")');
  });

  it("builds the queue from the SAME filtered list the grid shows", () => {
    // `matching` is the status/channel/type-filtered array. Reading `assets`
    // instead would put drafts in the queue that the page is hiding.
    expect(VIEW).not.toContain('reviewable: assets.filter');
  });

  it("offers the entry only to someone who can approve, and only with a backlog", () => {
    // A button that opens an empty queue teaches people not to press it; below
    // two drafts the grid is already the better shape.
    expect(VIEW).toContain("canApprove && reviewable.length > 1 && !queueOpen");
  });

  it("hides the grid while the queue is open", () => {
    // Two copies of the same card, one of them re-sorting under the reviewer,
    // is the shape the queue exists to replace.
    expect(VIEW).toContain("{!queueOpen && todayAssets.length > 0 && (");
    expect(VIEW).toContain("{queueOpen ? null :");
  });
});
