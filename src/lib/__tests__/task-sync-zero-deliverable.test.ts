/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A REFUNDED RUN MUST NOT LEAVE A CARD TO APPROVE.
 *
 * On the same delivery that refunds a run for producing no client-facing
 * deliverables, the webhook calls `syncTaskForJobOutcome` with
 * `{ok: true, content: ""}`. The success branch wrote `review_pending` with
 * `artifact: outcome.content || task.title` — so the client was asked to review
 * a deliverable that does not exist, TITLED WITH THE WORDS THEY TYPED INTO THE
 * TASK, immediately after being refunded for it. Two surfaces disagreeing about
 * whether the run delivered.
 *
 * Both directions are asked here, because the dangerous half of this fix is the
 * second one: "nothing came back" must not swallow a run that came back with an
 * image, or with an asset, or with text.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/credit-reconcile", () => ({
  refundJobCharge: vi.fn().mockResolvedValue({ refunded: true, amount: 5 }),
}));

import * as data from "@/lib/data";
import { refundJobCharge } from "@/lib/credit-reconcile";
import { ranWithoutDeliverable } from "@/lib/task-outcome-copy";
import { syncTaskForJobOutcome } from "@/lib/task-sync";
import type { ClientTask } from "@/lib/types";

const TASK_TITLE = "Write the Q3 launch announcement";

/** A task mid-dispatch: the only state syncTaskForJobOutcome consumes. */
function dispatchedTask(metadata: Record<string, unknown> = {}) {
  return {
    id: "t1",
    clientId: "c1",
    title: TASK_TITLE,
    status: "in_progress",
    priority: "high",
    source: "copilot",
    metadata: { executing: true, externalJobId: "job-1", ...metadata },
    createdBy: "u-client",
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * The task AS THE BOARD WILL SEE IT after the (single) updateClientTask call —
 * status and metadata together, because the client-facing question
 * (`ranWithoutDeliverable`) is about the pair and not about either alone.
 */
function written() {
  const call = vi.mocked(data.updateClientTask).mock.calls[0];
  expect(call).toBeDefined();
  const patch = call![1] as any;
  return { status: patch.status as ClientTask["status"], metadata: patch.metadata as Record<string, unknown> };
}

const sync = (outcome: any) => syncTaskForJobOutcome("job-1", "c1", outcome);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(refundJobCharge).mockResolvedValue({ refunded: true, amount: 5 } as any);
  vi.mocked(data.findTaskByExternalJobId).mockResolvedValue(dispatchedTask() as any);
  vi.mocked(data.updateClientTask).mockResolvedValue(undefined as any);
});

describe("a run that finished with nothing to show", () => {
  const NOTHING = { ok: true, assetId: null, content: "", imageUrl: null };

  it("releases the task instead of asking for a review", async () => {
    await sync(NOTHING);
    const { status, metadata } = written();
    expect(status).toBe("pending");
    expect(metadata.executing).toBe(false);
    expect(metadata.externalJobId).toBeNull();
    // What the two client surfaces branch on — asked through the predicate they
    // use, so the wording can change in one place without this test pinning it.
    expect(ranWithoutDeliverable(written())).toBe(true);
  });

  /** The specific lie: the client's own task title dressed up as the output. */
  it("never writes the task's own title as the deliverable", async () => {
    await sync(NOTHING);
    expect(written().metadata.artifact).not.toBe(TASK_TITLE);
  });

  /**
   * A prior draft on the ticket is the revision base the next prompt builds
   * from (execution-engine's `previousArtifact`), and the old fallback write
   * destroyed it — an "Adjust" whose re-run produced nothing replaced the draft
   * the client was adjusting with the task title.
   */
  it("leaves a previous draft on the ticket untouched", async () => {
    vi.mocked(data.findTaskByExternalJobId).mockResolvedValue(
      dispatchedTask({ artifact: "The draft the client asked to adjust." }) as any,
    );
    await sync(NOTHING);
    expect(written().metadata.artifact).toBe("The draft the client asked to adjust.");
  });

  /** The card and the refund now say the same thing about the same run. */
  it("hands the credits back on the same pass that releases the card", async () => {
    await sync(NOTHING);
    expect(refundJobCharge).toHaveBeenCalledWith("t1", expect.stringMatching(/produced nothing/));
  });

  /**
   * Still `true`. Returning false would hand the webhook's `!taskSynced` branch a
   * run that produced nothing and let it auto-complete this client's pending
   * watcher tasks on the strength of it — a fix that closed one hole by opening
   * a worse one.
   */
  it("still reports the dispatch as consumed", async () => {
    await expect(sync(NOTHING)).resolves.toBe(true);
  });

  it("treats whitespace-only text as nothing", async () => {
    await sync({ ok: true, assetId: null, content: "   \n\t ", imageUrl: null });
    expect(written().status).toBe("pending");
    expect(ranWithoutDeliverable(written())).toBe(true);
  });

  it("does not care whether imageUrl was omitted or explicitly null", async () => {
    await sync({ ok: true, assetId: null, content: "" });
    expect(written().status).toBe("pending");
  });
});

describe("a run that DID deliver — the door this must not shut", () => {
  async function expectReviewPending(outcome: any) {
    await sync(outcome);
    const { status, metadata } = written();
    expect(status).toBe("review_pending");
    expect(metadata.executionError).toBeNull();
    expect(refundJobCharge).not.toHaveBeenCalled();
    return metadata;
  }

  it("puts text on the ticket for review", async () => {
    const metadata = await expectReviewPending({
      ok: true,
      assetId: "a1",
      content: "Here is the announcement.",
      imageUrl: null,
    });
    expect(metadata.artifact).toBe("Here is the announcement.");
  });

  /** An image with no caption text is still a deliverable. */
  it("reviews an image-only run", async () => {
    const metadata = await expectReviewPending({
      ok: true,
      assetId: null,
      content: "",
      imageUrl: "https://cdn.test/slide.png",
    });
    expect(metadata.artifactImageUrl).toBe("https://cdn.test/slide.png");
  });

  /**
   * A client-facing artifact that is neither text nor an image (a PDF) still
   * creates a library asset, so the client received something even though the
   * ticket has no preview text.
   */
  it("reviews an asset-only run", async () => {
    const metadata = await expectReviewPending({
      ok: true,
      assetId: "a1",
      content: "",
      imageUrl: null,
    });
    expect(metadata.artifactAssetIds).toEqual(["a1"]);
  });
});

describe("a run that failed — unchanged", () => {
  it("releases the task with the error and refunds it", async () => {
    await sync({ ok: false, error: "agent service: container OOM" });
    const { status, metadata } = written();
    expect(status).toBe("pending");
    expect(metadata.executionError).toBe("agent service: container OOM");
    // A real failure must not borrow the nothing-came-back wording.
    expect(ranWithoutDeliverable(written())).toBe(false);
    expect(refundJobCharge).toHaveBeenCalledWith("t1", expect.stringMatching(/run failed/));
  });
});

/**
 * WHY THE WORDING IS KEYED TO A STORED SENTENCE AND NOT TO A FLAG. A
 * `metadata.noDeliverable` boolean would have been written by task-sync and
 * cleared by nobody: the claim, an in-process success, an in-process failure and
 * the stuck-execution reconciler all maintain `executionError` and none of them
 * knows about a parallel key. A client whose nothing-run was retried and then
 * failed for an ordinary reason would still have read "nothing came back".
 */
describe("the flag cannot outlive the state it describes", () => {
  /** As task-sync leaves it, then moved by one of the eight other writers. */
  const released = { status: "pending", metadata: { noDeliverable: true, executing: false } };

  it("matches the state task-sync actually wrote", async () => {
    await sync({ ok: true, assetId: null, content: "" });
    expect(ranWithoutDeliverable(written())).toBe(true);
    expect(ranWithoutDeliverable(released as any)).toBe(true);
  });

  it("stops matching the moment anything else moves the task", () => {
    // A retry is in flight (claimTaskForExecution / the autopilot re-arm).
    expect(
      ranWithoutDeliverable({ ...released, metadata: { ...released.metadata, executing: true } } as any),
    ).toBe(false);
    // The retry landed a deliverable (execution-engine's success write).
    expect(ranWithoutDeliverable({ ...released, status: "review_pending" } as any)).toBe(false);
    // The retry failed for an ordinary reason, or the stuck-execution
    // reconciler released it — either way there is now a stored error, and the
    // generic "Execution failed." wording is the true one.
    expect(
      ranWithoutDeliverable({
        ...released,
        metadata: { ...released.metadata, executionError: "agent service: container OOM" },
      } as any),
    ).toBe(false);
    // An unrelated product run auto-completed the watcher task.
    expect(ranWithoutDeliverable({ ...released, status: "completed" } as any)).toBe(false);
  });

  it("is false for a task that never had a nothing-run", () => {
    expect(ranWithoutDeliverable({ status: "pending", metadata: {} } as any)).toBe(false);
    expect(ranWithoutDeliverable({ status: "pending" } as any)).toBe(false);
  });
});

describe("the live-dispatch guard is still the first question", () => {
  it("ignores a redelivery for a task that has already moved on", async () => {
    vi.mocked(data.findTaskByExternalJobId).mockResolvedValue({
      ...dispatchedTask(),
      status: "completed",
      metadata: { executing: false },
    } as any);
    await expect(sync({ ok: true, assetId: null, content: "" })).resolves.toBe(false);
    expect(data.updateClientTask).not.toHaveBeenCalled();
    expect(refundJobCharge).not.toHaveBeenCalled();
  });
});
