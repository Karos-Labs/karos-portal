import "server-only";

import { randomUUID } from "node:crypto";

import { adminBucketName, getAdminAccessToken } from "@/lib/firebase/admin";

/**
 * Upload bytes to Firebase Cloud Storage and return a durable, publicly readable
 * download URL.
 *
 * Uses the GCS JSON REST API authenticated via firebase-admin's own credential
 * (google-auth-library v10 → https://oauth2.googleapis.com/token). Avoids the
 * @google-cloud/storage nested auth chain that resolves to gtoken@7 which hardcodes
 * the deprecated https://www.googleapis.com/oauth2/v4/token endpoint.
 */
export async function uploadBytes(args: {
  bytes: Buffer;
  path: string;
  contentType: string;
}): Promise<{ url: string; path: string }> {
  const { bytes, path, contentType } = args;
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
  const res = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodedBucket}/o?uploadType=multipart`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  if (!res.ok) {
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
