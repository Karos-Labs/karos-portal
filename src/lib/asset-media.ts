import "server-only";

import { NextResponse } from "next/server";

import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAsset } from "@/lib/data";
import { assetVideos } from "@/lib/asset-images";
import { PLAYBACK_URL_TTL_MS, createReadSignedUrl } from "@/lib/gcs-media";
import { isAssetUnlockedForClient } from "@/lib/post-chain";
import type { Asset } from "@/lib/types";

/**
 * Server-side plumbing shared by the two routes that hand an asset's media to a
 * browser: `/api/assets/[id]/download` and `/api/assets/[id]/media`.
 */

export type AssetMediaAccess = { ok: true; asset: Asset } | { ok: false; response: NextResponse };

/**
 * One definition of "may this caller have this asset's media": staff see
 * everything, a client only its own client's assets, and a future-dated post is
 * withheld from the client until its day arrives. Both media routes call this
 * so the playback path and the download path cannot drift apart on the rule
 * that decides what a client can see.
 */
export async function authorizeAssetMedia(id: string): Promise<AssetMediaAccess> {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const asset = await getAsset(id);
  if (!asset) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  // Staff see everything; a client may only reach its own client's assets.
  if (!isStaff(user) && user.clientId !== asset.clientId) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  // Future-dated chain posts are withheld from clients until their day arrives
  // (server-local midnight) — same gate as the library's redaction layer.
  if (!isStaff(user) && !isAssetUnlockedForClient(asset, Date.now())) {
    return {
      ok: false,
      response: NextResponse.json(
        // Creation language (§4.1 item 1): "unlocks" tells the caller the file
        // exists and is being withheld. This body reaches a client.
        { error: "This post is created on its scheduled day. It'll be available here that morning." },
        { status: 403 },
      ),
    };
  }

  return { ok: true, asset };
}

/**
 * The URL a clip can actually be fetched from RIGHT NOW.
 *
 * `api/assets/bulk-upload` mints a V4 signed GCS URL with a 7-day TTL and
 * persists it as `asset.videoUrl`. Nothing re-signs it, and
 * `bulkScheduleClipsAction` spreads a batch one clip per day across weeks, so
 * most of a batch is a dead link by the day it is shown: the player never
 * loads, and anything the browser saves from that URL is GCS's 403 `<Error>`
 * XML document rather than the video — a file that will not open.
 *
 * The durable identifier was stored all along, so re-sign from `meta.gcsPath`
 * on every request instead. Re-signing is request-time only — nothing is
 * written back to Firestore.
 *
 * Assets with no `gcsPath` — webhook clips whose files were re-hosted to
 * Firebase Storage, lab imports carrying `meta.videos` — keep their stored URL,
 * which is durable already. A signing failure (bucket unset in an environment,
 * IAM hiccup) also degrades to the stored URL: a possibly-stale link still
 * beats a dead page.
 *
 * Returns null when the asset has no clip at that index.
 */
export async function resolveAssetVideoUrl(asset: Asset, index: number): Promise<string | null> {
  const video = assetVideos(asset)[index];
  if (!video) return null;

  const gcsPath = typeof asset.meta?.gcsPath === "string" ? asset.meta.gcsPath : null;
  // gcsPath names exactly one object: the clip that landed in `videoUrl`.
  // Clips discovered in meta.videos / meta.files are other files entirely.
  if (!gcsPath || !asset.videoUrl || video.url !== asset.videoUrl) return video.url;

  try {
    return await createReadSignedUrl(gcsPath, PLAYBACK_URL_TTL_MS);
  } catch {
    return video.url;
  }
}
