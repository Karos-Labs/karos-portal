import "server-only";

import { randomUUID } from "node:crypto";

import { adminBucket, adminBucketName } from "@/lib/firebase/admin";

/**
 * Upload bytes to Firebase Cloud Storage and return a durable, publicly readable
 * download URL. We attach a Firebase download token rather than relying on bucket
 * ACLs, so the URL works regardless of the bucket's access settings and never
 * expires (unlike signed URLs). Shared by image generation and the client
 * context library.
 */
export async function uploadBytes(args: {
  bytes: Buffer;
  path: string;
  contentType: string;
}): Promise<{ url: string; path: string }> {
  const { bytes, path, contentType } = args;
  const token = randomUUID();
  const bucket = adminBucket();
  const file = bucket.file(path);
  try {
    await file.save(bytes, {
      resumable: false,
      contentType,
      metadata: {
        contentType,
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    throw new Error(
      `Storage upload failed for bucket "${adminBucketName()}": ${msg}. ` +
        "Verify NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET matches your real bucket " +
        "(Firebase console → Storage shows it as gs://<name>) and that Storage is enabled.",
    );
  }
  const encodedPath = encodeURIComponent(path);
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${token}`;
  return { url, path };
}

/** Delete a stored object. Soft-fails (already-gone is fine). */
export async function deleteObject(path: string): Promise<void> {
  try {
    await adminBucket().file(path).delete();
  } catch {
    // Object may already be gone; ignore.
  }
}
