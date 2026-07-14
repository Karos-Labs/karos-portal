import { describe, expect, it } from "vitest";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import type { Asset } from "@/lib/types";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    title: "Draft asset",
    content: "Body",
    createdBy: "staff-1",
    createdAt: 1,
    updatedAt: 1,
    status: "draft",
    type: "social_post",
    ...overrides,
  };
}

describe("getClientLibraryAssets", () => {
  it("keeps draft assets visible in the client library", () => {
    const draft = makeAsset({ id: "draft-1", status: "draft", updatedAt: 20 });
    const approved = makeAsset({ id: "approved-1", status: "approved", updatedAt: 10 });

    const visible = getClientLibraryAssets([draft, approved]);

    expect(visible.map((asset) => asset.id)).toEqual(["draft-1", "approved-1"]);
  });

  it("orders the client library by recency", () => {
    const older = makeAsset({ id: "older", status: "approved", updatedAt: 5 });
    const newer = makeAsset({ id: "newer", status: "draft", updatedAt: 99 });

    const visible = getClientLibraryAssets([older, newer]);

    expect(visible.map((asset) => asset.id)).toEqual(["newer", "older"]);
  });
});
