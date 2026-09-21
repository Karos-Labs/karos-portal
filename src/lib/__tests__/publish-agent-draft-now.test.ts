/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `publishAgentDraftNowAction` — the manual half of the LinkedIn/X publish
 * door (the other half is `approveAssetAction`'s call into the same shared
 * `publishAgentDraftTarget` helper when `ClientIntegration.agentAutoPublish`
 * is on). Before this action existed, NOTHING let a human fire the real
 * OAuth publisher for a "note" asset outside the automatic-on-approval path
 * — `PUBLISHABLE_PLATFORMS.note` is `[]`, so `publishAssetNowAction`'s own
 * eligibility could never pass for one (platforms-publishable.test.ts pins
 * that array; this file pins the door built to work around it correctly).
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/integration-status");
vi.mock("@/lib/auth");
vi.mock("@/lib/asset-posted", () => ({ afterAssetPosted: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/actions/linkedin-agent-actions", () => ({
  addLiDraftFeedbackAction: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/actions/x-agent-actions", () => ({
  addXDraftFeedbackAction: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/integrations/token-refresh", async () => {
  const real = await vi.importActual<typeof import("@/lib/integrations/token-refresh")>(
    "@/lib/integrations/token-refresh",
  );
  return {
    ...real,
    // Runs the callback with the integration as-is — no real token refresh in tests.
    runWithFreshCredentials: vi.fn(async (integration: unknown, fn: (i: unknown) => unknown) => fn(integration)),
  };
});
vi.mock("@/lib/integrations/publishers", async () => {
  const real = await vi.importActual<typeof import("@/lib/integrations/publishers")>(
    "@/lib/integrations/publishers",
  );
  return { ...real, publishAssetToPlatform: vi.fn() };
});

import * as actions from "@/lib/actions/asset-actions";
import * as data from "@/lib/data";
import * as integ from "@/lib/integration-status";
import * as shared from "@/lib/actions/_shared";
import * as auth from "@/lib/auth";
import * as publishers from "@/lib/integrations/publishers";
import { addLiDraftFeedbackAction } from "@/lib/actions/linkedin-agent-actions";
import { addXDraftFeedbackAction } from "@/lib/actions/x-agent-actions";
import { afterAssetPosted } from "@/lib/asset-posted";

const LI_COMPANY_SINGLE = `# LinkedIn drafts — Karos Labs

## Account 1 · Karos Labs — Company page

### Post 1 · Thought-leadership

> Most founders do not need a $250K CMO.

\`40 chars\`
`;

const LI_SEAT_SINGLE = `# LinkedIn drafts — Karos Labs

## Account 1 · Albert Kattan (seat)

### Post 1 · Thought-leadership

> My own take on this.

\`22 chars\`
`;

function makeAsset(patch: Record<string, any> = {}): any {
  return {
    id: "a1",
    clientId: "c1",
    type: "note",
    title: "LinkedIn drafts",
    content: LI_COMPANY_SINGLE,
    status: "approved",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const STAFF_USER = { id: "u-staff", role: "KAROS_EMPLOYEE", disabled: false, clientId: "c1", email: "staff@karoslabs.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(shared, "requireStaff").mockImplementation(async () => STAFF_USER as any);
  vi.spyOn(auth, "getCurrentUser").mockImplementation(async () => STAFF_USER as any);
  (integ.integrationIsUsable as any).mockReturnValue(true);
  (data.claimAssetForPublish as any).mockResolvedValue(true);
  (data.releaseAssetPublishClaim as any).mockResolvedValue(undefined);
  (data.markAssetPublished as any).mockResolvedValue(undefined);
  (data.updateAsset as any).mockResolvedValue(undefined);
  (data.markIntegrationExpired as any).mockResolvedValue(undefined);
  (publishers.publishAssetToPlatform as any).mockResolvedValue({ postId: "post-123" });
});

describe("publishAgentDraftNowAction: the manual Publish Now door for an eligible LinkedIn/X note", () => {
  it("publishes through the real OAuth publisher, marks the note published, and records the bookkeeping every publish door owes", async () => {
    const asset = makeAsset();
    (data.getAsset as any).mockResolvedValue(asset);
    (data.listClientIntegrations as any).mockResolvedValue([
      { id: "i1", platform: "linkedin", clientId: "c1", connectedAt: 1 },
    ]);

    const result = await actions.publishAgentDraftNowAction("a1");

    expect(result).toEqual({ ok: true });
    // The one post, not the whole DRAFTS.md batch, is what actually went out.
    expect(publishers.publishAssetToPlatform).toHaveBeenCalledWith(
      "linkedin",
      expect.objectContaining({ platform: "linkedin" }),
      expect.objectContaining({ content: "Most founders do not need a $250K CMO." }),
    );
    expect(data.markAssetPublished).toHaveBeenCalledWith("a1", "post-123");
    expect(afterAssetPosted).toHaveBeenCalledWith(asset, { actor: "staff@karoslabs.com" });
    // The LinkedIn-specific learning loop hears the same "posted" signal the
    // compose-shortcut's send("posted") already records — but WITHOUT
    // draftRef/assetId, so it never re-materializes a duplicate published
    // Asset for content that already just went out for real.
    expect(addLiDraftFeedbackAction).toHaveBeenCalledWith({
      clientId: "c1",
      accountTitle: "Karos Labs — Company page",
      action: "posted",
    });
    expect(addXDraftFeedbackAction).not.toHaveBeenCalled();
  });

  it("is staff-only", async () => {
    vi.spyOn(shared, "requireStaff").mockImplementation(async () => {
      throw new Error("Forbidden");
    });
    await expect(actions.publishAgentDraftNowAction("a1")).rejects.toThrow("Forbidden");
  });

  it("refuses an unapproved draft, same message publishAssetNowAction gives", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "draft" }));

    const result = await actions.publishAgentDraftNowAction("a1");

    expect(result).toEqual({
      ok: false,
      error: "Only an approved, scheduled, or delivered post can be published. Approve it first.",
    });
    expect(publishers.publishAssetToPlatform).not.toHaveBeenCalled();
  });

  it("refuses an already-published note", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "published" }));

    const result = await actions.publishAgentDraftNowAction("a1");

    expect(result).toEqual({ ok: false, error: "Already published" });
  });

  it("refuses content the narrow target sniff does not recognise (a personal seat's draft)", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ content: LI_SEAT_SINGLE }));

    const result = await actions.publishAgentDraftNowAction("a1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/compose shortcut/);
    expect(publishers.publishAssetToPlatform).not.toHaveBeenCalled();
  });

  it("refuses when the target platform has no connected integration", async () => {
    const asset = makeAsset();
    (data.getAsset as any).mockResolvedValue(asset);
    (data.listClientIntegrations as any).mockResolvedValue([]);

    const result = await actions.publishAgentDraftNowAction("a1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No active linkedin integration/);
  });

  it("surfaces a publish failure as publishError, same as the automatic door", async () => {
    const asset = makeAsset();
    (data.getAsset as any).mockResolvedValue(asset);
    (data.listClientIntegrations as any).mockResolvedValue([
      { id: "i1", platform: "linkedin", clientId: "c1", connectedAt: 1 },
    ]);
    (publishers.publishAssetToPlatform as any).mockRejectedValue(new Error("LinkedIn 401"));

    const result = await actions.publishAgentDraftNowAction("a1");

    expect(result).toEqual({ ok: false, error: "LinkedIn 401" });
    expect(data.releaseAssetPublishClaim).toHaveBeenCalledWith("a1");
    expect(data.updateAsset).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ publishError: "LinkedIn 401" }),
    );
    expect(data.markAssetPublished).not.toHaveBeenCalled();
  });

  it("refuses when the asset is already claimed by an in-flight publish (the auto-publish door raced it)", async () => {
    const asset = makeAsset();
    (data.getAsset as any).mockResolvedValue(asset);
    (data.listClientIntegrations as any).mockResolvedValue([
      { id: "i1", platform: "linkedin", clientId: "c1", connectedAt: 1 },
    ]);
    (data.claimAssetForPublish as any).mockResolvedValue(false);

    const result = await actions.publishAgentDraftNowAction("a1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already being published/);
    expect(publishers.publishAssetToPlatform).not.toHaveBeenCalled();
  });
});
