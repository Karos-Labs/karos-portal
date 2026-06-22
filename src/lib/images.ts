import "server-only";

import { randomUUID } from "node:crypto";

import { adminBucket, adminBucketName } from "@/lib/firebase/admin";

/**
 * Generate an image from a text concept using Higgsfield "Soul" (text-to-image)
 * via Segmind's REST API, then persist it to Firebase Cloud Storage and return a
 * durable public URL.
 *
 * Segmind can answer either synchronously (image bytes in the POST response) or
 * asynchronously (JSON with a poll URL). Both shapes are handled here so callers
 * just get back a URL. Throws on failure — callers should catch per-image so one
 * bad image doesn't fail an entire job.
 */

const SEGMIND_URL = "https://api.segmind.com/v1/higgsfield-text2image-soul";

// The exact set of dimensions the Soul model accepts (anything else → HTTP 400).
const ALLOWED_SIZES = new Set([
  "1152x2048", "2048x1152", "2048x1536", "1536x2048", "1344x2016", "2016x1344",
  "960x1696", "1696x960", "1536x1536", "1536x1152", "1152x1536", "1088x1632",
  "1632x1088",
]);

// Portrait 3:4 — the closest Instagram-friendly portrait the model offers
// (there is no native 4:5). Overridable via SEGMIND_SOUL_SIZE.
const DEFAULT_SIZE = "1152x1536";

// The Soul "Realistic" style — photographic, the right default for brand work.
// (The model's own default is "Creatures", which produces reptilian humanoids
// regardless of the prompt — never use it here.) Other useful style UUIDs:
//   DigitalCam   ca4e6ad3-3e93-4e03-81a0-d1722d2c128b
//   Quiet luxury ff1ad8a2-94e7-4e70-a12f-e992ca9a0d36
//   Spotlight    40ff999c-f576-443c-b5b3-c7d1391a666e
// Override with SEGMIND_SOUL_STYLE_ID.
const FALLBACK_STYLE_ID = "1cb4b936-77bf-4f9a-9039-f3d349a4cdbe";

// Segmind recommends 0.8 for realistic product/brand visuals.
// Overridable via SEGMIND_SOUL_STYLE_STRENGTH (0–1).
const DEFAULT_STYLE_STRENGTH = 0.8;

export interface GenerateImageOptions {
  /** The art-direction brief — maps to the Higgsfield `prompt`. */
  concept: string;
  /** Destination filename (no extension), used as the storage key prefix. */
  key: string;
  /** Overrides the default size; ignored if not an allowed dimension. */
  size?: string;
  styleId?: string;
}

function resolveSize(override?: string): string {
  if (override && ALLOWED_SIZES.has(override)) return override;
  const env = process.env.SEGMIND_SOUL_SIZE;
  if (env && ALLOWED_SIZES.has(env)) return env;
  return DEFAULT_SIZE;
}

function resolveStyleStrength(): number {
  const raw = Number(process.env.SEGMIND_SOUL_STYLE_STRENGTH);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return DEFAULT_STYLE_STRENGTH;
}

export function imageGenConfigured(): boolean {
  return Boolean(process.env.SEGMIND_API_KEY);
}

export async function generatePostImage(opts: GenerateImageOptions): Promise<string> {
  const apiKey = process.env.SEGMIND_API_KEY;
  if (!apiKey) throw new Error("SEGMIND_API_KEY is not set");

  const res = await fetch(SEGMIND_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: opts.concept,
      width_and_height: resolveSize(opts.size),
      style_id: opts.styleId ?? process.env.SEGMIND_SOUL_STYLE_ID ?? FALLBACK_STYLE_ID,
      style_strength: resolveStyleStrength(),
      enhance_prompt: true,
      quality: "1080p",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Segmind request failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const bytes = await resolveImageBytes(res, apiKey);
  return uploadToStorage(bytes, `assets/${opts.key}.jpg`);
}

/**
 * Upload image bytes to Firebase Storage and return a durable, publicly readable
 * download URL. We attach a Firebase download token rather than relying on
 * bucket ACLs, so the URL works regardless of the bucket's access settings and
 * never expires (unlike signed URLs).
 */
async function uploadToStorage(bytes: Buffer, path: string): Promise<string> {
  const token = randomUUID();
  const bucket = adminBucket();
  const file = bucket.file(path);
  try {
    await file.save(bytes, {
      resumable: false,
      contentType: "image/jpeg",
      metadata: {
        contentType: "image/jpeg",
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
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${token}`;
}

/**
 * Resolve the POST response into image bytes, whether Segmind returned the image
 * inline (sync) or a JSON envelope pointing at a result (async polling).
 */
async function resolveImageBytes(res: Response, apiKey: string): Promise<Buffer> {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.startsWith("image/")) {
    return Buffer.from(await res.arrayBuffer());
  }

  // JSON envelope — either a direct image URL or an async request to poll.
  const data = (await res.json()) as Record<string, unknown>;

  const directUrl = firstString(data, ["image_url", "imageUrl", "url", "output"]);
  if (directUrl) return downloadImage(directUrl, apiKey);

  const statusUrl = firstString(data, ["status_url", "statusUrl"]);
  const requestId = firstString(data, ["request_id", "requestId", "id"]);
  if (statusUrl || requestId) {
    return pollForImage({ statusUrl, requestId, apiKey });
  }

  throw new Error("Segmind returned no image and no poll handle");
}

async function pollForImage(args: {
  statusUrl?: string;
  requestId?: string;
  apiKey: string;
}): Promise<Buffer> {
  const { statusUrl, requestId, apiKey } = args;
  const url = statusUrl ?? `https://api.segmind.com/v2/requests/${requestId}`;
  const headers = { "x-api-key": apiKey };

  // Poll up to ~60s. Server functions allow long timeouts, but stay bounded.
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(2000);
    const res = await fetch(url, { headers });
    if (!res.ok) continue;

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.startsWith("image/")) {
      return Buffer.from(await res.arrayBuffer());
    }

    const data = (await res.json()) as Record<string, unknown>;
    const status = String(data.status ?? "").toUpperCase();
    if (status === "FAILED" || status === "ERROR") {
      throw new Error(`Segmind generation failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const imageUrl = firstString(data, ["image_url", "imageUrl", "url", "output"]);
    if (imageUrl) return downloadImage(imageUrl, apiKey);
  }
  throw new Error("Segmind generation timed out");
}

async function downloadImage(url: string, apiKey: string): Promise<Buffer> {
  // Segmind result URLs may require the same auth header.
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`Failed to download generated image (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
