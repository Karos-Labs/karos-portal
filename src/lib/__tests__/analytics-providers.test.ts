import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchPlatformMetrics, MetricsUnavailableError } from "@/lib/integrations/analytics-providers";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import type { Asset } from "@/lib/types";

function credentials(patch: Record<string, string> = { accessToken: "tok" }): Record<string, string> {
  return patch;
}

function asset(patch: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "Post",
    content: "hi",
    status: "published",
    platformPostId: "tweet123",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Asset;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  process.env.ANALYTICS_LIVE_INGEST = "1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  delete process.env.ANALYTICS_LIVE_INGEST;
});

describe("fetchPlatformMetrics — live gating + fallback", () => {
  it("falls back to mock (never calls fetch) when live ingest is disabled", async () => {
    process.env.ANALYTICS_LIVE_INGEST = "0";
    const res = await fetchPlatformMetrics("twitter", credentials(), asset());
    expect(res.source).toBe("mock");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to mock when the asset has no captured platformPostId", async () => {
    const res = await fetchPlatformMetrics("twitter", credentials(), asset({ platformPostId: null }));
    expect(res.source).toBe("mock");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to mock when the integration has no access token", async () => {
    const res = await fetchPlatformMetrics("twitter", credentials({}), asset());
    expect(res.source).toBe("mock");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to mock when there's no integration for the platform at all (empty credentials)", async () => {
    const res = await fetchPlatformMetrics("twitter", {}, asset());
    expect(res.source).toBe("mock");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchPlatformMetrics — live success", () => {
  it("fetches and normalizes live Twitter metrics", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          public_metrics: { impression_count: 1000, like_count: 40, retweet_count: 10, reply_count: 10 },
          non_public_metrics: { url_link_clicks: 25 },
        },
      }),
    );
    const res = await fetchPlatformMetrics("twitter", credentials(), asset());
    expect(res.source).toBe("live");
    expect(res.metrics.impressions).toBe(1000);
    expect(res.metrics.clicks).toBe(25);
    expect(res.metrics.engagementRate).toBeCloseTo(0.06); // (40+10+10)/1000
  });

  it("normalizes live YouTube statistics (string counts → numbers)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [{ statistics: { viewCount: "5000", likeCount: "100", commentCount: "20" } }] }),
    );
    const res = await fetchPlatformMetrics(
      "youtube",
      credentials(),
      asset({ platformPostId: "vid123" }),
    );
    expect(res.source).toBe("live");
    expect(res.metrics.impressions).toBe(5000);
    expect(res.metrics.engagementRate).toBeCloseTo(0.024); // (100+20)/5000
  });
});

describe("fetchPlatformMetrics — resilience", () => {
  it("propagates TokenExpiredError on a 401 so the batch can mark reauth", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    await expect(fetchPlatformMetrics("twitter", credentials(), asset())).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it("propagates a non-auth HTTP failure (batch skips, no fake mock data)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    await expect(fetchPlatformMetrics("twitter", credentials(), asset())).rejects.toThrow(/500/);
  });

  it("MetricsUnavailableError is exported and is not a TokenExpiredError", () => {
    const e = new MetricsUnavailableError("x");
    expect(e).toBeInstanceOf(MetricsUnavailableError);
    expect(e).not.toBeInstanceOf(TokenExpiredError);
  });
});
