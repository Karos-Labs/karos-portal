import { describe, expect, it } from "vitest";
import {
  PLATFORM_MEDIA_SUPPORT,
  PUBLISHABLE_PLATFORMS,
  platformSupportsAssetMedia,
} from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";

/**
 * The approve panel's checkbox picker used to offer every platform
 * `PUBLISHABLE_PLATFORMS[asset.type]` names, whatever media the asset
 * actually carries — an article draft with no image could still be checked
 * for Instagram or TikTok, a text-only social post could be checked for
 * YouTube. This is the narrower, per-ASSET filter (product owner rule,
 * 2026-09-22) that sits on top of that type-level ceiling:
 *   - LinkedIn, X: any media, always eligible.
 *   - YouTube: video only.
 *   - Instagram (both ids), TikTok: image or video, never text-only.
 *   - Reddit: out of scope, must never appear.
 */

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

const ANY_MEDIA_PLATFORMS = ["linkedin", "twitter"];
const IMAGE_OR_VIDEO_ONLY_PLATFORMS = ["instagram", "instagram_business", "tiktok"];
const VIDEO_ONLY_PLATFORMS = ["youtube"];
const ALL_SIX = [...ANY_MEDIA_PLATFORMS, ...IMAGE_OR_VIDEO_ONLY_PLATFORMS, ...VIDEO_ONLY_PLATFORMS];

describe("PLATFORM_MEDIA_SUPPORT — the product owner's rule set", () => {
  it("has exactly the stated support level per platform", () => {
    expect(PLATFORM_MEDIA_SUPPORT).toEqual({
      linkedin: "any",
      twitter: "any",
      youtube: "video",
      instagram: "image-or-video",
      instagram_business: "image-or-video",
      tiktok: "image-or-video",
    });
  });

  it("never names reddit, whatever media the asset carries", () => {
    expect(PLATFORM_MEDIA_SUPPORT).not.toHaveProperty("reddit");
  });
});

describe("platformSupportsAssetMedia", () => {
  it("a text-only asset only offers linkedin/twitter", () => {
    const textOnly = makeAsset({ type: "article" });
    for (const p of ANY_MEDIA_PLATFORMS) {
      expect(platformSupportsAssetMedia(p, textOnly), p).toBe(true);
    }
    for (const p of [...IMAGE_OR_VIDEO_ONLY_PLATFORMS, ...VIDEO_ONLY_PLATFORMS]) {
      expect(platformSupportsAssetMedia(p, textOnly), p).toBe(false);
    }
  });

  it("a video asset offers all six platforms", () => {
    const video = makeAsset({ type: "social_post", videoUrl: "https://example.test/clip.mp4" });
    for (const p of ALL_SIX) {
      expect(platformSupportsAssetMedia(p, video), p).toBe(true);
    }
  });

  it("an image-only asset offers everything except youtube", () => {
    const image = makeAsset({ type: "instagram_post", imageUrl: "https://example.test/photo.png" });
    for (const p of [...ANY_MEDIA_PLATFORMS, ...IMAGE_OR_VIDEO_ONLY_PLATFORMS]) {
      expect(platformSupportsAssetMedia(p, image), p).toBe(true);
    }
    expect(platformSupportsAssetMedia("youtube", image)).toBe(false);
  });

  it("reddit never appears as eligible, regardless of media", () => {
    const video = makeAsset({ videoUrl: "https://example.test/clip.mp4" });
    const image = makeAsset({ imageUrl: "https://example.test/photo.png" });
    const textOnly = makeAsset();
    for (const asset of [video, image, textOnly]) {
      expect(platformSupportsAssetMedia("reddit", asset)).toBe(false);
    }
  });

  it("defaults an unknown platform id to ineligible rather than silently offering it", () => {
    const video = makeAsset({ videoUrl: "https://example.test/clip.mp4" });
    expect(platformSupportsAssetMedia("some_future_platform", video)).toBe(false);
  });

  it("every platform PUBLISHABLE_PLATFORMS can ever name has a media-support entry", () => {
    // Defensive coverage the module's own comment claims: nothing in
    // PUBLISHABLE_PLATFORMS's widened values should ever fall through
    // platformSupportsAssetMedia's "unknown platform" default.
    const named = new Set(Object.values(PUBLISHABLE_PLATFORMS).flat());
    for (const platform of named) {
      expect(PLATFORM_MEDIA_SUPPORT, platform).toHaveProperty(platform);
    }
  });
});
