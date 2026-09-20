/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishAssetToPlatform, TokenExpiredError } from "@/lib/integrations/publishers";

/**
 * `publishToInstagramBusiness` — the "Instagram (direct login)" card's own
 * publish path, added 2026-09-20 alongside `instagram_business_content_publish`
 * in the App Review submission. Distinct from `publishToInstagram` (the
 * Facebook-Login card): no `me/accounts` page-discovery hop, and every call
 * goes to `graph.instagram.com`, never `graph.facebook.com` — mixing the two
 * hosts up is exactly the kind of silent-wrong-host bug this pins against.
 */

const integration = {
  platform: "instagram_business",
  credentials: { accessToken: "ig-biz-tok" },
} as any;

function asset(overrides: Record<string, any> = {}) {
  return {
    id: "a1",
    clientId: "c1",
    type: "instagram_post",
    title: "Direct-login post",
    content: "Caption",
    meta: { files: [{ name: "hero.png", url: "https://cdn.test/hero.png" }] },
    status: "draft",
    ...overrides,
  } as any;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  };
}

let calls: Array<{ url: string; body: any }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      let body: any = init?.body;
      if (body instanceof URLSearchParams) body = Object.fromEntries(body.entries());
      calls.push({ url, body });
      if (url.includes("/media_publish")) return jsonResponse({ id: "ig-biz-post-1" });
      if (url.includes("/media")) return jsonResponse({ id: "container-1" });
      if (url.includes("/me")) return jsonResponse({ id: "ig-biz-user-1" });
      return jsonResponse({});
    }),
  );
});

describe("publishToInstagramBusiness", () => {
  it("publishes against graph.instagram.com only, never graph.facebook.com", async () => {
    const result = await publishAssetToPlatform("instagram_business", integration, asset());

    expect(result.postId).toBe("ig-biz-post-1");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toContain("graph.instagram.com");
      expect(call.url).not.toContain("graph.facebook.com");
    }
  });

  it("resolves the account via /me, with no me/accounts page-discovery hop", async () => {
    await publishAssetToPlatform("instagram_business", integration, asset());

    expect(calls.some((c) => c.url.includes("me/accounts"))).toBe(false);
    expect(calls[0]!.url).toContain("/me?");
  });

  it("creates the media container against the resolved account id, then publishes it", async () => {
    await publishAssetToPlatform("instagram_business", integration, asset());

    expect(calls[1]!.url).toContain("ig-biz-user-1/media");
    expect(calls[1]!.body.image_url).toBe("https://cdn.test/hero.png");
    expect(calls[1]!.body.caption).toBe("Caption");
    expect(calls[2]!.url).toContain("ig-biz-user-1/media_publish");
    expect(calls[2]!.body.creation_id).toBe("container-1");
  });

  it("throws TokenExpiredError('instagram_business', …) on a 401", async () => {
    (globalThis.fetch as any).mockImplementationOnce(async (url: string) => {
      calls.push({ url, body: null });
      return jsonResponse({ error: { message: "expired" } }, 401);
    });

    await expect(publishAssetToPlatform("instagram_business", integration, asset())).rejects.toThrow(
      TokenExpiredError,
    );
  });

  it("refuses a clip-only asset with the Reels reason, same as the Facebook-login card", async () => {
    const clipOnly = asset({ content: "", meta: {}, videoUrl: "https://cdn.test/clip.mp4" });
    await expect(publishAssetToPlatform("instagram_business", integration, clipOnly)).rejects.toThrow(
      /Reels\) publishing is not automated yet/,
    );
    expect(calls).toHaveLength(0);
  });
});
