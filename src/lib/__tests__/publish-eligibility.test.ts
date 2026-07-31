/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "@/lib/actions/asset-actions";
import * as data from "@/lib/data";
import * as shared from "@/lib/actions/_shared";
import * as auth from "@/lib/auth";
import * as publishers from "@/lib/integrations/publishers";
import { assetPublishBlock, isAssetPublishable } from "@/lib/asset-visibility";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");
vi.mock("@/lib/integrations/publishers", () => ({
  TokenExpiredError: class TokenExpiredError extends Error {},
  inferPlatform: vi.fn(() => "twitter"),
  publishAssetToPlatform: vi.fn(async () => ({ postId: "p1" })),
}));

const SRC = join(process.cwd(), "src");

function makeAsset(patch: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "Post",
    content: "hi",
    status: "approved",
    publishMode: "manual",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Asset;
}

/**
 * "Publish Now" is the one control in the portal that really posts to a client's
 * live social account. It shipped with three hand-written gates — card, detail
 * modal, server action — that gave three different answers, and the widest of the
 * three was the server, which refused only an already-published asset. So an
 * unapproved draft and a "calendar-only roadmap item, Karos never posts it"
 * placeholder both went out for real.
 *
 * The rule now lives once, in asset-visibility.ts beside the other
 * which-assets-may-do-what predicates (client-safe, so the two client components
 * can import it). These tests assert the RULE by calling it, and the refusal by
 * calling the action — the server is the only gate that counts.
 */
describe("isAssetPublishable — the shared rule", () => {
  it("refuses a draft: nothing has been approved to post yet", () => {
    expect(isAssetPublishable(makeAsset({ status: "draft" }))).toBe(false);
    expect(assetPublishBlock(makeAsset({ status: "draft" }))).toBe("unapproved");
  });

  it("allows approved, scheduled and delivered", () => {
    for (const status of ["approved", "scheduled", "delivered"] as const) {
      expect(isAssetPublishable(makeAsset({ status })), status).toBe(true);
      expect(assetPublishBlock(makeAsset({ status })), status).toBeNull();
    }
  });

  it("refuses an already-published asset, so a second push can't duplicate the post", () => {
    expect(isAssetPublishable(makeAsset({ status: "published" }))).toBe(false);
    expect(assetPublishBlock(makeAsset({ status: "published" }))).toBe("published");
  });

  it("refuses a placeholder whatever its status", () => {
    for (const status of ["draft", "approved", "scheduled", "delivered", "published"] as const) {
      const asset = makeAsset({ status, publishMode: "placeholder" });
      expect(isAssetPublishable(asset), status).toBe(false);
    }
  });

  it("treats an absent publishMode as publishable when the status allows it (legacy assets)", () => {
    const legacy = makeAsset({ status: "scheduled" });
    delete (legacy as any).publishMode;
    expect(isAssetPublishable(legacy)).toBe(true);
  });
});

describe("publishAssetNowAction — the server refusals", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(shared, "requireStaff").mockImplementation(
      async () =>
        ({ id: "u-staff", role: "KAROS_EMPLOYEE", disabled: false, clientId: "c1" }) as any,
    );
    vi.spyOn(auth, "getCurrentUser").mockImplementation(
      async () =>
        ({ id: "u-staff", role: "KAROS_EMPLOYEE", disabled: false, clientId: "c1" }) as any,
    );
    (publishers.inferPlatform as any).mockReturnValue("twitter");
    (publishers.publishAssetToPlatform as any).mockResolvedValue({ postId: "p1" });
    (data.listClientIntegrations as any).mockResolvedValue([
      { platform: "twitter", status: "active" },
    ]);
    (data.claimAssetForPublish as any).mockResolvedValue(true);
    (data.markAssetPublished as any).mockResolvedValue(undefined);
    (data.updateAsset as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an unapproved draft and never touches the platform", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "draft" }));

    const res = await actions.publishAssetNowAction("a1");

    expect(res).toEqual({
      ok: false,
      error: "Only an approved, scheduled, or delivered post can be published — approve it first.",
    });
    expect(publishers.publishAssetToPlatform).not.toHaveBeenCalled();
    // Refused before the claim, so a refusal can't leave a claim behind either.
    expect(data.claimAssetForPublish).not.toHaveBeenCalled();
  });

  it("refuses a calendar-only placeholder and never touches the platform", async () => {
    (data.getAsset as any).mockResolvedValue(
      makeAsset({ status: "approved", publishMode: "placeholder" }),
    );

    const res = await actions.publishAssetNowAction("a1");

    expect(res).toEqual({
      ok: false,
      error: "This is a calendar-only placeholder — Karos never posts it.",
    });
    expect(publishers.publishAssetToPlatform).not.toHaveBeenCalled();
    expect(data.claimAssetForPublish).not.toHaveBeenCalled();
  });

  it("still refuses an already-published asset", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "published" }));

    const res = await actions.publishAssetNowAction("a1");

    expect(res).toEqual({ ok: false, error: "Already published" });
    expect(publishers.publishAssetToPlatform).not.toHaveBeenCalled();
  });

  it("still publishes an approved manual-mode post — the refusals are not a blanket block", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "approved" }));

    const res = await actions.publishAssetNowAction("a1");

    expect(res).toEqual({ ok: true, platform: "twitter" });
    expect(publishers.publishAssetToPlatform).toHaveBeenCalledTimes(1);
  });

  it("phrases its integration refusals with an em dash, not a spaced hyphen", async () => {
    (data.getAsset as any).mockResolvedValue(makeAsset({ status: "approved" }));
    (data.listClientIntegrations as any).mockResolvedValue([]);
    (publishers.inferPlatform as any).mockReturnValue(undefined);

    const noPlatform = await actions.publishAssetNowAction("a1");
    expect(noPlatform).toEqual({
      ok: false,
      error: "No compatible platform connected — connect one in the Integrations tab",
    });

    (data.listClientIntegrations as any).mockResolvedValue([
      { platform: "twitter", status: "expired" },
    ]);
    const deadToken = await actions.publishAssetNowAction("a1", "twitter");
    expect(deadToken).toEqual({
      ok: false,
      error: "No active twitter integration — connect or re-connect it first",
    });
  });
});

/**
 * The wiring, not the rule: three surfaces must ASK the shared predicate rather
 * than re-deriving it, which is the whole reason they disagreed. The rule itself
 * is asserted by calling, above.
 */
describe("all three publish surfaces use the shared predicate", () => {
  const sources = {
    "components/asset-card.tsx": readFileSync(join(SRC, "components/asset-card.tsx"), "utf8"),
    "components/asset-detail-modal.tsx": readFileSync(
      join(SRC, "components/asset-detail-modal.tsx"),
      "utf8",
    ),
    "lib/actions/asset-actions.ts": readFileSync(
      join(SRC, "lib/actions/asset-actions.ts"),
      "utf8",
    ),
  };

  it("imports it from asset-visibility on every surface", () => {
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).toMatch(/from "@\/lib\/asset-visibility"/);
    }
  });

  it("gates the card and the modal on isAssetPublishable", () => {
    expect(sources["components/asset-card.tsx"]).toMatch(
      /canPublishNow =\s*\n?\s*canApprove && compatibleConnected\.length > 0 && isAssetPublishable\(asset\)/,
    );
    expect(sources["components/asset-detail-modal.tsx"]).toMatch(
      /eligible = canPublish && compatibleConnected\.length > 0 && isAssetPublishable\(asset\)/,
    );
  });

  it("gates the server action on assetPublishBlock before it claims or posts", () => {
    const src = sources["lib/actions/asset-actions.ts"];
    const gate = src.indexOf("const block = assetPublishBlock(asset)");
    const claim = src.indexOf("claimAssetForPublish(id)");
    expect(gate).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(gate);
  });
});

/**
 * Reddit is draft-only by hard product contract — a human always replies from
 * their own account, and no posting code path exists. Sharing the eligibility
 * rule between three surfaces must not have quietly brought it into scope: the
 * rule is about the ASSET's status, and platform targeting stays with
 * PUBLISHABLE_PLATFORMS, which has no Reddit entry.
 * (platforms-publishable.test.ts pins the wider contract.)
 */
describe("the shared rule did not bring Reddit into scope", () => {
  it("keeps reddit out of every publish target list", () => {
    for (const [assetType, targets] of Object.entries(PUBLISHABLE_PLATFORMS)) {
      expect(targets, assetType).not.toContain("reddit");
    }
  });

  it("names no platform at all in the eligibility rule", () => {
    const src = readFileSync(join(SRC, "lib/asset-visibility.ts"), "utf8");
    const rule = src.slice(src.indexOf("export function assetPublishBlock"));
    expect(rule.slice(0, rule.indexOf("\n}"))).not.toMatch(/reddit|twitter|linkedin/i);
  });
});
