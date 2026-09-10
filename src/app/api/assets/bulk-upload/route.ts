import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { canViewClient } from "@/lib/client-visibility";
import { getClient, createAsset, listAssets } from "@/lib/data";
import {
  ALLOWED_MEDIA_MIME_TYPES,
  createReadSignedUrl,
  createUploadSignedUrl,
  listClientMediaObjects,
  maxBytesFor,
  mediaKindFor,
  mediaMimeFor,
  mediaObjectPath,
} from "@/lib/gcs-media";
// The type/channel pairing lives in the pure module so platforms-publishable's
// asset-type fence can call it — see MEDIA_REGISTRATION's own note.
import { MEDIA_REGISTRATION } from "@/lib/media-kinds";
import { detectFormatTags } from "@/lib/bulk-schedule";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import type { ManagedTaskType } from "@/lib/types";

export const maxDuration = 60;

const MANAGED_TASK_TYPES = new Set<string>(MANAGED_PRODUCTS.map((p) => p.taskType));

function humanizeFilename(filename: string): string {
  const base = filename.replace(/\.[^./]+$/, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : filename;
}

interface SignBody {
  step: "sign";
  clientId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface CompleteBody {
  step: "complete";
  clientId: string;
  gcsPath: string;
  filename: string;
  contentType: string;
  taskType?: string;
  durationSeconds?: number;
}

interface ImportBucketBody {
  step: "import-bucket";
  clientId: string;
  taskType?: string;
}

type Body = SignBody | CompleteBody | ImportBucketBody;

/**
 * Register one uploaded object as a draft asset.
 *
 * ── IMAGES AND VIDEOS, since 2026-09 ────────────────────────────────────
 *
 * This was `registerClip` and it assumed video in three places, each of which
 * would have quietly mis-filed an image: it stored the read URL on `videoUrl`,
 * it defaulted `mimeType` to `"video/mp4"` when the caller gave none, and it
 * booked `channels: ["tiktok"]`. An image registered through the old body would
 * have been a TikTok post with a video mime type and its picture in the field
 * players read — three wrong answers from one unconditional assumption.
 *
 * The kind is resolved ONCE, here, through `mediaKindFor` (content type first,
 * filename second — the bucket-import path routinely has no usable content
 * type), and everything below branches off that single answer rather than
 * re-deriving it.
 *
 * The TYPE now differs by kind too, and it has to — see `MEDIA_REGISTRATION`
 * (lib/media-kinds) for why an image cannot be a `social_post` while carrying
 * an instagram channel, and for why that table is exported rather than local.
 */
async function registerMedia(opts: {
  clientId: string;
  gcsPath: string;
  filename: string;
  contentType?: string;
  taskType?: string;
  durationSeconds?: number;
  createdBy: string;
}): Promise<string> {
  const taskType: ManagedTaskType =
    opts.taskType && MANAGED_TASK_TYPES.has(opts.taskType) ? (opts.taskType as ManagedTaskType) : "social_post";
  // Falls back to video only when NOTHING identifies the file — the historical
  // behaviour for an object with no content type and an unrecognised name,
  // preserved so a re-import of an existing clip keeps registering as one.
  const kind = mediaKindFor(opts.contentType, opts.filename) ?? "video";
  const readUrl = await createReadSignedUrl(opts.gcsPath);
  return createAsset({
    clientId: opts.clientId,
    agentId: null,
    type: MEDIA_REGISTRATION[kind].type,
    title: humanizeFilename(opts.filename),
    content: "",
    meta: {
      bulkUpload: true,
      gcsPath: opts.gcsPath,
      sourceFilename: opts.filename,
      taskType,
      // A still has no duration, and a stored `durationSeconds: 0` would render
      // as a zero-length clip on every surface that prints one.
      ...(kind === "video" && typeof opts.durationSeconds === "number"
        ? { durationSeconds: opts.durationSeconds }
        : {}),
      // Reels/Shorts/TikTok are video format tags. On an image they would be
      // three claims about a file that cannot fill any of them.
      ...(kind === "video" ? { formatTags: detectFormatTags(opts.filename) } : {}),
    },
    ...(kind === "image" ? { imageUrl: readUrl } : { videoUrl: readUrl }),
    // `mediaMimeFor`, not a per-kind default: a `.webp` with no declared
    // content type (the bucket-import path) resolves by extension rather than
    // being stored as image/jpeg. See that function for why it matters.
    mimeType: mediaMimeFor(opts.contentType, opts.filename),
    channels: [MEDIA_REGISTRATION[kind].channel],
    status: "draft",
    createdBy: opts.createdBy,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/**
 * Every GCS object this client already has an asset registered for, mapped to
 * that asset's id.
 *
 * One read serves both write paths, which is the point: "import-bucket" used
 * this idea inline to skip objects it had already imported, while "complete"
 * registered unconditionally — so a replayed completion (flaky network, a
 * double click, a resumed upload) minted a SECOND asset for the same object,
 * same `meta.gcsPath`, different id. Those documents are still in production
 * and are what the calendar renders twice.
 *
 * `listAssets` is a full per-client scan and there is no narrower lookup in
 * lib/data.ts — no query by `meta.gcsPath` exists, and adding one needs a
 * Firestore composite index. At bulk-upload volumes (a staff dropzone, tens of
 * clips) correctness is worth the scan; this is the same read import-bucket
 * has always done.
 *
 * `listAssets` returns newest-first, so keeping the first id seen would hand
 * back the newest copy. It keeps the OLDEST instead — the original — matching
 * the survivor rule in lib/calendar-dedupe so the id a replay is told about is
 * the same copy the calendar shows.
 */
async function registeredMediaIds(clientId: string): Promise<Map<string, string>> {
  const existing = await listAssets({ clientId });
  const byPath = new Map<string, string>();
  for (const a of [...existing].sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0))) {
    const path = a.meta?.gcsPath;
    if (typeof path === "string" && path && !byPath.has(path)) byPath.set(path, a.id);
  }
  return byPath;
}

/**
 * Two-step direct-to-GCS bulk media upload for staff (see the "Bulk Upload
 * Assets" dropzone, src/components/media-upload.tsx):
 *   step "sign"     — returns a V4 signed PUT URL; the browser then uploads
 *                     the file bytes straight to GCS, never through this
 *                     server (keeps large video out of Node's memory).
 *   step "complete" — called once the browser's direct PUT succeeds; mints a
 *                     signed READ url and registers the clip as a draft Asset.
 *                     Idempotent on the object path: replaying it returns the
 *                     asset already registered for that path.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || (body.step !== "sign" && body.step !== "complete" && body.step !== "import-bucket")) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // The role check above says this actor is staff, not WHICH clients they may
  // write to — and every branch below writes into the client named in the body
  // (a signed upload URL into their media bucket, or an asset on their library).
  // Refuses in the shape a missing client already used, so an out-of-scope
  // client is indistinguishable from one that does not exist.
  const client = await getClient(body.clientId);
  if (!client || !canViewClient(user, client)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  if (body.step === "sign") {
    const { filename, contentType, sizeBytes } = body;
    if (!filename || !contentType) {
      return NextResponse.json({ error: "filename and contentType are required" }, { status: 400 });
    }
    if (!ALLOWED_MEDIA_MIME_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Unsupported file type: ${contentType}` }, { status: 400 });
    }
    if (typeof sizeBytes !== "number" || sizeBytes <= 0) {
      return NextResponse.json({ error: "sizeBytes is required" }, { status: 400 });
    }
    // PER KIND (2026-09). One 2 GB ceiling over both halves would accept a
    // 900 MB "image", which is never a file anyone meant to attach. The type is
    // already known to be on the allowlist by the check above, so the content
    // type alone answers the kind here.
    const kind = mediaKindFor(contentType, filename);
    const maxBytes = maxBytesFor(kind ?? "video");
    if (sizeBytes > maxBytes) {
      return NextResponse.json(
        {
          error:
            kind === "image"
              ? `Image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`
              : `File is larger than ${Math.round(maxBytes / (1024 * 1024 * 1024))} GB`,
        },
        { status: 413 },
      );
    }

    const gcsPath = mediaObjectPath(body.clientId, filename);
    const uploadUrl = await createUploadSignedUrl({ gcsPath, contentType });
    return NextResponse.json({ gcsPath, uploadUrl });
  }

  if (body.step === "complete") {
    const { gcsPath, filename, contentType, durationSeconds, taskType } = body;
    if (!gcsPath || !filename) {
      return NextResponse.json({ error: "gcsPath and filename are required" }, { status: 400 });
    }
    if (!gcsPath.startsWith(`clients/${body.clientId}/podcast-clips/`)) {
      return NextResponse.json({ error: "gcsPath does not match this client" }, { status: 400 });
    }
    // Idempotent on the object path: a replay of this step returns the asset
    // that already exists for it rather than minting a second one. The caller
    // cannot tell a replay from the original success — same shape, same id.
    //
    // RESIDUAL RACE, stated rather than implied away: this is a read then a
    // write, not a transaction, so two completions genuinely in flight at the
    // same instant can both read "nothing registered" and both create. Closing
    // it needs either a transaction or a deterministic document id derived from
    // the object path, and the narrow lookup a transaction would want does not
    // exist — a query by `meta.gcsPath` needs a Firestore composite index, which
    // this branch cannot add. What this DOES close is the sequential replay: the
    // double click, the retry after a timeout, the resumed upload — which is the
    // shape that actually wrote the duplicate documents now sitting in
    // production.
    const already = (await registeredMediaIds(body.clientId)).get(gcsPath);
    if (already) return NextResponse.json({ id: already });

    const id = await registerMedia({
      clientId: body.clientId,
      gcsPath,
      filename,
      contentType,
      taskType,
      durationSeconds,
      createdBy: user.uid,
    });
    return NextResponse.json({ id });
  }

  // step === "import-bucket" — pick up clips a staff member dropped straight
  // into the bucket (gcloud storage cp, Cloud Console, rclone, …) without
  // going through this route's "sign"/"complete" steps at all.
  const objects = await listClientMediaObjects(body.clientId);
  const registeredPaths = await registeredMediaIds(body.clientId);
  const unregistered = objects.filter((o) => !registeredPaths.has(o.gcsPath));

  const imported: string[] = [];
  for (const obj of unregistered) {
    await registerMedia({
      clientId: body.clientId,
      gcsPath: obj.gcsPath,
      filename: obj.filename,
      contentType: obj.contentType,
      taskType: body.taskType,
      createdBy: user.uid,
    });
    imported.push(obj.filename);
  }

  return NextResponse.json({ imported: imported.length, skipped: objects.length - unregistered.length, filenames: imported });
}
