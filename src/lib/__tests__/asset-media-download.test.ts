/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assetDownloadTargets, assetVideoSrc, assetVideos } from "@/lib/asset-images";
import { isErrorDocumentContentType, isVideoContentType } from "@/lib/media-type";
import { resolveAssetVideoSource, videoMimeFromPath } from "@/lib/asset-video-source";
import type { Asset } from "@/lib/types";

/**
 * The assets/download cluster — two things the product owner hit on the 30 Jul
 * call, and the mechanism underneath both.
 *
 *  1. `registerClip` persisted a V4 signed URL with a 7-day TTL as the asset's
 *     `videoUrl`, and nothing ever re-signed it. `bulkScheduleClipsAction`
 *     then spreads a batch one clip per day across weeks, so most of a 30-clip
 *     batch was a dead link by the day its clip was shown.
 *  2. A clip had no download control at all: both mount sites gated on photos
 *     existing, and the route only ever served photos.
 *
 * "I downloaded, but it didn't open" is NOT reproduced, and this route was not
 * the surface — it served no clip before this change and no control offered
 * one. The plausible surface is the browser's own Download item on
 * `<video controls>`, fetching the expired `src` and saving GCS's XML `<Error>`
 * body; the cure for that is `<video src>` now pointing at our re-signing
 * route. The content-type check is a separate promise this route makes about
 * its own output, not a fix for a click anyone made.
 *
 * Firestore is not writable by this campaign (dev credentials point at
 * production), so the fix is entirely on the read path: re-sign per request
 * from the durable `meta.gcsPath` the upload already stored.
 *
 * Almost everything below is EXECUTED. Source-text assertions survive only
 * where they pin wiring that cannot be run from here — that a JSX prop is
 * mounted, that the upload still writes the field the read path depends on.
 */

/* ── mocks for the route-level tests ───────────────────────────────────── */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ id: "u1", email: "staff@karoslabs.com", role: "admin", disabled: false })),
  isStaff: (u: any) => u?.role === "admin" || u?.role === "employee",
}));

vi.mock("@/lib/data", () => ({ getAsset: vi.fn() }));

vi.mock("@/lib/gcs-media", () => ({
  PLAYBACK_URL_TTL_MS: 60 * 60 * 1000,
  createReadSignedUrl: vi.fn(async (gcsPath: string) => `https://signed.test/${gcsPath}?sig=read`),
  createDownloadSignedUrl: vi.fn(
    async (opts: { gcsPath: string; filename: string; contentType?: string }) =>
      `https://signed.test/${opts.gcsPath}?sig=dl` +
      `&response-content-disposition=${encodeURIComponent(`attachment; filename="${opts.filename}"`)}` +
      (opts.contentType ? `&response-content-type=${encodeURIComponent(opts.contentType)}` : ""),
  ),
}));

import * as data from "@/lib/data";
import * as gcs from "@/lib/gcs-media";
import { GET as downloadGET } from "@/app/api/assets/[id]/download/route";
import { GET as mediaGET } from "@/app/api/assets/[id]/media/route";

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const BULK_UPLOAD = "src/app/api/assets/bulk-upload/route.ts";
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

/* ═══ 1. resolveAssetVideoSource — every branch CALLED ═══════════════════ */

describe("resolveAssetVideoSource picks the URL a clip can actually be fetched from", () => {
  /** Records what it was asked to sign so the response overrides can be checked. */
  function recordingSigner() {
    const calls: Array<{ gcsPath: string; opts: { downloadFilename?: string; contentType?: string } }> = [];
    const sign = async (gcsPath: string, opts: { downloadFilename?: string; contentType?: string }) => {
      calls.push({ gcsPath, opts });
      return `https://signed.test/${gcsPath}?fresh`;
    };
    return { sign, calls };
  }

  it("branch 1 — returns null when there is no clip at that index", async () => {
    const { sign } = recordingSigner();
    expect(await resolveAssetVideoSource(makeAsset(), 0, sign)).toBeNull();
    expect(await resolveAssetVideoSource(makeClip(), 3, sign)).toBeNull();
  });

  it("branch 2 — re-signs from meta.gcsPath when it names the stored clip", async () => {
    const { sign, calls } = recordingSigner();
    const out = await resolveAssetVideoSource(makeClip(), 0, sign);

    expect(out).toEqual({ origin: "signed", url: "https://signed.test/clients/c1/podcast-clips/1-clip.mp4?fresh" });
    expect(calls).toHaveLength(1);
    expect(calls[0].gcsPath).toBe("clients/c1/podcast-clips/1-clip.mp4");
    // The stored, probably-expired URL is not what came back.
    expect((out as any).url).not.toContain("X-Goog-Expires");
  });

  it("branch 3 — keeps the stored URL when there is no gcsPath to re-sign from", async () => {
    // Tomer's migration is mid-flight: webhook clips are re-hosted to Firebase
    // Storage and carry no bucket path. Those must not 500 and must not be
    // re-signed against an object that isn't theirs.
    const { sign, calls } = recordingSigner();
    const rehosted = makeAsset({ videoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/clip.mp4?alt=media" });

    expect(await resolveAssetVideoSource(rehosted, 0, sign)).toEqual({
      origin: "stored",
      url: rehosted.videoUrl,
    });
    expect(calls).toHaveLength(0);
  });

  it("branch 3 — keeps the stored URL for a clip gcsPath does not name", async () => {
    // gcsPath names exactly one object: the clip that landed in videoUrl.
    // Clips discovered in meta.videos are other files entirely.
    const { sign, calls } = recordingSigner();
    const extra = makeClip({
      meta: {
        bulkUpload: true,
        gcsPath: "clients/c1/podcast-clips/1-clip.mp4",
        videos: ["https://cdn.test/other.mp4"],
      },
    });
    // index 0 is asset.videoUrl (re-signed), index 1 is the meta.videos entry.
    expect(await resolveAssetVideoSource(extra, 1, sign)).toEqual({
      origin: "stored",
      url: "https://cdn.test/other.mp4",
    });
    expect(calls.map((c) => c.gcsPath)).toEqual([]);
  });

  it("branch 4 — degrades to the stored URL when the signer throws", async () => {
    // Bucket unset in an environment, IAM hiccup: a possibly-stale link still
    // beats a dead page, and it must not become a 500.
    const boom = async () => {
      throw new Error("GCS_MEDIA_BUCKET is not set");
    };
    expect(await resolveAssetVideoSource(makeClip(), 0, boom)).toEqual({
      origin: "stored",
      url: makeClip().videoUrl,
    });
  });

  it("asks for an attachment disposition only when a download filename is given", async () => {
    const dl = recordingSigner();
    await resolveAssetVideoSource(makeClip(), 0, dl.sign, { downloadFilename: "podcast-cut-3.mp4" });
    expect(dl.calls[0].opts).toEqual({ downloadFilename: "podcast-cut-3.mp4", contentType: "video/mp4" });

    // Playback must stay inline — no disposition.
    const play = recordingSigner();
    await resolveAssetVideoSource(makeClip(), 0, play.sign);
    expect(play.calls[0].opts).toEqual({ contentType: "video/mp4" });
  });

  it("only asserts a content type it can actually identify", () => {
    expect(videoMimeFromPath("clients/c1/podcast-clips/1-clip.mp4")).toBe("video/mp4");
    expect(videoMimeFromPath("clients/c1/podcast-clips/1-clip.MOV")).toBe("video/quicktime");
    expect(videoMimeFromPath("clients/c1/podcast-clips/reel.webm")).toBe("video/webm");
    // Unknown or absent extension → say nothing and let GCS serve the object's
    // own stored type, rather than guessing mp4 over it.
    expect(videoMimeFromPath("clients/c1/podcast-clips/clip.bin")).toBeNull();
    expect(videoMimeFromPath("clients/c1/podcast-clips/clip")).toBeNull();
  });
});

/* ═══ 2. the content-type split — denylist for photos, allowlist for clips ═ */

describe("photos use a denylist: only a positive error document is refused", () => {
  it("refuses the error documents a dead storage link returns", () => {
    // Measured against storage.googleapis.com: an invalid/expired V4 signature
    // answers 403 with `content-type: application/xml` and an <Error> body.
    expect(isErrorDocumentContentType("application/xml; charset=UTF-8")).toBe(true);
    expect(isErrorDocumentContentType("text/xml")).toBe(true);
    expect(isErrorDocumentContentType("text/html; charset=utf-8")).toBe(true);
    expect(isErrorDocumentContentType("application/json")).toBe(true);
    // Case and parameters are not a way past it.
    expect(isErrorDocumentContentType("TEXT/HTML")).toBe(true);
    expect(isErrorDocumentContentType("  application/xml  ")).toBe(true);
  });

  it("passes a missing Content-Type header — a missing header is not an error", () => {
    // This is the regression the allowlist would have caused: a 200 with no
    // Content-Type is an ordinary object on several of the hosts we read from,
    // and rejecting it would delete a working photo download.
    expect(isErrorDocumentContentType(null)).toBe(false);
    expect(isErrorDocumentContentType("")).toBe(false);
  });

  it("passes both spellings of octet-stream, including the legacy GCS default", () => {
    expect(isErrorDocumentContentType("application/octet-stream")).toBe(false);
    // `binary/octet-stream` is what the GCS XML API defaults older objects to.
    expect(isErrorDocumentContentType("binary/octet-stream")).toBe(false);
  });

  it("passes ordinary photos and anything else unrecognised", () => {
    expect(isErrorDocumentContentType("image/png")).toBe(false);
    expect(isErrorDocumentContentType("image/jpeg")).toBe(false);
    expect(isErrorDocumentContentType("image/avif")).toBe(false);
    expect(isErrorDocumentContentType("application/pdf")).toBe(false);
  });
});

describe("clips use an allowlist: the path with the measured evidence", () => {
  it("accepts real video and untyped bucket objects", () => {
    expect(isVideoContentType("video/mp4")).toBe(true);
    expect(isVideoContentType("video/quicktime")).toBe(true);
    expect(isVideoContentType("application/octet-stream")).toBe(true);
    expect(isVideoContentType("binary/octet-stream")).toBe(true);
  });

  it("refuses error documents, a photo, and a headerless response", () => {
    expect(isVideoContentType("application/xml; charset=UTF-8")).toBe(false);
    expect(isVideoContentType("text/html")).toBe(false);
    expect(isVideoContentType("image/png")).toBe(false);
    expect(isVideoContentType(null)).toBe(false);
    expect(isVideoContentType("")).toBe(false);
  });
});

/* ═══ 3. the routes, INVOKED ════════════════════════════════════════════ */

type FetchStub = (url: string) => Response;

function stubFetch(handler: FetchStub) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => handler(typeof input === "string" ? input : input.url)),
  );
}

/**
 * A 200 carrying bytes, optionally with no Content-Type header at all.
 *
 * The body must be a Uint8Array, not a string: `new Response("…")` auto-sets
 * `content-type: text/plain`, which would quietly turn every "headerless
 * upstream" case below into a typed one and stop it testing anything.
 */
function bytes(body: string, contentType?: string): Response {
  const res = new Response(new TextEncoder().encode(body), {
    status: 200,
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
  });
  if (!contentType) {
    expect(res.headers.get("content-type"), "this fixture must have no content type").toBeNull();
  }
  return res;
}

/** GCS's answer to an expired V4 signature. */
function gcsExpired(): Response {
  return new Response("<?xml version='1.0'?><Error><Code>ExpiredToken</Code></Error>", {
    status: 403,
    headers: { "content-type": "application/xml; charset=UTF-8" },
  });
}

const call = (handler: typeof downloadGET, url: string, id = "a1") =>
  handler(new Request(url), { params: Promise.resolve({ id }) });

describe("the download route", () => {
  beforeEach(() => {
    vi.mocked(gcs.createDownloadSignedUrl).mockClear();
    vi.mocked(gcs.createReadSignedUrl).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects a re-signable clip straight to GCS instead of proxying it", async () => {
    // A clip can be 2 GB. Proxied, the transfer sits under Cloud Run's
    // --timeout=300 and a slow client lands a truncated .mp4 — the same
    // "downloaded but won't open" symptom, only moved. Redirected, the bytes
    // never touch this server.
    vi.mocked(data.getAsset).mockResolvedValue(makeClip() as any);
    stubFetch(() => {
      throw new Error("the clip path must not fetch anything server-side");
    });

    const res = await call(downloadGET, "http://t/api/assets/a1/download?kind=video");

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("https://signed.test/clients/c1/podcast-clips/1-clip.mp4");
    // The filename and disposition ride inside the signature, because the
    // anchor's `download` attribute is ignored on a cross-origin redirect.
    expect(decodeURIComponent(location)).toContain('attachment; filename="podcast-cut-3.mp4"');
    expect(decodeURIComponent(location)).toContain("response-content-type=video/mp4");
    expect(vi.mocked(gcs.createDownloadSignedUrl)).toHaveBeenCalledTimes(1);
  });

  it("still serves a clip it cannot re-sign, by proxying it — never a 500", async () => {
    // The fallback the redirect must not break: no meta.gcsPath, so there is
    // no URL of ours to point the browser at.
    const rehosted = makeAsset({ videoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/clip.mp4?alt=media" });
    vi.mocked(data.getAsset).mockResolvedValue(rehosted as any);
    stubFetch(() => bytes("mp4-bytes", "video/mp4"));

    const res = await call(downloadGET, "http://t/api/assets/a1/download?kind=video");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="podcast-cut-3.mp4"');
    expect(await res.text()).toBe("mp4-bytes");
    expect(vi.mocked(gcs.createDownloadSignedUrl)).not.toHaveBeenCalled();
  });

  it("fails a proxied clip with the existing 502 shape when the bytes are an error document", async () => {
    const rehosted = makeAsset({ videoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/clip.mp4?alt=media" });
    vi.mocked(data.getAsset).mockResolvedValue(rehosted as any);
    stubFetch(() => gcsExpired());

    const res = await call(downloadGET, "http://t/api/assets/a1/download?kind=video");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not fetch video" });
  });

  it("serves the clip on a bare /download when the asset has no photos", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(makeClip() as any);
    stubFetch(() => bytes("never", "video/mp4"));

    const res = await call(downloadGET, "http://t/api/assets/a1/download");
    expect(res.status).toBe(302);
  });

  it("404s an asset with nothing to download", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(makeAsset() as any);
    stubFetch(() => bytes("never"));

    const res = await call(downloadGET, "http://t/api/assets/a1/download");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This asset has nothing to download" });
  });

  it("downloads a single photo that arrives with NO content-type header", async () => {
    // The regression an allowlist would have introduced: this asset downloads
    // fine today and must keep doing so.
    vi.mocked(data.getAsset).mockResolvedValue(makeAsset({ imageUrl: "https://cdn.test/a.jpg" }) as any);
    stubFetch(() => bytes("jpeg-bytes"));

    const res = await call(downloadGET, "http://t/api/assets/a1/download");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="podcast-cut-3.jpg"');
    expect(await res.text()).toBe("jpeg-bytes");
  });

  it("downloads a single photo served as legacy binary/octet-stream", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(makeAsset({ imageUrl: "https://cdn.test/a.png" }) as any);
    stubFetch(() => bytes("png-bytes", "binary/octet-stream"));

    const res = await call(downloadGET, "http://t/api/assets/a1/download");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes");
  });

  it("refuses to save a single photo when the bytes are an error document", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(makeAsset({ imageUrl: "https://cdn.test/a.jpg" }) as any);
    stubFetch(() => gcsExpired());

    const res = await call(downloadGET, "http://t/api/assets/a1/download");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not fetch image" });
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("zips every photo when they all arrive, headerless ones included", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(
      makeAsset({ meta: { images: ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg"] } }) as any,
    );
    // One typed, one with no Content-Type at all — both belong in the archive.
    stubFetch((url) => (url.endsWith("1.jpg") ? bytes("one", "image/jpeg") : bytes("two")));

    const res = await call(downloadGET, "http://t/api/assets/a1/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("X-Karos-Missing-Photos")).toBeNull();

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["podcast-cut-3-1.jpg", "podcast-cut-3-2.jpg"]);
  });

  it("names what it dropped rather than shipping a quietly short archive", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(
      makeAsset({
        meta: { images: ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg", "https://cdn.test/3.jpg"] },
      }) as any,
    );
    stubFetch((url) => (url.endsWith("2.jpg") ? gcsExpired() : bytes("ok", "image/jpeg")));

    const res = await call(downloadGET, "http://t/api/assets/a1/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Karos-Missing-Photos")).toBe("1");

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual([
      "MISSING-PHOTOS.txt",
      "podcast-cut-3-1.jpg",
      "podcast-cut-3-3.jpg",
    ]);

    const note = await zip.file("MISSING-PHOTOS.txt")!.async("string");
    expect(note).toContain("This archive is incomplete.");
    expect(note).toContain("1 of 3 photos");
    expect(note).toContain("podcast-cut-3-2.jpg");
  });

  it("502s rather than shipping an empty zip when no photo can be fetched", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(
      makeAsset({ meta: { images: ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg"] } }) as any,
    );
    stubFetch(() => gcsExpired());

    const res = await call(downloadGET, "http://t/api/assets/a1/download");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not fetch images" });
  });
});

describe("the playback route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("302s to a URL minted for this request, uncached and with no disposition", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(makeClip() as any);

    const res = await call(mediaGET, "http://t/api/assets/a1/media?i=0");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://signed.test/clients/c1/podcast-clips/1-clip.mp4?sig=read",
    );
    // Inline playback: an attachment disposition here would make <video> a
    // download instead of a player.
    expect(res.headers.get("Location")).not.toContain("disposition");
    // A cached redirect would hand a client an expired link all over again.
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("404s a clip index that does not exist", async () => {
    vi.mocked(data.getAsset).mockResolvedValue(makeAsset() as any);
    const res = await call(mediaGET, "http://t/api/assets/a1/media?i=0");
    expect(res.status).toBe(404);
  });
});

describe("authorization is identical on both media routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("401s a signed-out caller", async () => {
    const auth = await import("@/lib/auth");
    vi.mocked(auth.getCurrentUser).mockResolvedValueOnce(null as any);
    expect((await call(downloadGET, "http://t/api/assets/a1/download")).status).toBe(401);

    vi.mocked(auth.getCurrentUser).mockResolvedValueOnce(null as any);
    expect((await call(mediaGET, "http://t/api/assets/a1/media")).status).toBe(401);
  });

  it("403s a client reaching another client's asset", async () => {
    const auth = await import("@/lib/auth");
    vi.mocked(data.getAsset).mockResolvedValue(makeClip({ clientId: "other" }) as any);

    for (const handler of [downloadGET, mediaGET]) {
      vi.mocked(auth.getCurrentUser).mockResolvedValueOnce({
        id: "u2", role: "client", clientId: "c1", disabled: false,
      } as any);
      expect((await call(handler, "http://t/api/assets/a1/download")).status).toBe(403);
    }
  });

  it("withholds a future-dated post from a client, on both routes", async () => {
    const auth = await import("@/lib/auth");
    const tomorrow = Date.now() + 36 * 60 * 60 * 1000;
    vi.mocked(data.getAsset).mockResolvedValue(makeClip({ status: "draft", scheduledAt: tomorrow }) as any);

    for (const handler of [downloadGET, mediaGET]) {
      vi.mocked(auth.getCurrentUser).mockResolvedValueOnce({
        id: "u2", role: "client", clientId: "c1", disabled: false,
      } as any);
      const res = await call(handler, "http://t/api/assets/a1/download");
      expect(res.status).toBe(403);
      // Creation language, not lock language (§4.1 item 1) — this body reaches
      // a client.
      expect((await res.json()).error).toContain("created on its scheduled day");
    }
  });

  it("serves the same future-dated post to staff — the lock is client-only", async () => {
    const tomorrow = Date.now() + 36 * 60 * 60 * 1000;
    vi.mocked(data.getAsset).mockResolvedValue(makeClip({ status: "draft", scheduledAt: tomorrow }) as any);
    expect((await call(mediaGET, "http://t/api/assets/a1/media")).status).toBe(302);
  });
});

/* ═══ 4. the control exists for a clip, and each surface keeps its own gate ═ */

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

  it("answers WHAT is downloadable, never WHO may download it", () => {
    // The lock is not this helper's business: the two mount sites did not agree
    // about it before, and narrowing them to match would be drift. Each keeps
    // the gate it had, and the server keeps the one that counts.
    expect(assetDownloadTargets(makeClip({ locked: true }))).toHaveLength(1);
    expect(source(ASSET_IMAGES)).not.toContain("if (asset.locked) return [];");
  });

  it("keeps each surface's own locked handling exactly where it was", () => {
    // The modal refuses in the button component (belt and braces behind its own
    // locked-placeholder early return).
    expect(source(MODAL)).toContain("if (asset.locked) return null;");
    // The card never had a locked check on the download row — it replaces the
    // whole card with the upcoming-post placeholder first.
    expect(source(CARD)).toContain("if (asset.locked) {");
    // And the server refuses regardless of what either surface renders.
    expect(source(ASSET_MEDIA)).toContain("isAssetUnlockedForClient(asset, Date.now())");
  });

  it("is mounted from the shared helper at both sites, not re-gated on photos", () => {
    for (const rel of [CARD, MODAL]) {
      const src = source(rel);
      expect(src).toContain("assetDownloadTargets(asset)");
    }
    const modal = source(MODAL);
    expect(modal).not.toContain("if (images.length === 0) return null;");
    // The section WRAPPING the buttons was a third gate on photos — a clip
    // reached a modal that mounted no Download section at all.
    expect(modal).toContain("{downloads.length > 0 && (");
    expect(modal).not.toContain("{images.length > 0 && (");
  });
});

/* ═══ 5. wiring that cannot be executed from here ═══════════════════════ */

describe("the wiring the executed tests rest on", () => {
  it("still stores the durable identifier the whole fix depends on", () => {
    // The premise. If the upload ever stops writing meta.gcsPath, the read
    // path has nothing to re-sign from and the 7-day expiry is back.
    const upload = source(BULK_UPLOAD);
    expect(upload).toContain("gcsPath: opts.gcsPath");
    expect(upload).toContain("const videoUrl = await createReadSignedUrl(opts.gcsPath)");
    expect(source("src/lib/gcs-media.ts")).toContain(
      "export const READ_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000",
    );
  });

  it("writes nothing back — re-signing is request-time only", () => {
    // The campaign's hard constraint: dev credentials point at production.
    expect(source(ASSET_MEDIA)).not.toMatch(/updateAsset|createAsset|\.set\(|\.update\(/);
  });

  it("points every <video> at our route rather than at a stored URL", () => {
    expect(assetVideoSrc("a1", 0)).toBe("/api/assets/a1/media?i=0");
    expect(assetVideoSrc("a1", 2)).toBe("/api/assets/a1/media?i=2");

    for (const rel of [CARD, MODAL]) {
      const src = source(rel);
      expect(src, `${rel} still renders a stored URL into <video>`).not.toContain("src={v.url}");
      expect(src).toContain("src={assetVideoSrc(asset.id, i)}");
    }
  });

  it("keeps assetVideos pure and client-safe", () => {
    // It runs in the browser on every card; a server import here would break
    // every render site at once.
    const images = source(ASSET_IMAGES);
    expect(images).not.toMatch(/^import "server-only";/m);
    expect(images).not.toContain("gcs-media");
    expect(assetVideos(makeClip()).map((v) => v.url)).toEqual([makeClip().videoUrl]);
  });

  it("keeps the video-source decision free of server-only imports too", () => {
    const src = source("src/lib/asset-video-source.ts");
    expect(src).not.toMatch(/^import "server-only";/m);
    expect(src).not.toContain("gcs-media");
  });

  it("asserts no request-duration ceiling it does not control", () => {
    // `maxDuration` is a Vercel convention and is inert here: this repo deploys
    // via Cloud Build to Cloud Run, where the ceiling is --timeout=300 in
    // cloudbuild.yaml. A number in the route file would just be a claim.
    const route = source(DOWNLOAD_ROUTE);
    expect(route).not.toMatch(/export const maxDuration/);
    // It is named only to explain why it is not being set.
    expect(route).toContain("cloudbuild.yaml");
    expect(source("cloudbuild.yaml")).toContain("--timeout=300");
  });

  it("does not zip clips — JSZip buffers whole files and a clip can be 2 GB", () => {
    const route = source(DOWNLOAD_ROUTE);
    const clipBranch = route.slice(route.indexOf('query.get("kind")'), route.indexOf("// Single photo"));
    expect(clipBranch).not.toContain("JSZip");
    expect(clipBranch).not.toContain("zip.file");
  });
});

/* ── added on review of the bounce round ─────────────────────────────────── */

describe("an out-of-range clip index answers 404, not 500", () => {
  // `?i=` is user input. The bounce built the download filename from
  // videos[index].url BEFORE the guard that proves the clip exists, so
  // ?kind=video&i=99 raised a TypeError and answered 500 while the route's own
  // 404 sat below it, unreachable.
  const route = source("src/app/api/assets/[id]/download/route.ts");

  it("binds the index to a real clip before naming the file", () => {
    const clipGuard = route.indexOf("const clip = videos[index]");
    const notFound = route.indexOf('"This asset has no video"');
    const naming = route.indexOf("const filename = ");
    expect(clipGuard).toBeGreaterThan(-1);
    expect(notFound).toBeGreaterThan(clipGuard);
    expect(naming).toBeGreaterThan(notFound);
  });

  it("never dereferences videos[index] before that guard", () => {
    const beforeGuard = route.slice(0, route.indexOf("const clip = videos[index]"));
    expect(beforeGuard).not.toContain("videos[index].url");
  });
});
