import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * WHAT THE CLIENT ACTUALLY READS ON A TICKET WHOSE RUN BROUGHT NOTHING BACK.
 *
 * `task-sync-zero-deliverable.test.ts` proves the write: the task is released
 * instead of parked in review, and the refund goes out on the same pass. This
 * file asks the other half — that the ticket the client opens agrees with that
 * write — because the defect was never really in Firestore. It was a card
 * offering "Approve & Schedule" over a deliverable that did not exist, headed
 * with the client's own task title.
 *
 * The third case is the one that keeps the fix honest in the other direction:
 * an ordinary failure must NOT borrow this wording, and the agent service's own
 * error text must not reach the page under any of them.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions", () => ({
  getTaskCommentsAction: vi.fn(),
  addTaskCommentAction: vi.fn(),
  generateTaskPlanAction: vi.fn(),
  approveTaskArtifactAction: vi.fn(),
  requestAdjustmentsAction: vi.fn(),
  publishIntegrationAction: vi.fn(),
}));

import { TaskTicketModal } from "@/components/task-ticket-modal";

const TASK_TITLE = "Write the Q3 launch announcement";
const SERVICE_ERROR = "agent service: container OOM (exit 137)";

/** Tags removed and entities decoded — what the client reads, not the markup. */
function strip(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function ticketMarkup(status: string, metadata: Record<string, unknown>): string {
  const task: any = {
    id: "t1",
    clientId: "c1",
    title: TASK_TITLE,
    status,
    priority: "high",
    source: "copilot",
    metadata: { executing: false, ...metadata },
    createdBy: "u-client",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return renderToStaticMarkup(
    <TaskTicketModal
      task={task}
      onClose={() => {}}
      onStatusChange={() => {}}
      onLocalUpdate={() => {}}
      onDelete={() => {}}
    />,
  );
}

/** The markup above as plain reading text. */
function ticketText(status: string, metadata: Record<string, unknown>): string {
  return strip(ticketMarkup(status, metadata));
}

/** The ticket as task-sync now leaves it after a run that delivered nothing. */
const nothingBack = () => ticketText("pending", { noDeliverable: true, executionError: null });

describe("a ticket whose run produced nothing", () => {
  it("says so, in the place the deliverable would have been", () => {
    expect(nothingBack()).toContain("This run finished without producing anything");
  });

  it("offers no approval over a deliverable that does not exist", () => {
    expect(nothingBack()).not.toContain("Approve");
  });

  /**
   * The old write was `artifact: outcome.content || task.title`, so the card
   * rendered the client's own words back at them as the agent's output. The
   * title still appears once — as the ticket's heading, which is correct — so
   * this asks that it is not ALSO presented as the deliverable.
   */
  it("does not present the task's own title as the output", () => {
    const occurrences = nothingBack().split(TASK_TITLE).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("a ticket that really does have a deliverable", () => {
  const delivered = () =>
    ticketText("review_pending", {
      artifact: "Announcing our Q3 launch: three things shipped this quarter.",
      executionError: null,
    });

  it("still shows the draft and the approval it belongs to", () => {
    expect(delivered()).toContain("Announcing our Q3 launch");
    expect(delivered()).toContain("Approve");
  });

  it("shows no nothing-came-back notice", () => {
    expect(delivered()).not.toContain("without producing anything");
  });
});

/**
 * THE CASE THE FIX ABOVE NEARLY BROKE. Dropping `|| task.title` from task-sync
 * made `artifact: ""` reachable for the first time — a run with an image or a
 * library asset and no caption text lands on the SUCCESS branch, because
 * `deliveredNothing` correctly says an image IS a deliverable. The ticket then
 * gated its whole artifact section on the text being truthy, and that section is
 * the only place `artifactImageUrl` is ever painted. So the client got an empty
 * card with a live Approve button under it, and approval still worked: they
 * could approve something they had never been shown.
 *
 * These assert the RENDER, not the write. The write was already covered and
 * already correct — `task-sync-zero-deliverable.test.ts` checks
 * `metadata.artifactImageUrl` and passed throughout, which is exactly why the
 * hole was invisible.
 */
describe("a deliverable with no text", () => {
  const IMAGE = "https://cdn.test/slide.png";
  const imageOnly = () =>
    ticketMarkup("review_pending", { artifact: "", artifactImageUrl: IMAGE });

  it("paints the image the run produced", () => {
    expect(imageOnly()).toContain(IMAGE);
  });

  it("still offers the approval, now over something the client can see", () => {
    expect(strip(imageOnly())).toContain("Approve");
  });

  it("does not claim the run produced nothing", () => {
    expect(strip(imageOnly())).not.toContain("without producing anything");
  });

  /** An empty text frame under the image reads as a second, failed deliverable. */
  it("shows no empty text frame beside it", () => {
    expect(imageOnly()).not.toContain("<pre");
  });

  /**
   * The asset-only run (a PDF, say): no text and no image, but a real library
   * file. Nothing can be previewed inline, so the ticket cannot show the
   * deliverable — but it must not offer approval over a blank card either. It
   * says where the file is instead, which is the honest version of both.
   */
  describe("an asset-only run", () => {
    const assetOnly = () =>
      ticketMarkup("review_pending", {
        artifact: "",
        artifactImageUrl: null,
        artifactAssetIds: ["a1"],
      });

    it("tells the client where the file is", () => {
      expect(strip(assetOnly())).toContain("This deliverable is a file with no preview");
    });

    it("links to the library it is in", () => {
      expect(assetOnly()).toContain('href="/clients/c1/assets"');
    });

    it("never offers approval over a card with nothing on it", () => {
      const text = strip(assetOnly());
      if (text.includes("Approve")) {
        expect(text).toContain("Generated Deliverable");
      }
    });
  });
});

describe("an ordinary failure", () => {
  const failed = () => ticketText("pending", { executionError: SERVICE_ERROR });
  /** The stale-flag shape: a nothing-run, retried, then broken for another reason. */
  const failedAfterNothing = () =>
    ticketText("pending", { noDeliverable: true, executionError: SERVICE_ERROR });

  it("does not borrow the nothing-came-back wording", () => {
    expect(failed()).not.toContain("without producing anything");
  });

  /**
   * The flag from an earlier nothing-run is still on this task — nothing clears
   * it but task-sync. The card must go by the state, not the flag.
   */
  it("does not borrow it from a stale flag either", () => {
    expect(failedAfterNothing()).not.toContain("without producing anything");
  });

  /**
   * `executionError` can be whatever the agent service put in its payload. No
   * surface renders it, which is why both branches write their own sentence.
   */
  it("never puts the service's own error text on the page", () => {
    expect(failed()).not.toContain("container OOM");
    expect(failed()).not.toContain("exit 137");
  });
});
