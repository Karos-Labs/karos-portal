/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "@/lib/actions/asset-actions";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";
import { redactLockedAsset } from "@/lib/asset-visibility";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");

const DAY = 24 * 60 * 60 * 1000;

function makeAsset(patch: Record<string, any> = {}): any {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "Real title",
    content: "real body",
    status: "approved",
    publishMode: "manual",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(auth, "getCurrentUser").mockImplementation(
    async () => ({ id: "u-client", role: "CLIENT_USER", disabled: false, clientId: "c1" }) as any,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("markAssetPostedAction — future-dated posts (churn rule A3/A4)", () => {
  it("refuses a post whose day has not come, so the batch can't be unlocked click by click", async () => {
    const asset = makeAsset({ status: "scheduled", scheduledAt: Date.now() + 3 * DAY });
    (data.getAsset as any).mockResolvedValue(asset);

    const res = await actions.markAssetPostedAction("a1");

    expect(res.ok).toBe(false);
    expect(data.reconcileAssetPublished).not.toHaveBeenCalled();
  });

  it("still allows today's approved post", async () => {
    const asset = makeAsset({ status: "scheduled", scheduledAt: Date.now() });
    (data.getAsset as any).mockResolvedValue(asset);
    (data.reconcileAssetPublished as any).mockResolvedValue({ changed: true });

    const res = await actions.markAssetPostedAction("a1");

    expect(res.ok).toBe(true);
    expect(data.reconcileAssetPublished).toHaveBeenCalled();
  });
});

describe("redactLockedAsset + MarkPostedRow predicate", () => {
  /**
   * The name used to be "keeps status but drops publishMode", and the general
   * claim in it stopped being true when `redactLockedAsset` began carrying
   * `publishMode: "placeholder"` — the one value that is a promise to the client.
   * This fixture uses "manual", which still drops, so the test stayed green while
   * its own title described the opposite of the redaction. A test named for a
   * false premise is the worst place for one to live, so the title now says what
   * is asserted and the placeholder case is asserted beside it.
   */
  it("keeps status and drops a publishMode that is not a client promise", () => {
    const locked = redactLockedAsset(
      makeAsset({ status: "approved", scheduledAt: Date.now() + 3 * DAY }),
    );
    // The exact shape that made the old predicate return true.
    expect(locked.status).toBe("approved");
    expect(locked.publishMode).toBeUndefined();

    // The value that DOES cross, and the reason the predicate may not key on the
    // field's absence: a locked roadmap entry carries it so the calendar can
    // classify it without waiting for its own day.
    const roadmap = redactLockedAsset(
      makeAsset({ status: "approved", scheduledAt: Date.now() + 3 * DAY, publishMode: "placeholder" }),
    );
    expect(roadmap.publishMode).toBe("placeholder");
    expect(locked.locked).toBe(true);
    // …and nothing real crossed the boundary.
    expect(locked.content).toBe("");
    expect(locked.title).not.toBe("Real title");
  });
});
