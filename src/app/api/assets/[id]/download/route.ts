import { NextResponse } from "next/server";
import JSZip from "jszip";
import {
  assetImages,
  assetVideos,
  assetFileStem,
  imageExtFromUrl,
  videoExtFromUrl,
} from "@/lib/asset-images";
import { agentServiceFetchHeaders } from "@/lib/agent-service/client";
import { authorizeAssetMedia, resolveAssetVideoUrl } from "@/lib/asset-media";
import { isMediaContentType } from "@/lib/media-type";

export const runtime = "nodejs";
/** A clip can be 2 GB. The body is streamed, but the transfer still needs time. */
export const maxDuration = 300;

/**
 * Download an asset's deliverable as a file — a zip for a multi-photo carousel,
 * the raw image for a single-photo post, or the clip for a video deliverable
 * (`?kind=video&i=N`). The fetch happens server-side, so it works regardless of
 * the storage host's CORS policy (the browser can't fetch firebasestorage URLs
 * cross-origin, which is why the old client-side download silently produced
 * nothing).
 *
 * Video used to be missing entirely: this route read only `assetImages`, so a
 * bulk-uploaded clip — which has no photo at all — answered "this asset has no
 * images", and both download controls in the UI were gated on the same check,
 * so a clip had no download button anywhere in the product.
 *
 * Nothing here writes an attachment it cannot vouch for. A dead storage link
 * answers with an error document, not the media (GCS returns 403 and an XML
 * `<Error>` body for an expired V4 signature), and a file like that saved under
 * a .mp4 name is the "I downloaded it and it didn't open" report. Both the
 * status and the content type are checked before any `Content-Disposition:
 * attachment` is set.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Staff see everything, a client only its own client's assets, and a locked
  // (future-dated) post refuses for clients — shared with the playback route so
  // the two cannot drift.
  const access = await authorizeAssetMedia(id);
  if (!access.ok) return access.response;
  const asset = access.asset;

  const query = new URL(req.url).searchParams;
  const images = assetImages(asset);
  const videos = assetVideos(asset);
  const stem = assetFileStem(asset.title || "post");

  const fetchMedia = (url: string) => {
    const headers = agentServiceFetchHeaders(url);
    return fetch(url, headers ? { headers } : undefined);
  };

  // The clip controls ask for `kind=video`. A bare /download still serves
  // photos when the asset has them, and falls through to the clip when it has
  // none — which is every bulk-uploaded clip.
  if (query.get("kind") === "video" || images.length === 0) {
    if (videos.length === 0) {
      return NextResponse.json({ error: "This asset has nothing to download" }, { status: 404 });
    }

    const asked = Number.parseInt(query.get("i") ?? "0", 10);
    const index = Number.isInteger(asked) && asked > 0 ? asked : 0;
    // Re-signed from meta.gcsPath per request: the URL stored on the asset is
    // usually expired by the day the clip is shown.
    const src = await resolveAssetVideoUrl(asset, index);
    if (!src) {
      return NextResponse.json({ error: "This asset has no video" }, { status: 404 });
    }

    const res = await fetchMedia(src);
    if (!res.ok || !res.body || !isMediaContentType(res.headers.get("content-type"), "video")) {
      return NextResponse.json({ error: "Could not fetch video" }, { status: 502 });
    }

    const length = res.headers.get("content-length");
    const name = videos.length > 1 ? `${stem}-${index + 1}` : stem;
    // Streamed, not buffered: a clip is far too large to hold in memory.
    return new NextResponse(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "video/mp4",
        "Content-Disposition": `attachment; filename="${name}.${videoExtFromUrl(videos[index].url)}"`,
        ...(length ? { "Content-Length": length } : {}),
        "Cache-Control": "private, no-store",
      },
    });
  }

  // Single photo → stream the raw image.
  if (images.length === 1) {
    const res = await fetchMedia(images[0].url);
    if (!res.ok || !isMediaContentType(res.headers.get("content-type"), "image")) {
      return NextResponse.json({ error: "Could not fetch image" }, { status: 502 });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${stem}.${imageExtFromUrl(images[0].url)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  // Multi-photo post → bundle every image into one zip.
  const zip = new JSZip();
  const added = await Promise.all(
    images.map(async (img, i) => {
      try {
        const res = await fetchMedia(img.url);
        if (!res.ok || !isMediaContentType(res.headers.get("content-type"), "image")) return false;
        zip.file(`${stem}-${i + 1}.${imageExtFromUrl(img.url)}`, await res.arrayBuffer());
        return true;
      } catch {
        return false;
      }
    }),
  );

  if (!added.some(Boolean)) {
    return NextResponse.json({ error: "Could not fetch images" }, { status: 502 });
  }

  const archive = await zip.generateAsync({ type: "arraybuffer" });
  return new NextResponse(archive, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${stem}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
