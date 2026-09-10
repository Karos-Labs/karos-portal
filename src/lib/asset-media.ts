import "server-only";

import { NextResponse } from "next/server";

import { getCurrentUser, isStaff } from "@/lib/auth";
import { canViewClient } from "@/lib/client-visibility";
import { getAsset, getClient } from "@/lib/data";
import { resolveAssetVideoSource, type AssetVideoSource } from "@/lib/asset-video-source";
import {
  PLAYBACK_URL_TTL_MS,
  createDownloadSignedUrl,
  createReadSignedUrl,
} from "@/lib/gcs-media";
import { isAssetUnlockedForClient } from "@/lib/post-chain";
import type { AppUser } from "@/lib/types";
import type { Asset } from "@/lib/types";

/**
 * Server-side plumbing shared by the two routes that hand an asset's media to a
 * browser: `/api/assets/[id]/download` and `/api/assets/[id]/media`.
 */

export type AssetMediaAccess =
  /**
   * `user` rides along because every caller needs it immediately afterwards to
   * decide WHICH REGISTER to answer in, and this function has already resolved
   * the session cookie to get it. Handing it back turns a second
   * `getCurrentUser()` — a redundant auth round-trip on the hot path of a
   * media route — into a field read, and removes the `user?` optionality the
   * callers were carrying for a value this branch has already proved is
   * present.
   */
  | { ok: true; asset: Asset; user: AppUser }
  | { ok: false; response: NextResponse };

/**
 * One definition of "may this caller have this asset's media": a client reaches
 * only its own client's assets, a staff member only the clients `canViewClient`
 * assigns them, and a future-dated post is withheld from the client until its
 * day arrives. Both media routes call this so the playback path and the
 * download path cannot drift apart on the rule that decides what a client can
 * see.
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

  // A client may only reach its own client's assets; a staff member only the
  // clients they are assigned. "Staff see everything" was the seventh instance
  // of one shape in this campaign — a check that establishes WHICH KIND of actor
  // this is and then treats that as the answer to WHICH CLIENTS they may touch.
  // 404, not 403: the pages already refuse an out-of-scope client that way, and
  // a distinguishable refusal here would confirm the asset exists.
  const client = await getClient(asset.clientId);
  const permitted = isStaff(user)
    ? !!client && canViewClient(user, client)
    : user.clientId === asset.clientId;
  if (!permitted) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
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

  return { ok: true, asset, user };
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
