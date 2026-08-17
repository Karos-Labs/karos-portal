import "server-only";

import { randomUUID } from "node:crypto";

import { adminBucketName, getAdminAccessToken } from "@/lib/firebase/admin";

/**
 * Default wall-clock budget for one upload. `fetch` has no implicit timeout, so
 * without this a stalled connection to storage hangs until the *platform* kills
 * the whole request — which is how a caller that must finish its work loses it
 * partway through. 30s is generous for the largest payload the callers here send
 * (the webhook caps each file at REHOST_FILE_LIMIT_BYTES) while still bounding a
 * genuine hang.
 *
 * A DEFAULT, not a ceiling. A caller that passes `timeoutMs` owns that number in
 * either direction, and this value stops applying to it — deliberately, so a
 * caller doing arithmetic against its own deadline is doing it with the number
 * that will really be enforced rather than one storage.ts quietly overrode.
 */
const UPLOAD_TIMEOUT_MS = 30_000;

/**
 * Upload bytes to Firebase Cloud Storage and return a durable, publicly readable
 * download URL.
 *
 * Uses the GCS JSON REST API authenticated via firebase-admin's own credential
 * (google-auth-library v10 → https://oauth2.googleapis.com/token). Avoids the
 * @google-cloud/storage nested auth chain that resolves to gtoken@7 which hardcodes
 * the deprecated https://www.googleapis.com/oauth2/v4/token endpoint.
 *
 * The upload REQUEST is bounded by `timeoutMs` (default UPLOAD_TIMEOUT_MS): it
 * aborts rather than hanging. Credential acquisition is not — `getAdminAccessToken`
 * is awaited before the signal exists, so a hang there is outside this bound and
 * outside any deadline a caller computes from `timeoutMs`.
 */
/** Reads back an existing object's OWN download token — never mints one, since a
 *  mismatched token is a silent, unrenderable photo (see `uploadBytes`'s `ifAbsent`). */
async function existingObjectUrl(
  bucketName: string,
  path: string,
  accessToken: string,
): Promise<{ url: string; path: string }> {
  const encodedBucket = encodeURIComponent(bucketName);
  const encodedPath = encodeURIComponent(path);
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodedBucket}/o/${encodedPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Storage object "${path}" reported as already existing (412) but could not be read back: ` +
        `${res.status} ${text}.`,
    );
  }
  const data = (await res.json()) as { metadata?: { firebaseStorageDownloadTokens?: string } };
  const token = data.metadata?.firebaseStorageDownloadTokens?.split(",")[0];
  if (!token) {
    throw new Error(`Storage object "${path}" already exists but carries no download token.`);
  }
  return { url: `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${token}`, path };
}

export async function uploadBytes(args: {
  bytes: Buffer;
  path: string;
  contentType: string;
  timeoutMs?: number;
  /**
   * Refuse to overwrite an object already at `path`, rather than minting a
   * new generation with a new token. Two overlapping writers to the same
   * deterministic path (a retried lab import, a resumed upload) is exactly
   * the shape that put a stale token in Firestore: both mint their own
   * `downloadToken` locally, both write it into an asset's `meta`, but GCS
   * has no notion of "two tokens" for one object — whichever write lands
   * LAST wins the object, so the OTHER writer's Firestore doc now points a
   * token that matches no live generation, and Firebase Storage answers with
   * "Permission denied" (indistinguishable, from a caller's side, from a
   * genuine access-rules rejection) forever after.
   *
   * `ifGenerationMatch=0` makes GCS itself the arbiter: it accepts the write
   * only if no object exists there yet, and returns 412 otherwise — at which
   * point the caller wants THE OBJECT THAT'S ACTUALLY THERE, not to have
   * clobbered it, so this reads back its real token instead of throwing.
   */
  ifAbsent?: boolean;
}): Promise<{ url: string; path: string }> {
  const { bytes, path, contentType } = args;
  // Floor of 1ms so a caller that has run its own budget to zero gets a prompt
  // abort rather than a RangeError out of AbortSignal.timeout, which rejects a
  // negative delay. (Measured, because the first version of this comment named
  // the wrong failure: a delay of 0 throws nothing and aborts on the next tick,
  // so zero was never the hang case either.)
  const timeoutMs = Math.max(1, args.timeoutMs ?? UPLOAD_TIMEOUT_MS);
  const downloadToken = randomUUID();
  const bucketName = adminBucketName();
  const accessToken = await getAdminAccessToken();

  // Multipart upload: metadata part sets the Firebase download token,
  // media part carries the file bytes.
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

  const encodedBucket = encodeURIComponent(bucketName);
  const preconditionParam = args.ifAbsent ? "&ifGenerationMatch=0" : "";
  const res = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodedBucket}/o?uploadType=multipart${preconditionParam}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  if (!res.ok) {
    if (args.ifAbsent && res.status === 412) {
      return await existingObjectUrl(bucketName, path, accessToken);
    }
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Storage upload failed for bucket "${bucketName}": ${res.status} ${text}. ` +
        "Verify NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET matches your real bucket " +
        "(Firebase console → Storage shows it as gs://<name>) and that Storage is enabled.",
    );
  }

  const encodedPath = encodeURIComponent(path);
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${downloadToken}`;
  return { url, path };
}

/** Delete a stored object. Soft-fails (already-gone is fine). */
export async function deleteObject(path: string): Promise<void> {
  try {
    const bucketName = adminBucketName();
    const accessToken = await getAdminAccessToken();
    const encodedBucket = encodeURIComponent(bucketName);
    const encodedPath = encodeURIComponent(path);
    await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodedBucket}/o/${encodedPath}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  } catch {
    // Object may already be gone; ignore.
  }
}
