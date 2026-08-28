import "server-only";

import { Storage } from "@google-cloud/storage";

import { dispositionFilename } from "@/lib/media-type";

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
 * this SDK already handles.
 *
 * SCRUM-373: this client is Application Default Credentials ONLY, deliberately
 * NOT firebase-admin's precedence chain (FIREBASE_SERVICE_ACCOUNT_KEY / discrete
 * FIREBASE_* vars / ADC). That chain used to be mirrored here, which meant every
 * GCS call ran as `firebase-adminsdk-fbsvc@karoscmo` — a shared production
 * identity present in BOTH environments — instead of the Cloud Run runtime SA,
 * making every bucket-scoped IAM grant to a runtime SA (SCRUM-369, SCRUM-371)
 * inert: the code never authenticated as the principal that was granted.
 *
 * Signing strategy, decided (see docs/gcs-media-setup.md §3): IAM `signBlob` via
 * `roles/iam.serviceAccountTokenCreator` granted to the runtime SA on itself,
 * NOT a dedicated signing key. No key material to create, store, rotate or leak
 * — the same reasoning firebase/admin.ts already gives for its own ADC
 * fallback. This is not a guess about SDK behaviour: google-auth-library's
 * `GoogleAuth.sign()` (node_modules/google-auth-library/build/src/auth/
 * googleauth.js) only signs locally when the resolved client carries a JWT
 * private key; a metadata-server / ADC client has none, so it falls through to
 * `signBlob()`, which POSTs to `iamcredentials.googleapis.com/.../{client_email}
 * :signBlob` authenticated as that same identity — i.e. self-impersonation,
 * which is exactly what `serviceAccountTokenCreator`-on-self authorizes and a
 * bare `storage.objectAdmin` grant does not.
 *
 * Firestore's use of the Firebase credential (src/lib/firebase/admin.ts) is
 * unchanged by this ticket — that chain still exists there, deliberately; see
 * SCRUM-373's description for why the two are being decided separately.
 */

const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
/** Matches the agent-service's own convention (agent-service/src/storage/gcs.ts). */
export const READ_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * TTL for a URL minted per request and handed to one browser for one playback
 * or download (`resolveAssetVideo`, src/lib/asset-media.ts). Nothing stores it,
 * so it only has to outlive the transfer it was minted for — GCS checks expiry
 * when the request starts, not while it streams, so a 2 GB clip on a slow line
 * is not cut off an hour in.
 */
export const PLAYBACK_URL_TTL_MS = 60 * 60 * 1000;

export const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
export const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov"];
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

let storage: Storage | undefined;

function getStorageClient(): Storage {
  if (storage) return storage;
  // Application Default Credentials ONLY — Cloud Run's attached runtime service
  // account, or `gcloud auth application-default login` locally. Deliberately
  // does NOT read FIREBASE_SERVICE_ACCOUNT_KEY or the discrete FIREBASE_* vars
  // (see the module header): that credential is a different, shared identity
  // and using it here is the SCRUM-373 finding, not a fallback to preserve.
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

/**
 * A V4 signed READ URL that a browser can be redirected STRAIGHT to for a
 * download — `response-content-disposition` (and, when we can identify the
 * object, `response-content-type`) are baked into the signature, so GCS itself
 * tells the browser to save the file and what to call it.
 *
 * This is why the clip download is a redirect rather than a proxy. Proxying a
 * clip puts browser↔app↔GCS bytes under Cloud Run's request timeout
 * (`--timeout=300` in cloudbuild.yaml): a 2 GB clip inside 300 s needs about
 * 55 Mbit/s sustained, and a slower client would have the request killed
 * mid-stream and land a truncated .mp4 — the same "downloaded but won't open"
 * symptom, only moved. Redirected, the transfer is browser↔GCS with no ceiling
 * of ours, and range requests and resume keep working.
 *
 * Short TTL by default: the URL is minted for one request and nothing stores it.
 */
export async function createDownloadSignedUrl(opts: {
  gcsPath: string;
  filename: string;
  contentType?: string;
  ttlMs?: number;
}): Promise<string> {
  const bucket = getStorageClient().bucket(getBucketName());
  const [url] = await bucket.file(opts.gcsPath).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + (opts.ttlMs ?? PLAYBACK_URL_TTL_MS),
    responseDisposition: `attachment; filename="${dispositionFilename(opts.filename)}"`,
    ...(opts.contentType ? { responseType: opts.contentType } : {}),
  });
  return url;
}
