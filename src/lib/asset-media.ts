import "server-only";

import { NextResponse } from "next/server";

import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAsset } from "@/lib/data";
import { resolveAssetVideoSource, type AssetVideoSource } from "@/lib/asset-video-source";
import {
  PLAYBACK_URL_TTL_MS,
  createDownloadSignedUrl,
  createReadSignedUrl,
} from "@/lib/gcs-media";
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
 * The URL a clip can actually be fetched from RIGHT NOW, with the real signer
 * wired in. The decision itself — which of the four branches applies — lives in
 * `resolveAssetVideoSource` (src/lib/asset-video-source.ts), which takes the
 * signer as a parameter so every branch can be exercised by a test.
 *
 * Pass `downloadFilename` to get a URL that GCS will serve as an attachment
 * under that name; omit it for inline playback.
 */
export async function resolveAssetVideo(
  asset: Asset,
  index: number,
  opts: { downloadFilename?: string } = {},
): Promise<AssetVideoSource | null> {
  return resolveAssetVideoSource(
    asset,
    index,
    async (gcsPath, signOpts) =>
      signOpts.downloadFilename
        ? createDownloadSignedUrl({
            gcsPath,
            filename: signOpts.downloadFilename,
            ...(signOpts.contentType ? { contentType: signOpts.contentType } : {}),
            ttlMs: PLAYBACK_URL_TTL_MS,
          })
        : createReadSignedUrl(gcsPath, PLAYBACK_URL_TTL_MS),
    opts,
  );
}
