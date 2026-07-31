import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getClient, createAsset, listAssets } from "@/lib/data";
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_BYTES,
  createReadSignedUrl,
  createUploadSignedUrl,
  listClientMediaObjects,
  mediaObjectPath,
} from "@/lib/gcs-media";
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

async function registerClip(opts: {
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
  const videoUrl = await createReadSignedUrl(opts.gcsPath);
  return createAsset({
    clientId: opts.clientId,
    agentId: null,
    type: "social_post",
    title: humanizeFilename(opts.filename),
    content: "",
    meta: {
      bulkUpload: true,
      gcsPath: opts.gcsPath,
      sourceFilename: opts.filename,
      taskType,
      ...(typeof opts.durationSeconds === "number" ? { durationSeconds: opts.durationSeconds } : {}),
      formatTags: detectFormatTags(opts.filename),
    },
    videoUrl,
    mimeType: opts.contentType || "video/mp4",
    channels: ["tiktok"],
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
async function registeredClipIds(clientId: string): Promise<Map<string, string>> {
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
 * Assets" dropzone, src/components/bulk-upload-clips.tsx):
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

  const client = await getClient(body.clientId);
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if (body.step === "sign") {
    const { filename, contentType, sizeBytes } = body;
    if (!filename || !contentType) {
      return NextResponse.json({ error: "filename and contentType are required" }, { status: 400 });
    }
    if (!ALLOWED_VIDEO_MIME_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Unsupported file type: ${contentType}` }, { status: 400 });
    }
    if (typeof sizeBytes !== "number" || sizeBytes <= 0) {
      return NextResponse.json({ error: "sizeBytes is required" }, { status: 400 });
    }
    if (sizeBytes > MAX_VIDEO_BYTES) {
      return NextResponse.json(
        { error: `File is larger than ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024 * 1024))} GB` },
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
    const already = (await registeredClipIds(body.clientId)).get(gcsPath);
    if (already) return NextResponse.json({ id: already });

    const id = await registerClip({
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
  const registeredPaths = await registeredClipIds(body.clientId);
  const unregistered = objects.filter((o) => !registeredPaths.has(o.gcsPath));

  const imported: string[] = [];
  for (const obj of unregistered) {
    await registerClip({
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
