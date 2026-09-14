/**
 * Storage uploads for scripts, which cannot import src/lib/storage.ts: that
 * module is "server-only" and takes its bucket and credential from
 * src/lib/firebase/admin.ts. The same GCS JSON REST calls and the same Firebase
 * download-URL shape; the caller passes the bucket and an access token.
 *
 * There is one mode, storage.ts's `ifAbsent`, and no overwrite. The upload
 * carries `ifGenerationMatch=0`, so GCS accepts it only when no object is at the
 * path yet. When one is (HTTP 412), this reads back that object's own download
 * token and returns its URL instead of replacing it. Replacing an object mints a
 * new generation with a new token, and every record still holding the old token
 * gets "Permission denied" from Firebase Storage from then on: the dead-token
 * failure scripts/repair-stale-lab-import-tokens.ts repairs. The one caller,
 * import-lab-client.ts, only writes paths another record may already point at
 * (see its "STORAGE IS SHARED" note), so it has no use for an overwrite.
 */
import { randomUUID } from "node:crypto";

export interface UploadIfAbsentArgs {
  bytes: Buffer;
  /** Object path in the bucket, e.g. "client-logos/lab-geektime/geektime-profile-disc.png". */
  path: string;
  contentType: string;
  /** Bucket name, as NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET holds it. */
  bucket: string;
  /** OAuth access token for a credential that can create and read objects in `bucket`. */
  accessToken: string;
}

export interface UploadedObject {
  url: string;
  path: string;
  /** True when an object was already at `path`: nothing was written, and `url` carries that object's own token. */
  reused: boolean;
}

function downloadUrl(bucket: string, path: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

/** Reads back an existing object's OWN download token and never mints one (storage.ts's `existingObjectUrl`). */
async function existingObjectUrl(bucket: string, path: string, accessToken: string): Promise<string> {
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Storage object "${path}" reported as already existing (412) but could not be read back: ${res.status} ${text}.`,
    );
  }
  const data = (await res.json()) as { metadata?: { firebaseStorageDownloadTokens?: string } };
  const token = data.metadata?.firebaseStorageDownloadTokens?.split(",")[0];
  if (!token) {
    throw new Error(`Storage object "${path}" already exists but carries no download token.`);
  }
  return downloadUrl(bucket, path, token);
}

/** Uploads `bytes` to `path` unless an object is already there, in which case it returns that object's URL. */
export async function uploadIfAbsent(args: UploadIfAbsentArgs): Promise<UploadedObject> {
  const { bytes, path, contentType, bucket, accessToken } = args;
  const downloadToken = randomUUID();
  // Multipart upload: the metadata part sets the Firebase download token, the
  // media part carries the bytes.
  const boundary = `b${downloadToken.replace(/-/g, "")}`;
  const metaJson = JSON.stringify({
    name: path,
    contentType,
    metadata: { firebaseStorageDownloadTokens: downloadToken },
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart&ifGenerationMatch=0`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (res.status === 412) {
    return { url: await existingObjectUrl(bucket, path, accessToken), path, reused: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Storage upload failed (${res.status}): ${text}`);
  }
  return { url: downloadUrl(bucket, path, downloadToken), path, reused: false };
}
