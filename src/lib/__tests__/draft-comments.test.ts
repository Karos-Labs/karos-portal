import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CLIENT IS IN THIS THREAD, WHICH IS THE WHOLE POINT AND THE WHOLE RISK.
 *
 * §09 asked for a conversation about a draft between the client and their
 * account manager: the ticket system had comments, content had none, so "this
 * line, not that one" went to Slack or nowhere.
 *
 * Because a client writes here, the fence is what the tests are about. Both
 * actions resolve the ASSET first and refuse a client whose client does not
 * own it — the same check every other asset action makes. A thread that let
 * one client read another's drafts would be the worst possible version of this
 * feature.
 */

const { getAssetMock, listMock, createMock, userMock } = vi.hoisted(() => ({
  getAssetMock: vi.fn(),
  listMock: vi.fn(),
  createMock: vi.fn(),
  userMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  getAsset: getAssetMock,
  listAssetComments: listMock,
  createAssetComment: createMock,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: userMock }));

import { addAssetCommentAction, getAssetCommentsAction } from "@/lib/actions/asset-comment-actions";

const ASSET = { id: "a1", clientId: "c1", title: "Draft", content: "text" };

beforeEach(() => {
  vi.clearAllMocks();
  getAssetMock.mockResolvedValue(ASSET);
  listMock.mockResolvedValue([]);
  createMock.mockResolvedValue("comment-1");
  userMock.mockResolvedValue({ uid: "u1", name: "Dana", role: "KAROS_EMPLOYEE", disabled: false });
});

describe("who may read and write the thread", () => {
  it("lets the client whose draft it is take part", () => {
    userMock.mockResolvedValue({ uid: "u2", name: "Client", role: "CLIENT_USER", clientId: "c1", disabled: false });
    return expect(addAssetCommentAction("a1", "Make the second line punchier")).resolves.toMatchObject({ ok: true });
  });

  it("refuses a client reading another client's draft", async () => {
    userMock.mockResolvedValue({ uid: "u3", name: "Other", role: "CLIENT_USER", clientId: "c2", disabled: false });
    expect(await getAssetCommentsAction("a1")).toMatchObject({ comments: [], error: "Forbidden" });
    expect(await addAssetCommentAction("a1", "hello")).toMatchObject({ ok: false, error: "Forbidden" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses a disabled account, and a signed-out one", async () => {
    userMock.mockResolvedValue({ uid: "u4", name: "Gone", role: "KAROS_EMPLOYEE", disabled: true });
    expect(await addAssetCommentAction("a1", "hello")).toMatchObject({ ok: false, error: "Unauthorized" });
    userMock.mockResolvedValue(null);
    expect(await getAssetCommentsAction("a1")).toMatchObject({ error: "Unauthorized" });
  });

  it("says the asset is missing rather than writing a comment into nothing", async () => {
    getAssetMock.mockResolvedValue(null);
    expect(await addAssetCommentAction("a1", "hello")).toMatchObject({ ok: false, error: "Asset not found" });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("what a comment carries", () => {
  it("stamps the author, their role and the client, and returns the row it wrote", async () => {
    // The role is what makes the thread a conversation rather than a note to
    // self, and `clientId` is what lets it be listed per client at all.
    const result = await addAssetCommentAction("a1", "  Tighten the close.  ");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "a1", clientId: "c1", content: "Tighten the close.", authorName: "Dana", authorRole: "KAROS_EMPLOYEE" }),
    );
    expect(result.comment).toMatchObject({ id: "comment-1", content: "Tighten the close." });
  });

  it("refuses an empty comment before it reaches the database", async () => {
    expect(await addAssetCommentAction("a1", "   ")).toMatchObject({ ok: false });
    expect(createMock).not.toHaveBeenCalled();
  });
});
