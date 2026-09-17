import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaAccessNotGrantedError,
  fetchInstagramFollowerCount,
  fetchInstagramMediaInsights,
  listRecentInstagramMedia,
  resolveInstagramBusinessAccountId,
} from "@/lib/integrations/instagram-insights";
import { TokenExpiredError } from "@/lib/integrations/publishers";

const TOKEN = "EAAtest-system-user-token";
const PAGE_ID = "1234567890";
const IG_USER_ID = "17841400000000000";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveInstagramBusinessAccountId", () => {
  it("resolves the linked Instagram account id from a Page id", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain(`/${PAGE_ID}?fields=instagram_business_account`);
      expect(url).toContain(`access_token=${TOKEN}`);
      return jsonResponse({ instagram_business_account: { id: IG_USER_ID } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).resolves.toBe(IG_USER_ID);
  });

  it("returns null, not an error, when the Page has no linked Instagram account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).resolves.toBeNull();
  });

  it("throws TokenExpiredError on Meta's dead-token shape (code 190)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: 190, message: "Error validating access token" } }, 401)));
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("throws MetaAccessNotGrantedError on Meta's permission-pending shape (code 10)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: 10, message: "Application does not have permission for this action" } }, 403)),
    );
    await expect(resolveInstagramBusinessAccountId(TOKEN, PAGE_ID)).rejects.toBeInstanceOf(MetaAccessNotGrantedError);
  });
});

describe("listRecentInstagramMedia", () => {
  it("normalizes media_product_type into a FEED/REELS/STORY mediaType", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "media-feed-1", media_type: "IMAGE", timestamp: "2026-09-10T10:00:00+0000", permalink: "https://instagram.com/p/1" },
            { id: "media-reel-1", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-09-12T10:00:00+0000" },
          ],
        }),
      ),
    );
    const media = await listRecentInstagramMedia(TOKEN, IG_USER_ID);
    expect(media).toEqual([
      { id: "media-feed-1", mediaType: "FEED", timestamp: "2026-09-10T10:00:00+0000", permalink: "https://instagram.com/p/1" },
      { id: "media-reel-1", mediaType: "REELS", timestamp: "2026-09-12T10:00:00+0000" },
    ]);
  });
});

describe("fetchInstagramMediaInsights", () => {
  const values: Record<string, number> = { reach: 500, views: 900, saved: 12, shares: 4, follows: 3, profile_visits: 7 };

  function insightsFetchMock() {
    return vi.fn(async (url: string) => {
      const requested = new URL(url).searchParams.get("metric")!.split(",");
      return jsonResponse({ data: requested.map((name) => ({ name, values: [{ value: values[name] ?? 0 }] })) });
    });
  }

  it("returns all six metrics for a FEED post", async () => {
    vi.stubGlobal("fetch", insightsFetchMock());
    const insights = await fetchInstagramMediaInsights(TOKEN, "media-feed-1", "FEED");
    expect(insights).toEqual({ mediaId: "media-feed-1", reach: 500, views: 900, saved: 12, shares: 4, follows: 3, profileVisits: 7 });
  });

  it("never requests follows/profile_visits for a Reel, and reports them null rather than 0", async () => {
    const mock = insightsFetchMock();
    vi.stubGlobal("fetch", mock);
    const insights = await fetchInstagramMediaInsights(TOKEN, "media-reel-1", "REELS");
    expect(insights).toEqual({ mediaId: "media-reel-1", reach: 500, views: 900, saved: 12, shares: 4, follows: null, profileVisits: null });
    const requestedUrl = mock.mock.calls[0]![0] as string;
    const requestedMetrics = new URL(requestedUrl).searchParams.get("metric")!.split(",");
    expect(requestedMetrics).not.toContain("follows");
    expect(requestedMetrics).not.toContain("profile_visits");
  });

  it("never requests saved for a Story, and reports it null", async () => {
    vi.stubGlobal("fetch", insightsFetchMock());
    const insights = await fetchInstagramMediaInsights(TOKEN, "media-story-1", "STORY");
    expect(insights.saved).toBeNull();
  });
});

describe("fetchInstagramFollowerCount", () => {
  it("reads the account's current follower total", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ followers_count: 12_345 })));
    await expect(fetchInstagramFollowerCount(TOKEN, IG_USER_ID)).resolves.toBe(12_345);
  });
});
