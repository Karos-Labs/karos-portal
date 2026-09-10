/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as sharedActions from "@/lib/actions/_shared";

/**
 * addLiDraftFeedbackAction's materialization branch (parity with X's
 * pickAgentSlotOptionAction): a "posted"/"posted_with_edits" pick is the
 * client's posting confirmation for LinkedIn — there is no separate later
 * "mark as posted" step — so it must also create a real, calendar-visible
 * Asset, tagged personalSeatId for a seat's own account and left general for
 * the company account. Every other action (not_posted/note/edit_request)
 * must keep today's feedback-only behavior and create nothing.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/actions/_shared");
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn() }));

const CLIENT = {
  uid: "u-client",
  name: "Client User",
  role: "CLIENT_USER",
  clientId: "c1",
} as any;

/** Real linkedin-drafts.md shape — see docs/linkedin-agent-portal.md. */
const BATCH = [
  "# LinkedIn drafts",
  "",
  "## Account 1 · Karos Labs — Company page",
  "",
  "### Post 1 · Thought-leadership",
  "",
  "> The company post, ready to go.",
  "",
  "## Account 2 · Albert Kattan",
  "",
  "### Post 1 · Thought-leadership",
  "",
  "> Albert's own build-in-public post.",
  "",
].join("\n");

const SEAT = {
  id: "seat-albert",
  clientId: "c1",
  name: "Albert Kattan",
  slug: "albert-kattan",
  createdBy: "u1",
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  (sharedActions.requireClientAccess as any).mockResolvedValue(CLIENT);
  (data.getAsset as any).mockResolvedValue({ id: "batch-1", clientId: "c1", content: BATCH });
  (data.createAsset as any).mockResolvedValue("new-asset");
  (data.addLiDraftFeedback as any).mockResolvedValue("feedback-1");
  (data.listLiDraftFeedback as any).mockResolvedValue([]);
  (data.listClientSeats as any).mockResolvedValue([SEAT]);
  (data.getClientSeat as any).mockImplementation(async (id: string) =>
    id === SEAT.id ? SEAT : null,
  );
});

describe("addLiDraftFeedbackAction — materialization", () => {
  it("materializes a seat's pick as a published, personal asset", async () => {
    const { addLiDraftFeedbackAction } = await import("@/lib/actions/linkedin-agent-actions");

    const result = await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Albert Kattan",
      assetId: "batch-1",
      draftRef: "Albert Kattan · Post 1 · Thought-leadership",
      action: "posted",
    });

    expect(result.assetId).toBe("new-asset");
    expect(data.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "c1",
        status: "published",
        channels: ["linkedin"],
        personalSeatId: "seat-albert",
        content: "Albert's own build-in-public post.",
      }),
    );
  });

  it("leaves personalSeatId null for a company-page pick", async () => {
    const { addLiDraftFeedbackAction } = await import("@/lib/actions/linkedin-agent-actions");

    await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Karos Labs — Company page",
      assetId: "batch-1",
      draftRef: "Karos Labs — Company page · Post 1 · Thought-leadership",
      action: "posted",
    });

    expect(data.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ personalSeatId: null, content: "The company post, ready to go." }),
    );
  });

  it("uses the client's edited text, not the original draft, for posted_with_edits", async () => {
    const { addLiDraftFeedbackAction } = await import("@/lib/actions/linkedin-agent-actions");

    await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Albert Kattan",
      assetId: "batch-1",
      draftRef: "Albert Kattan · Post 1 · Thought-leadership",
      action: "posted_with_edits",
      finalText: "My edited version.",
    });

    expect(data.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ content: "My edited version.", personalSeatId: "seat-albert" }),
    );
  });

  it("creates nothing for not_posted, note, or edit_request", async () => {
    const { addLiDraftFeedbackAction } = await import("@/lib/actions/linkedin-agent-actions");

    await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Albert Kattan",
      assetId: "batch-1",
      draftRef: "Albert Kattan · Post 1 · Thought-leadership",
      action: "not_posted",
      reason: "Not feeling it today.",
    });
    await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Albert Kattan",
      action: "note",
      reason: "General feedback.",
    });
    await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Albert Kattan",
      assetId: "batch-1",
      draftRef: "Albert Kattan · Post 1 · Thought-leadership",
      action: "edit_request",
      reason: "Change the tone.",
    });

    expect(data.createAsset).not.toHaveBeenCalled();
    expect(data.addLiDraftFeedback).toHaveBeenCalledTimes(3);
  });

  it("still records feedback even when the draft can't be re-located (best-effort, never an error)", async () => {
    const { addLiDraftFeedbackAction } = await import("@/lib/actions/linkedin-agent-actions");

    const result = await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Albert Kattan",
      assetId: "batch-1",
      draftRef: "Albert Kattan · Post 9 · Nonexistent lane",
      action: "posted",
    });

    expect(result.error).toBeUndefined();
    expect(data.addLiDraftFeedback).toHaveBeenCalledTimes(1);
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("refuses a repeat 'posted' for a draft already marked posted — no second Asset, no second log row", async () => {
    (data.listLiDraftFeedback as any).mockResolvedValue([
      {
        id: "fb-existing",
        clientId: "c1",
        account: "seat-albert",
        draftRef: "Albert Kattan · Post 1 · Thought-leadership",
        action: "posted",
        createdBy: "u-client",
        createdAt: 0,
      },
    ]);
    const { addLiDraftFeedbackAction } = await import("@/lib/actions/linkedin-agent-actions");

    const result = await addLiDraftFeedbackAction({
      clientId: "c1",
      accountTitle: "Albert Kattan",
      assetId: "batch-1",
      draftRef: "Albert Kattan · Post 1 · Thought-leadership",
      action: "posted",
    });

    expect(result.error).toBeTruthy();
    expect(data.addLiDraftFeedback).not.toHaveBeenCalled();
    expect(data.createAsset).not.toHaveBeenCalled();
  });
});
