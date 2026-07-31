import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAsset } from "@/lib/data";
import { assetVideos, assetFileStem } from "@/lib/asset-images";
import { agentServiceFetchHeaders } from "@/lib/agent-service/client";
import { isAssetUnlockedForClient } from "@/lib/post-chain";

export const runtime = "nodejs";

function videoExtFromUrl(url: string): string {
  const m = /\.(mp4|webm|mov|m4v)(\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : "mp4";
}

/**
 * Download one video clip attached to an asset. Videos live in GCS block
 * storage (asset.videoUrl / meta.videos / meta.artifacts — see
 * asset-images.ts's assetVideos), and a browser can't fetch a GCS URL
 * directly for a forced download the way an <a download> anchor expects —
 * same cross-origin problem the image download route exists to dodge, plus
 * GCS signed URLs expire (7 days, gcs-media.ts), so re-fetching server-side
 * also sidesteps a stale link. Streams the response body straight through
 * rather than buffering (unlike the image route's zip path) since clips can
 * be tens to hundreds of MB.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!isStaff(user) && user.clientId !== asset.clientId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isStaff(user) && !isAssetUnlockedForClient(asset, Date.now())) {
    return NextResponse.json(
      { error: "This post is created on its scheduled day. It'll be available here that morning." },
      { status: 403 },
    );
  }

  const clips = assetVideos(asset);
  if (clips.length === 0) {
    return NextResponse.json({ error: "This asset has no video" }, { status: 404 });
  }

  // Clips render in this same order in the modal (assetVideos), so an index
  // is a stable, opaque way to pick one without exposing the storage URL in
  // the download link itself.
  const requestedIndex = Number(new URL(req.url).searchParams.get("i"));
  const clip = clips[Number.isInteger(requestedIndex) ? requestedIndex : -1] ?? clips[0];

  const headers = agentServiceFetchHeaders(clip.url);
  let res: Response;
  try {
    res = await fetch(clip.url, headers ? { headers } : undefined);
  } catch {
    return NextResponse.json({ error: "Could not fetch video" }, { status: 502 });
  }
  if (!res.ok || !res.body) {
    return NextResponse.json({ error: "Could not fetch video" }, { status: 502 });
  }

  const stem = assetFileStem(clip.name || asset.title || "video");
  const contentLength = res.headers.get("content-length");
  return new NextResponse(res.body, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "video/mp4",
      "Content-Disposition": `attachment; filename="${stem}.${videoExtFromUrl(clip.url)}"`,
      "Cache-Control": "private, no-store",
      ...(contentLength ? { "Content-Length": contentLength } : {}),
    },
  });
}
