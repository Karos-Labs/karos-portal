import "server-only";

import { Storage } from "@google-cloud/storage";

/**
 * Signed-URL access to a dedicated GCS bucket for large pre-generated media
 * (podcast-clip video, etc.) — deliberately separate from the Firebase
 * Storage bucket `src/lib/storage.ts` writes to (logos/avatars/resumes),
 * since these files are large, video-only, and partitioned per client for
 * the bulk-upload pipeline (see docs/README or GCP setup instructions).
 *
 * Uses `@google-cloud/storage` directly (unlike storage.ts's REST workaround)
 * because V4 signed URLs need either a service-account private key to sign
 * locally, or — with no key present — the IAM signBlob API, both of which
 * this SDK already handles. Credentials mirror firebase-admin's own
 * precedence (src/lib/firebase/admin.ts) so no separate key is needed: the
 * same FIREBASE_SERVICE_ACCOUNT_KEY / FIREBASE_PROJECT_ID+CLIENT_EMAIL+
 * PRIVATE_KEY already configured for Firestore also authorizes GCS. Falls
 * back to Application Default Credentials (Cloud Run's attached service
 * account) when neither is set.
 */

const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
/** Matches the agent-service's own convention (agent-service/src/storage/gcs.ts). */
export const READ_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
export const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov"];
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

let storage: Storage | undefined;

function getStorageClient(): Storage {
  if (storage) return storage;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    const credentials = JSON.parse(raw);
    storage = new Storage({ credentials, projectId: credentials.project_id });
    return storage;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    storage = new Storage({ credentials: { client_email: clientEmail, private_key: privateKey }, projectId });
    return storage;
  }
  // Application Default Credentials — Cloud Run's attached service account,
  // or `gcloud auth application-default login` locally.
  storage = new Storage();
  return storage;
}

function getBucketName(): string {
  const name = process.env.GCS_MEDIA_BUCKET;
  if (!name) throw new Error("GCS_MEDIA_BUCKET is not set");
  return name;
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "clip.mp4";
}

/** Bucket path partitioned by client: `clients/{clientId}/podcast-clips/{timestamp}-{filename}`. */
export function mediaObjectPath(clientId: string, filename: string): string {
  return `clients/${clientId}/podcast-clips/${Date.now()}-${sanitizeFilename(filename)}`;
}

/**
 * The display filename for a bucket object: basename, with our own
 * `{timestamp}-` upload prefix stripped when present. Objects a staff member
 * drops into the bucket directly (gcloud/Console, bypassing the upload route
 * entirely) never had that prefix added, so this degrades to the plain
 * basename for those.
 */
export function filenameFromGcsPath(gcsPath: string): string {
  const basename = gcsPath.split("/").pop() ?? gcsPath;
  return basename.replace(/^\d{10,}-/, "");
}

export interface MediaObjectInfo {
  gcsPath: string;
  filename: string;
  sizeBytes: number;
  contentType?: string;
}

/**
 * Every video object already sitting under a client's podcast-clips prefix —
 * the read side of "staff uploaded straight into the bucket (gcloud storage
 * cp, Cloud Console, rclone, …), now import it" (see the "Import from
 * Storage" button, bulk-upload-clips.tsx, and the "import-bucket" step on
 * /api/assets/bulk-upload).
 */
export async function listClientMediaObjects(clientId: string): Promise<MediaObjectInfo[]> {
  const bucket = getStorageClient().bucket(getBucketName());
  const [files] = await bucket.getFiles({ prefix: `clients/${clientId}/podcast-clips/` });
  return files
    .filter((f) => ALLOWED_VIDEO_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)))
    .map((f) => ({
      gcsPath: f.name,
      filename: filenameFromGcsPath(f.name),
      sizeBytes: Number(f.metadata.size ?? 0),
      contentType: f.metadata.contentType,
    }));
}

/** A V4 signed PUT URL a browser or script can upload directly to, bypassing our server. */
export async function createUploadSignedUrl(opts: {
  gcsPath: string;
  contentType: string;
}): Promise<string> {
  const bucket = getStorageClient().bucket(getBucketName());
  const [url] = await bucket.file(opts.gcsPath).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + UPLOAD_URL_TTL_MS,
    contentType: opts.contentType,
  });
  return url;
}

/** A V4 signed READ URL for playback — stored on the Asset as `videoUrl` (7-day TTL). */
export async function createReadSignedUrl(gcsPath: string, ttlMs = READ_URL_TTL_MS): Promise<string> {
  const bucket = getStorageClient().bucket(getBucketName());
  const [url] = await bucket.file(gcsPath).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + ttlMs,
  });
  return url;
}
