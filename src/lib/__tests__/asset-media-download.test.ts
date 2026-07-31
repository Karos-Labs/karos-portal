import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assetDownloadTargets, assetVideoSrc, assetVideos } from "@/lib/asset-images";
import { isMediaContentType } from "@/lib/media-type";
import type { Asset } from "@/lib/types";

/**
 * The assets/download cluster — two things the product owner hit on the 30 Jul
 * call, and the mechanism underneath both.
 *
 *  1. `registerClip` persisted a V4 signed URL with a 7-day TTL as the asset's
 *     `videoUrl`, and nothing ever re-signed it. `bulkScheduleClipsAction`
 *     then spreads a batch one clip per day across weeks, so most of a 30-clip
 *     batch was a dead link by the day its clip was shown.
 *  2. "I downloaded, but it didn't open" — an expired signed URL does not
 *     answer with video. GCS answers `403 application/xml` with an `<Error>`
 *     document; anything that writes that to disk under the clip's name
 *     produces a file that will not open.
 *  3. A clip had no download control at all: both mount sites gated on photos
 *     existing, and the route only ever served photos.
 *
 * Firestore is not writable by this campaign (dev credentials point at
 * production), so the fix is entirely on the read path: re-sign per request
 * from the durable `meta.gcsPath` the upload already stored. The wiring that
 * makes that true is invisible to a type check, so the parts that live in
 * sources are asserted from the sources, in the style of settings-nav.test.ts.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const BULK_UPLOAD = "src/app/api/assets/bulk-upload/route.ts";
const MEDIA_ROUTE = "src/app/api/assets/[id]/media/route.ts";
const DOWNLOAD_ROUTE = "src/app/api/assets/[id]/download/route.ts";
const ASSET_MEDIA = "src/lib/asset-media.ts";
const ASSET_IMAGES = "src/lib/asset-images.ts";
const CARD = "src/components/asset-card.tsx";
const MODAL = "src/components/asset-detail-modal.tsx";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    clientId: "c1",
    title: "Podcast cut 3",
    content: "",
    createdBy: "staff-1",
    createdAt: 0,
    updatedAt: 0,
    status: "approved",
    type: "social_post",
    ...overrides,
  };
}

/** A bulk-uploaded clip as `registerClip` writes it: signed URL + durable path. */
function makeClip(overrides: Partial<Asset> = {}): Asset {
  return makeAsset({
    videoUrl: "https://storage.googleapis.com/bucket/clients/c1/podcast-clips/1-clip.mp4?X-Goog-Expires=604800",
    meta: { bulkUpload: true, gcsPath: "clients/c1/podcast-clips/1-clip.mp4" },
    ...overrides,
  });
}

/* ── 1. the persisted URL is not what the client is served ─────────────── */

describe("a bulk-uploaded clip is re-signed on read, not served the URL that was stored", () => {
  const upload = source(BULK_UPLOAD);
  const media = source(ASSET_MEDIA);

  it("still stores the durable identifier the fix depends on", () => {
    // The premise. If the upload ever stops writing meta.gcsPath, the read
    // path has nothing to re-sign from and the 7-day expiry is back.
    expect(upload).toContain("gcsPath: opts.gcsPath");
    expect(upload).toContain("const videoUrl = await createReadSignedUrl(opts.gcsPath)");
    expect(source("src/lib/gcs-media.ts")).toContain("export const READ_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000");
  });

  it("re-signs from meta.gcsPath at request time", () => {
    expect(media).toContain('typeof asset.meta?.gcsPath === "string"');
    expect(media).toContain("await createReadSignedUrl(gcsPath, PLAYBACK_URL_TTL_MS)");
  });

  it("writes nothing back — re-signing is request-time only", () => {
    // The campaign's hard constraint: dev credentials point at production.
    expect(media).not.toMatch(/updateAsset|createAsset|\.set\(|\.update\(/);
  });

  it("falls back to the stored URL for an asset with no gcsPath", () => {
    // Tomer's migration is mid-flight: webhook clips are re-hosted to Firebase
    // Storage and carry no bucket path. Those must not 500.
    expect(media).toContain(
      "if (!gcsPath || !asset.videoUrl || video.url !== asset.videoUrl) return video.url;",
    );
    // A signing failure degrades the same way rather than throwing.
    expect(media).toMatch(/catch \{\s*return video\.url;/);
  });

  it("points playback at our route rather than at a raw signed bucket URL", () => {
    expect(assetVideoSrc("a1", 0)).toBe("/api/assets/a1/media?i=0");
    expect(assetVideoSrc("a1", 2)).toBe("/api/assets/a1/media?i=2");

    for (const rel of [CARD, MODAL]) {
      const src = source(rel);
      expect(src, `${rel} still renders a stored URL into <video>`).not.toContain("src={v.url}");
      expect(src).toContain("src={assetVideoSrc(asset.id, i)}");
    }
  });

  it("redirects to the fresh URL instead of caching one", () => {
    const route = source(MEDIA_ROUTE);
    expect(route).toContain("resolveAssetVideoUrl");
    expect(route).toContain("status: 302");
    expect(route).toContain('"Cache-Control": "private, no-store"');
  });

  it("authorizes the same way the download route does", () => {
    // One implementation, called by both — copied blocks drift.
    expect(source(MEDIA_ROUTE)).toContain("await authorizeAssetMedia(id)");
    expect(source(DOWNLOAD_ROUTE)).toContain("await authorizeAssetMedia(id)");
    expect(media).toContain("isStaff(user)");
    expect(media).toContain("user.clientId !== asset.clientId");
    expect(media).toContain("isAssetUnlockedForClient(asset, Date.now())");
  });

  it("keeps assetVideos pure and client-safe", () => {
    // It runs in the browser on every card; a server import here would break
    // every render site at once.
    const images = source(ASSET_IMAGES);
    expect(images).not.toMatch(/^import "server-only";/m);
    expect(images).not.toContain("gcs-media");
    expect(assetVideos(makeClip()).map((v) => v.url)).toEqual([makeClip().videoUrl]);
  });
});

/* ── 2. nothing is saved to disk that isn't the media ──────────────────── */

describe("an attachment is only ever written when the bytes are media", () => {
  const route = source(DOWNLOAD_ROUTE);

  it("rejects the error documents a dead storage link returns", () => {
    // Measured against storage.googleapis.com: an invalid/expired V4 signature
    // answers 403 with `content-type: application/xml` and an <Error> body.
    expect(isMediaContentType("application/xml; charset=UTF-8", "video")).toBe(false);
    expect(isMediaContentType("text/html", "image")).toBe(false);
    expect(isMediaContentType("application/json", "video")).toBe(false);
    expect(isMediaContentType(null, "video")).toBe(false);
    expect(isMediaContentType("", "image")).toBe(false);
  });

  it("accepts real media, including an untyped bucket object", () => {
    expect(isMediaContentType("video/mp4", "video")).toBe(true);
    expect(isMediaContentType("image/png", "image")).toBe(true);
    expect(isMediaContentType("application/octet-stream", "video")).toBe(true);
    // Kind is not interchangeable: a photo is not a clip.
    expect(isMediaContentType("image/png", "video")).toBe(false);
  });

  it("guards every path that sets Content-Disposition on fetched bytes", () => {
    // Three responses carry a disposition: the clip, the single photo, and the
    // zip — and three guards run, one per set of fetched bytes (the zip's
    // entries are each checked on the way in, so a failed photo is skipped
    // rather than archived).
    expect(route.match(/"Content-Disposition"/g) ?? []).toHaveLength(3);
    expect(route.match(/isMediaContentType\(/g) ?? []).toHaveLength(3);
  });

  it("keeps the existing 502 shape for a bad upstream", () => {
    expect(route).toContain('{ error: "Could not fetch video" }, { status: 502 }');
    expect(route).toContain('{ error: "Could not fetch image" }, { status: 502 }');
    expect(route).toContain('{ error: "Could not fetch images" }, { status: 502 }');
  });
});

/* ── 3. the download route serves video, not only images ───────────────── */

describe("the download route serves a clip", () => {
  const route = source(DOWNLOAD_ROUTE);

  it("reads the video list, not only the image list", () => {
    expect(route).toContain("assetVideos");
    expect(route).toContain('query.get("kind") === "video"');
  });

  it("serves the clip for an asset that has no photos at all", () => {
    // The bare /download a card links to must still work for a clip.
    expect(route).toContain('if (query.get("kind") === "video" || images.length === 0) {');
  });

  it("re-signs the clip rather than fetching the stored URL", () => {
    expect(route).toContain("await resolveAssetVideoUrl(asset, index)");
  });

  it("streams the body instead of buffering a 2 GB file", () => {
    expect(route).toContain("new NextResponse(res.body");
    expect(route).toContain("export const maxDuration = 300");
  });

  it("names the file after the asset, with a video extension", () => {
    expect(route).toContain("videoExtFromUrl(videos[index].url)");
  });

  it("offers one clip per request rather than zipping clips", () => {
    // JSZip buffers whole files; a clip can be 2 GB.
    const clipBranch = route.slice(route.indexOf('query.get("kind")'), route.indexOf("// Single photo"));
    expect(clipBranch).not.toContain("JSZip");
    expect(clipBranch).not.toContain("zip.file");
  });
});

/* ── 4. the control exists for a clip, and still refuses a locked asset ── */

describe("the download control", () => {
  it("renders for an asset with a video and no images", () => {
    const targets = assetDownloadTargets(makeClip());
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      kind: "video",
      href: "/api/assets/a1/download?kind=video&i=0",
      label: "Download video",
    });
  });

  it("refuses a locked asset — a future-dated post stays withheld", () => {
    expect(assetDownloadTargets(makeClip({ locked: true }))).toEqual([]);
    expect(
      assetDownloadTargets(makeAsset({ locked: true, imageUrl: "https://cdn.test/a.jpg" })),
    ).toEqual([]);
    // And the server refuses too, whatever the browser renders.
    expect(source(ASSET_MEDIA)).toContain("isAssetUnlockedForClient(asset, Date.now())");
  });

  it("leaves the photo download exactly as it was", () => {
    const single = assetDownloadTargets(makeAsset({ imageUrl: "https://cdn.test/a.jpg" }));
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ href: "/api/assets/a1/download", label: "Download" });

    const carousel = assetDownloadTargets(
      makeAsset({ meta: { images: ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg"] } }),
    );
    expect(carousel[0]).toMatchObject({
      href: "/api/assets/a1/download",
      label: "Download all (2)",
      title: "Download all 2 photos as a zip",
    });
  });

  it("offers both on a mixed asset, photos first", () => {
    const mixed = assetDownloadTargets(makeClip({ imageUrl: "https://cdn.test/poster.jpg" }));
    expect(mixed.map((t) => t.kind)).toEqual(["image", "video"]);
  });

  it("names each clip when an asset carries several", () => {
    const many = assetDownloadTargets(
      makeAsset({ meta: { videos: ["https://cdn.test/1.mp4", "https://cdn.test/2.mp4"] } }),
    );
    expect(many.map((t) => t.label)).toEqual(["Download clip 1", "Download clip 2"]);
    expect(many[1].href).toBe("/api/assets/a1/download?kind=video&i=1");
  });

  it("is mounted from the shared helper at both sites, not re-gated on photos", () => {
    for (const rel of [CARD, MODAL]) {
      const src = source(rel);
      expect(src).toContain("assetDownloadTargets(asset)");
      expect(src, `${rel} still gates its download on photos`).not.toContain(
        "galleryImages.length > 0 && (\n              <a",
      );
    }
    const modal = source(MODAL);
    expect(modal).not.toContain("if (images.length === 0) return null;");
    // The section WRAPPING the buttons was a third gate on photos — a clip
    // reached a modal that mounted no Download section at all.
    expect(modal).toContain("{downloads.length > 0 && (");
    expect(modal).not.toContain("{images.length > 0 && (");
  });
});
