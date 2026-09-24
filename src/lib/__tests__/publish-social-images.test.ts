/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishAssetToPlatform } from "@/lib/integrations/publishers";

/**
 * THE PICTURE THE ENGINE WORKED FOR, ACTUALLY ON THE POST.
 *
 * Both of these publishers posted text and dropped the picture on the floor:
 * `attachesPhoto: false`, no media block, no error. The agents behind those
 * posts run a four-tier media cascade (a screenshot of the cited page, the
 * article's lead image, licensed stock, generation last), vision-vet the
 * winner and record its licence — and none of it reached the platform.
 * Nothing failed, so nothing showed it: the only way to see the drop was to
 * compare the published post with the draft.
 *
 * Two rules are pinned here and the second matters more than the first:
 *
 *   1. the picture is uploaded and attached, with the alt text agent-engine
 *      derived — never one invented in this repo, which has never looked at
 *      the photograph;
 *   2. the picture NEVER costs the post. Every failure in the upload path
 *      falls back to the text-only body that shipped before, because a post
 *      without its picture is a worse post and a post that failed is no post.
 */

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
}

function imageResponse(bytes = 2048, contentType = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: async () => new ArrayBuffer(bytes),
    json: async () => ({}),
  };
}

function asset(overrides: Record<string, any> = {}) {
  return {
    id: "a1",
    clientId: "c1",
    type: "note",
    title: "A post",
    content: "The post body.",
    meta: {
      files: [{ name: "hero.png", url: "https://cdn.test/hero.png" }],
      media: { url: "https://cdn.test/hero.png", altText: "Two warehouse workers scanning boxes on a pallet." },
    },
    status: "draft",
    ...overrides,
  } as any;
}

let calls: Array<{ url: string; method: string; body: any }>;

function stub(handler: (url: string, init?: RequestInit) => any) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      return handler(url, init);
    }),
  );
}

/** Every JSON request body we sent, parsed — a multipart upload parses to null and sits out. */
const jsonBodies = () =>
  calls.map((c) => {
    try {
      return typeof c.body === "string" ? JSON.parse(c.body) : null;
    } catch {
      return null;
    }
  });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("X: the draft's picture goes up with the tweet", () => {
  const integration = { platform: "twitter", credentials: { accessToken: "x-tok" } } as any;

  it("uploads the image, sets the engine's alt text, and posts with the media id", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return imageResponse();
      if (url === "https://api.x.com/2/media/upload") return jsonResponse({ data: { id: "media-77" } });
      if (url === "https://api.x.com/2/media/metadata") return jsonResponse({});
      return jsonResponse({ data: { id: "tweet-1" } });
    });

    const result = await publishAssetToPlatform("twitter", integration, asset());
    expect(result.postId).toBe("tweet-1");

    const metadata = jsonBodies().find((b) => b?.metadata?.alt_text);
    expect(metadata.id).toBe("media-77");
    expect(metadata.metadata.alt_text.text).toBe("Two warehouse workers scanning boxes on a pallet.");

    const tweet = jsonBodies().find((b) => b?.text);
    expect(tweet.media.media_ids).toEqual(["media-77"]);
  });

  it("posts the text anyway when the upload is refused — the picture never costs the post", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return imageResponse();
      if (url === "https://api.x.com/2/media/upload") return jsonResponse({ title: "Unauthorized" }, 403);
      return jsonResponse({ data: { id: "tweet-2" } });
    });

    const result = await publishAssetToPlatform("twitter", integration, asset());
    expect(result.postId).toBe("tweet-2");
    const tweet = jsonBodies().find((b) => b?.text);
    expect(tweet.media).toBeUndefined();
  });

  it("posts the text anyway when the image host is down, without attempting an upload", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return jsonResponse({}, 404);
      return jsonResponse({ data: { id: "tweet-3" } });
    });
    expect((await publishAssetToPlatform("twitter", integration, asset())).postId).toBe("tweet-3");
    expect(calls.some((c) => c.url.includes("/media/upload"))).toBe(false);
  });

  it("sends no alt text when the engine derived none, rather than inventing one", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return imageResponse();
      if (url === "https://api.x.com/2/media/upload") return jsonResponse({ data: { id: "media-9" } });
      return jsonResponse({ data: { id: "tweet-4" } });
    });
    await publishAssetToPlatform("twitter", integration, asset({ meta: { files: [{ name: "h.png", url: "https://cdn.test/hero.png" }] } }));
    expect(calls.some((c) => c.url === "https://api.x.com/2/media/metadata")).toBe(false);
  });

  it("still posts a text-only draft exactly as it did before, in one call", async () => {
    stub(() => jsonResponse({ data: { id: "tweet-5" } }));
    const result = await publishAssetToPlatform("twitter", integration, asset({ meta: {} }));
    expect(result.postId).toBe("tweet-5");
    expect(calls).toHaveLength(1);
  });
});

describe("LinkedIn: the draft's picture goes up with the share", () => {
  const integration = { platform: "linkedin", credentials: { accessToken: "li-tok", organizationId: "urn:li:organization:42" } } as any;

  it("registers, uploads, and shares as IMAGE with the alt text in `description`", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return imageResponse();
      if (url.includes("registerUpload")) {
        return jsonResponse({
          value: {
            asset: "urn:li:digitalmediaAsset:abc",
            uploadMechanism: {
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://upload.linkedin.test/abc" },
            },
          },
        });
      }
      if (url.startsWith("https://upload.linkedin.test/")) return jsonResponse({}, 201);
      return jsonResponse({ id: "urn:li:share:1" }, 200, { "x-restli-id": "urn:li:share:1" });
    });

    const result = await publishAssetToPlatform("linkedin", integration, asset());
    expect(result.postId).toBe("urn:li:share:1");

    const put = calls.find((c) => c.url.startsWith("https://upload.linkedin.test/"));
    expect(put?.method).toBe("PUT");

    const share = jsonBodies().find((b) => b?.specificContent);
    const content = share.specificContent["com.linkedin.ugc.ShareContent"];
    expect(content.shareMediaCategory).toBe("IMAGE");
    expect(content.media[0].media).toBe("urn:li:digitalmediaAsset:abc");
    // `description` IS LinkedIn's alt text on a ugcPost image.
    expect(content.media[0].description.text).toBe("Two warehouse workers scanning boxes on a pallet.");
  });

  it("shares as NONE when the registration is refused, and the post still goes out", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return imageResponse();
      if (url.includes("registerUpload")) return jsonResponse({ message: "no" }, 403);
      return jsonResponse({ id: "urn:li:share:2" }, 200, { "x-restli-id": "urn:li:share:2" });
    });

    const result = await publishAssetToPlatform("linkedin", integration, asset());
    expect(result.postId).toBe("urn:li:share:2");
    const content = jsonBodies().find((b) => b?.specificContent).specificContent["com.linkedin.ugc.ShareContent"];
    expect(content.shareMediaCategory).toBe("NONE");
    expect(content.media).toBeUndefined();
  });

  it("shares as NONE when the byte upload fails", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return imageResponse();
      if (url.includes("registerUpload")) {
        return jsonResponse({
          value: {
            asset: "urn:li:digitalmediaAsset:abc",
            uploadMechanism: {
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://upload.linkedin.test/abc" },
            },
          },
        });
      }
      if (url.startsWith("https://upload.linkedin.test/")) return jsonResponse({}, 500);
      return jsonResponse({ id: "urn:li:share:3" }, 200, { "x-restli-id": "urn:li:share:3" });
    });

    expect((await publishAssetToPlatform("linkedin", integration, asset())).postId).toBe("urn:li:share:3");
    const content = jsonBodies().find((b) => b?.specificContent).specificContent["com.linkedin.ugc.ShareContent"];
    expect(content.shareMediaCategory).toBe("NONE");
  });

  it("refuses an image over the upload limit rather than sending it", async () => {
    stub((url) => {
      if (url.startsWith("https://cdn.test/")) return imageResponse(6 * 1024 * 1024);
      return jsonResponse({ id: "urn:li:share:4" }, 200, { "x-restli-id": "urn:li:share:4" });
    });
    expect((await publishAssetToPlatform("linkedin", integration, asset())).postId).toBe("urn:li:share:4");
    expect(calls.some((c) => c.url.includes("registerUpload"))).toBe(false);
  });
});
