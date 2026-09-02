/**
 * WHICH FILES THE MEDIA UPLOAD ACCEPTS — the allowlists, the size ceilings, and
 * the three pure helpers over them.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────
 *
 * These lived in `lib/gcs-media.ts` until 2026-09, which is where they belong
 * by subject and where they CANNOT live by dependency: that module opens with
 * `import "server-only"` and constructs a `@google-cloud/storage` client, and
 * the dropzone that has to offer the right `accept` string and refuse an
 * oversized file BEFORE uploading is a `"use client"` component. Importing it
 * from there is a build error ("Ecmascript file had an error", the whole client
 * bundle refusing), which is how this split was found rather than predicted.
 *
 * The alternative was re-typing the accept list and the caps in the component.
 * That is the "control that lies" failure `run-attachments.tsx` names: a picker
 * offering a type the sign step then 400s on. One home, imported by both sides.
 *
 * PURE. No I/O, no environment, no `Date.now()` — `gcs-media` re-exports every
 * symbol here so existing server callers are unaffected.
 */

import type { AssetType } from "@/lib/types";

export const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
export const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov"];
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * IMAGES TOO (2026-09).
 *
 * The dropzone this feeds was a podcast-clip uploader: video only, one control
 * called "Bulk upload clips". The product owner asked for a general media
 * upload so a client's images and videos go in through the same door, so the
 * allowlists gain an image half and the size cap becomes per-kind.
 *
 * The SET is deliberately the same three formats `RunAttachments` offers and
 * `/api/agent-engine/run-media` enforces — jpeg, png, webp. Two upload paths in
 * this product accepting different image formats would mean a file the chat
 * takes and the library refuses, and there is no reason for that difference.
 * (The two paths still write to different prefixes and mint different records;
 * this is about which FORMATS are legal, nothing else.)
 *
 * `avif`/`gif` are out for now: nothing downstream (the calendar tile, the
 * detail modal, the publish integrations) has been checked against either, and
 * accepting a format the publisher will reject is the "control that lies"
 * failure the modes table in run-attachments.tsx names.
 */
export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
/**
 * 25 MB. Not the video cap: an image that large is a mistake (a RAW export, a
 * PDF renamed), and the 2 GB ceiling exists for hour-long podcast masters.
 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Everything the media dropzone accepts, in the order the picker offers it. */
export const ALLOWED_MEDIA_MIME_TYPES = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_VIDEO_MIME_TYPES,
];
export const ALLOWED_MEDIA_EXTENSIONS = [
  ...ALLOWED_IMAGE_EXTENSIONS,
  ...ALLOWED_VIDEO_EXTENSIONS,
];

/** Which half of the allowlist a content type belongs to, or null if neither. */
export type MediaKind = "image" | "video";

/**
 * Classify an upload by its declared content type, then by its filename.
 *
 * BOTH, and in that order, because the two arrive from different places and
 * neither is always present. A browser gives `File.type` for these formats, but
 * an object dropped into the bucket by `gcloud storage cp` can carry
 * `application/octet-stream` or nothing at all — that is the "import-bucket"
 * path, and it is why the extension fallback exists rather than being defensive
 * padding. Returns null rather than guessing "video", which is what the old
 * unconditional `mimeType: opts.contentType || "video/mp4"` did.
 */
export function mediaKindFor(contentType?: string, filename?: string): MediaKind | null {
  if (contentType) {
    if (ALLOWED_IMAGE_MIME_TYPES.includes(contentType)) return "image";
    if (ALLOWED_VIDEO_MIME_TYPES.includes(contentType)) return "video";
  }
  const lower = (filename ?? "").toLowerCase();
  if (ALLOWED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "image";
  if (ALLOWED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "video";
  return null;
}

/** The size ceiling for one kind — see MAX_IMAGE_BYTES for why they differ. */
export function maxBytesFor(kind: MediaKind): number {
  return kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
}

/** Extension → the content type this product stores for it. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/**
 * The content type to STORE for a file, given whatever the caller knows.
 *
 * A declared type always wins. When there is none, the EXTENSION decides, and
 * only when that is unrecognised too does the kind's own default apply.
 *
 * That middle rung is the one worth having, and a test is what put it here: the
 * first version of this went straight from "no declared type" to a per-kind
 * default, so a `.webp` dropped into the bucket by `gcloud storage cp` (no
 * content type at all) was stored as `image/jpeg` — the right KIND and the wrong
 * TYPE, on a field the download route hands to the browser as
 * `response-content-type`. A picture that downloads claiming to be a JPEG is a
 * small lie with a real failure at the end of it.
 */
export function mediaMimeFor(contentType?: string, filename?: string): string {
  if (contentType) return contentType;
  const lower = (filename ?? "").toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
    if (lower.endsWith(ext)) return mime;
  }
  // Nothing identifies it. `mediaKindFor` returns null for this case, and the
  // callers' own `?? "video"` fallback is what decides it is a clip — so the
  // type has to agree with that, not invent a third answer.
  return mediaKindFor(contentType, filename) === "image" ? "image/jpeg" : "video/mp4";
}

/**
 * The asset TYPE and default channel one uploaded file is registered as.
 *
 * ── WHY AN IMAGE IS `instagram_post`, NOT `social_post` ──────────────────
 *
 * Because the two fields are not independent. `PUBLISHABLE_PLATFORMS`
 * (lib/integrations/platforms) maps asset TYPE to the platforms that type can
 * be pushed to, and `social_post` is `["twitter", "linkedin", "facebook",
 * "tiktok"]` — instagram is NOT in it; it appears only under `instagram_post`.
 * The first version of image upload registered `social_post` with
 * `channels: ["instagram"]`, and every consumer of that map then disagreed with
 * the asset about itself:
 *
 *  • `preferredPlatform` (asset-actions) intersects channels with the
 *    compatible list, so it returned undefined — the asset had no target.
 *  • the asset card, the detail modal and the approve panel all compute
 *    `PUBLISHABLE_PLATFORMS[type] ∩ connected`, so "Publish now" could never
 *    render while the approve panel's manual-push tier still named it. That is
 *    QA F107 exactly, re-created.
 *  • `bulkScheduleClipsAction` would still stamp `scheduledPlatform:
 *    "instagram"`, which an explicit schedule makes win over the compatibility
 *    check — a booking to a platform the type says it cannot reach.
 *
 * `instagram_post` is the one type whose platform list contains instagram, and
 * `chainFamilyFor` puts it in the same "social" family as `social_post`, so the
 * scheduler's pace ledger and chain behaviour are unchanged.
 *
 * Video keeps exactly what every clip in production carries.
 *
 * ── WHY IT LIVES HERE RATHER THAN IN THE ROUTE ───────────────────────────
 *
 * `type:` on a `createAsset` call is fenced: platforms-publishable.test.ts
 * scans every writer and requires any RUNTIME-derived type to be pinned against
 * the Reddit draft-only rule, because the type is what decides whether the
 * product offers to publish. `REGISTRATION[kind].type` inside the route was
 * such a derivation and the guard (correctly) refused it. Exported from a pure
 * module, the table can be called by that suite and pinned exhaustively over
 * `MediaKind` — which is the honest way to satisfy the fence, rather than
 * hiding the lookup behind a ternary the same scan would also flag.
 *
 * The range is closed by construction: two entries, both source literals, over
 * a two-member union. No input to this product can steer it to a third type.
 *
 * A DEFAULT, not a decision: `channels` is editable per asset afterwards, and
 * the scheduler reads whatever the asset ends up carrying. What this table must
 * not do is register a file against a platform its own type rejects.
 */
export const MEDIA_REGISTRATION: Readonly<
  Record<MediaKind, { readonly type: AssetType; readonly channel: string }>
> = {
  image: { type: "instagram_post", channel: "instagram" },
  video: { type: "social_post", channel: "tiktok" },
};
