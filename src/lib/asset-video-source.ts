import { assetVideos } from "@/lib/asset-images";
import type { Asset } from "@/lib/types";

/**
 * Which URL a clip should actually be fetched from right now, and whether we
 * minted it or inherited it. Pure: the signer is injected, so every branch is
 * callable from a test without a bucket, credentials or a request.
 *
 * `api/assets/bulk-upload` mints a V4 signed GCS URL with a 7-day TTL and
 * persists it as `asset.videoUrl`. Nothing re-signs it, and
 * `bulkScheduleClipsAction` spreads a batch one clip per day across weeks, so
 * most of a batch is a dead link by the day its clip is shown. The durable
 * identifier was stored all along (`meta.gcsPath`), so re-sign from that on
 * every request instead — request-time only, nothing is written back.
 */

export type AssetVideoSource =
  /** Freshly minted for this request from `meta.gcsPath`. Safe to redirect to. */
  | { origin: "signed"; url: string }
  /**
   * The URL as persisted on the asset. Either there is no `meta.gcsPath` to
   * re-sign from (webhook clips re-hosted to Firebase Storage, lab imports
   * carrying `meta.videos`), or signing failed. Durable in the Firebase case,
   * possibly stale in the signing-failure case.
   */
  | { origin: "stored"; url: string };

/** Mints a read URL for a bucket object. Injected so the decision stays pure. */
export type VideoUrlSigner = (
  gcsPath: string,
  opts: { downloadFilename?: string; contentType?: string },
) => Promise<string>;

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
};

/**
 * The content type for a bucket object, from its extension — or null when the
 * extension is not one we recognise, in which case the caller must NOT assert
 * a type and GCS serves the object's own stored one. Deliberately not
 * `videoExtFromUrl`, which defaults to mp4 and so would let us claim
 * `video/mp4` for a file we cannot identify.
 */
export function videoMimeFromPath(path: string): string | null {
  const m = path.split("?")[0].match(/\.([a-z0-9]+)$/i);
  return m ? VIDEO_MIME[m[1].toLowerCase()] ?? null : null;
}

/**
 * Resolve the clip at `index` to a URL that works right now.
 *
 * Four outcomes, all reachable and all asserted in
 * `src/lib/__tests__/asset-media-download.test.ts`:
 *
 *  1. no clip at that index                       → null
 *  2. `meta.gcsPath` names the stored clip        → re-signed, `origin: "signed"`
 *  3. no `meta.gcsPath`, or it names another file → `origin: "stored"`
 *  4. the signer throws (bucket unset in an environment, IAM hiccup)
 *                                                 → `origin: "stored"`
 *
 * `meta.gcsPath` names exactly one object: the clip that landed in `videoUrl`.
 * Clips discovered in `meta.videos` / `meta.files` are other files entirely, so
 * they keep their own URL rather than being re-signed to the wrong object.
 *
 * `downloadFilename` asks the signer to bake
 * `response-content-disposition: attachment` into the URL, so a browser sent
 * straight to GCS saves the file under our name instead of streaming it inline.
 */
export async function resolveAssetVideoSource(
  asset: Asset,
  index: number,
  sign: VideoUrlSigner,
  opts: { downloadFilename?: string } = {},
): Promise<AssetVideoSource | null> {
  const video = assetVideos(asset)[index];
  if (!video) return null;

  const gcsPath = typeof asset.meta?.gcsPath === "string" ? asset.meta.gcsPath : null;
  if (!gcsPath || !asset.videoUrl || video.url !== asset.videoUrl) {
    return { origin: "stored", url: video.url };
  }

  const contentType = videoMimeFromPath(gcsPath);
  try {
    const url = await sign(gcsPath, {
      ...(opts.downloadFilename ? { downloadFilename: opts.downloadFilename } : {}),
      ...(contentType ? { contentType } : {}),
    });
    return { origin: "signed", url };
  } catch {
    // A possibly-stale link still beats a dead page.
    return { origin: "stored", url: video.url };
  }
}
