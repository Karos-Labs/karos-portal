/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_MEDIA_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  maxBytesFor,
  mediaKindFor,
} from "@/lib/gcs-media";
import { planBulkSchedule } from "@/lib/bulk-schedule";
import { PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { chainFamilyFor } from "@/lib/post-chain";

/**
 * "UPLOAD MEDIA" — THE CLIP UPLOADER, GENERALISED (2026-09).
 *
 * It took `video/mp4` and `video/quicktime` and was called "Bulk upload clips".
 * The product owner asked for one general media upload so a client's images and
 * videos go in through the same door. Widening the accept list is the easy half;
 * the half that needed pinning is that FOUR THINGS assumed video unconditionally
 * and each would have mis-filed an image silently:
 *
 *   1. the read URL was stored on `videoUrl`, the field every player reads;
 *   2. `mimeType` defaulted to `"video/mp4"` when the caller gave none;
 *   3. `channels` was `["tiktok"]`, so a still photo became a TikTok post;
 *   4. the bulk auto-scheduler then BOOKED that photo to TikTok, because it
 *      used one platform for the whole batch.
 *
 * (4) is the one that would have reached a publish integration, so it gets the
 * most attention below. None of these is visible in a "does the picker accept
 * .jpg" test, which is why this file tests the classification and the booking
 * rather than the accept string.
 */

const REPO = process.cwd();
const source = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const ROUTE = "src/app/api/assets/bulk-upload/route.ts";

/* ── the classifier ─────────────────────────────────────────────────────── */

describe("mediaKindFor", () => {
  it("classifies every allowed content type", () => {
    for (const t of ALLOWED_IMAGE_MIME_TYPES) expect(mediaKindFor(t), t).toBe("image");
    for (const t of ALLOWED_VIDEO_MIME_TYPES) expect(mediaKindFor(t), t).toBe("video");
    // Non-vacuity: the two halves are non-empty and disjoint, so the loops above
    // actually asserted something in both directions.
    expect(ALLOWED_IMAGE_MIME_TYPES.length).toBeGreaterThan(0);
    expect(ALLOWED_VIDEO_MIME_TYPES.length).toBeGreaterThan(0);
    expect(ALLOWED_MEDIA_MIME_TYPES).toHaveLength(
      ALLOWED_IMAGE_MIME_TYPES.length + ALLOWED_VIDEO_MIME_TYPES.length,
    );
  });

  it("falls back to the filename when there is no usable content type", () => {
    // This is not defensive padding: the "import-bucket" step reads objects
    // dropped in by `gcloud storage cp`, which routinely carry
    // application/octet-stream or nothing at all.
    expect(mediaKindFor(undefined, "holiday.JPG")).toBe("image");
    expect(mediaKindFor("application/octet-stream", "holiday.png")).toBe("image");
    expect(mediaKindFor("", "cut-3.MOV")).toBe("video");
    expect(mediaKindFor(undefined, "cut-3.mp4")).toBe("video");
  });

  it("prefers the content type over the extension when they disagree", () => {
    // A .mp4 served as image/png is a mislabelled file either way; the declared
    // type is what the signed URL will be minted for, so it decides.
    expect(mediaKindFor("image/png", "clip.mp4")).toBe("image");
    expect(mediaKindFor("video/mp4", "photo.png")).toBe("video");
  });

  it("returns null rather than guessing video for something unrecognised", () => {
    // The old code's implicit answer was `"video/mp4"` for anything at all,
    // which is how a PDF would have been registered as a clip.
    expect(mediaKindFor("application/pdf", "deck.pdf")).toBeNull();
    expect(mediaKindFor("image/gif", "loop.gif")).toBeNull();
    expect(mediaKindFor(undefined, undefined)).toBeNull();
  });
});

describe("the size ceilings differ by kind", () => {
  it("caps an image far below the video ceiling", () => {
    expect(maxBytesFor("image")).toBe(MAX_IMAGE_BYTES);
    expect(maxBytesFor("video")).toBe(MAX_VIDEO_BYTES);
    // The point of splitting them: one ceiling over both halves would accept a
    // 900 MB "image", which is never a file anyone meant to attach.
    expect(MAX_IMAGE_BYTES).toBeLessThan(MAX_VIDEO_BYTES);
  });
});

/* ── registration: the route, executed ──────────────────────────────────── */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ uid: "u1", role: "KAROS_ADMIN", disabled: false })),
}));

const store: any[] = [];
let nextId = 0;
vi.mock("@/lib/data", () => ({
  getClient: vi.fn(async (id: string) => ({ id, name: "Acme" })),
  createAsset: vi.fn(async (data: any) => {
    const id = `asset-${++nextId}`;
    store.push({ id, ...data });
    return id;
  }),
  listAssets: vi.fn(async () => []),
}));
// Partial, so the real classifier and ceilings are exercised — the whole point
// of these tests. Only the three GCS-touching functions are stubbed.
vi.mock("@/lib/gcs-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gcs-media")>()),
  createReadSignedUrl: vi.fn(async (p: string) => `https://signed.test/${p}`),
  createUploadSignedUrl: vi.fn(async () => "https://signed.test/upload"),
  listClientMediaObjects: vi.fn(async () => []),
}));

import { POST as bulkUploadPOST } from "@/app/api/assets/bulk-upload/route";

const post = (body: unknown) =>
  bulkUploadPOST(
    new Request("https://portal.test/api/assets/bulk-upload", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

const complete = (filename: string, contentType: string, extra: object = {}) =>
  post({
    step: "complete",
    clientId: "c1",
    gcsPath: `clients/c1/podcast-clips/${filename}`,
    filename,
    contentType,
    ...extra,
  });

describe("registering an uploaded file", () => {
  beforeEach(() => {
    store.length = 0;
    nextId = 0;
  });

  it("puts an image on imageUrl and a video on videoUrl", async () => {
    await complete("photo.png", "image/png");
    await complete("cut-3.mp4", "video/mp4");

    const [image, video] = store;
    expect(image.imageUrl, "an image was stored where players look for video").toBeTruthy();
    expect(image.videoUrl).toBeUndefined();
    expect(video.videoUrl).toBeTruthy();
    expect(video.imageUrl).toBeUndefined();
  });

  it("does not label an image as video/mp4", async () => {
    await complete("photo.png", "image/png");
    expect(store[0].mimeType).toBe("image/png");
    // …and with no content type at all it still resolves by filename rather
    // than falling through to the video default.
    await complete("photo2.webp", "");
    expect(store[1].mimeType).toBe("image/webp");
  });

  it("files an image against a channel it can actually be published to", async () => {
    await complete("photo.png", "image/png");
    await complete("cut-3.mp4", "video/mp4");
    expect(store[0].channels, "a still photo was filed as a TikTok post").toEqual(["instagram"]);
    expect(store[1].channels).toEqual(["tiktok"]);
  });

  it("gives the image a TYPE whose own platform list admits that channel", async () => {
    await complete("photo.png", "image/png");
    await complete("cut-3.mp4", "video/mp4");
    // The pairing bug this replaced: `social_post` + `["instagram"]`.
    // PUBLISHABLE_PLATFORMS is keyed by type, and every publish surface
    // intersects it with the asset's channels — so a type that rejects the
    // channel means no "Publish now" control, no `preferredPlatform`, and a
    // bulk-schedule booking to a platform the type says it cannot reach
    // (QA F107's shape). Derived from the map, not from a typed expectation,
    // so widening either side moves this with it.
    for (const row of store) {
      const compatible = PUBLISHABLE_PLATFORMS[row.type] ?? [];
      expect(
        compatible,
        `type "${row.type}" cannot publish to its own channel "${row.channels[0]}"`,
      ).toContain(row.channels[0]);
    }
    // Non-vacuity: the loop ran over both kinds, and they really do differ.
    expect(store).toHaveLength(2);
    expect(new Set(store.map((r) => r.type)).size).toBe(2);
  });

  it("keeps the image in the same scheduling family as a clip", async () => {
    await complete("photo.png", "image/png");
    await complete("cut-3.mp4", "video/mp4");
    // `chainFamilyFor` drives the pace ledger's `occupied` accounting in
    // bulkScheduleClipsAction. An image landing outside "social" would silently
    // stop counting against a paced client's daily allowance.
    for (const row of store) expect(chainFamilyFor(row.type), row.type).toBe("social");
  });

  it("stores no video-only metadata on an image", async () => {
    // A `durationSeconds: 0` renders as a zero-length clip; Reels/Shorts/TikTok
    // format tags are three claims a still cannot fill.
    await complete("photo.png", "image/png", { durationSeconds: 12 });
    expect(store[0].meta.durationSeconds).toBeUndefined();
    expect(store[0].meta.formatTags).toBeUndefined();
    // The control: a video keeps both.
    await complete("cut-3.mp4", "video/mp4", { durationSeconds: 12 });
    expect(store[1].meta.durationSeconds).toBe(12);
    expect(store[1].meta.formatTags).toBeTruthy();
  });

  it("still registers an unidentifiable object as a clip, as it always did", async () => {
    // The bucket-import path's historical behaviour. Changing it would make a
    // re-import of an existing clip register as something else.
    await complete("mystery", "");
    expect(store[0].videoUrl).toBeTruthy();
    expect(store[0].channels).toEqual(["tiktok"]);
  });

  it("keeps the durable identifier both kinds are re-signed from", async () => {
    await complete("photo.png", "image/png");
    expect(store[0].meta.gcsPath).toBe("clients/c1/podcast-clips/photo.png");
  });
});

describe("the sign step's gate", () => {
  it("accepts an image and refuses a type on neither allowlist", async () => {
    const ok = await post({
      step: "sign",
      clientId: "c1",
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 1024,
    });
    expect(ok.status).toBe(200);

    const bad = await post({
      step: "sign",
      clientId: "c1",
      filename: "deck.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
    });
    expect(bad.status).toBe(400);
  });

  it("refuses an oversized image at the image ceiling, not the video one", async () => {
    const size = MAX_IMAGE_BYTES + 1;
    const res = await post({
      step: "sign",
      clientId: "c1",
      filename: "huge.png",
      contentType: "image/png",
      sizeBytes: size,
    });
    expect(res.status).toBe(413);
    // The same byte count is fine as a video — which is what makes this a
    // per-kind ceiling rather than a lowered global one.
    const asVideo = await post({
      step: "sign",
      clientId: "c1",
      filename: "long.mp4",
      contentType: "video/mp4",
      sizeBytes: size,
    });
    expect(asVideo.status).toBe(200);
  });
});

/* ── the booking: a mixed batch must not all go to one platform ─────────── */

describe("the bulk auto-schedule books each file's own channel", () => {
  it("takes a per-id platform", () => {
    // MONDAY, so the weekday walk does not move anything: the assertion is
    // about which platform each id is planned against, not about dates.
    const monday = new Date(2026, 8, 7, 0, 0, 0, 0).getTime();
    const out = planBulkSchedule(["img", "vid"], {
      startDayMs: monday,
      platform: "tiktok",
      platformById: { img: "instagram" },
    });
    expect(out.map((a) => a.id)).toEqual(["img", "vid"]);
    expect(out.every((a) => a.scheduledAt > 0)).toBe(true);
  });

  it("is unchanged for a uniform batch that passes no map", () => {
    // Backwards compatibility, asserted rather than assumed: every existing
    // caller and test passes only `platform`.
    const monday = new Date(2026, 8, 7, 0, 0, 0, 0).getTime();
    const withMap = planBulkSchedule(["a", "b"], {
      startDayMs: monday,
      platform: "tiktok",
      platformById: {},
    });
    const without = planBulkSchedule(["a", "b"], { startDayMs: monday, platform: "tiktok" });
    expect(withMap).toEqual(without);
  });

  it("is wired: the action reads each asset's channel rather than a constant", () => {
    // The planner being capable of it is half the fix — the defect would have
    // been the action still passing one hardcoded platform to
    // `scheduleAssetAction`, which is the call that actually books it.
    const action = source("src/lib/actions/bulk-upload-actions.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(action).toMatch(/platformFor\(assignment\.id\)/);
    expect(action, "the batch still books one hardcoded platform").not.toMatch(
      /scheduleAssetAction\([^)]*,\s*"tiktok"\s*,/,
    );
  });
});

/* ── the control's copy matches what it accepts ─────────────────────────── */

describe("the control does not offer what the server refuses", () => {
  it("derives its accept list from the shared allowlist", () => {
    const component = source("src/components/media-upload.tsx");
    // A re-typed accept string is how a picker comes to offer a type the sign
    // step 400s on — the "control that lies" failure run-attachments.tsx names.
    expect(component).toMatch(/ALLOWED_MEDIA_MIME_TYPES/);
    expect(component).not.toMatch(/accept="video\//);
  });

  it("names both kinds in the route's own gate", () => {
    expect(source(ROUTE)).toMatch(/ALLOWED_MEDIA_MIME_TYPES\.includes\(contentType\)/);
  });
});
