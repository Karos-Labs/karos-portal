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
import { authorizeAssetMedia, resolveAssetVideo } from "@/lib/asset-media";
import { isErrorDocumentContentType, isVideoContentType } from "@/lib/media-type";

export const runtime = "nodejs";

/**
 * Download an asset's deliverable as a file — a zip for a multi-photo carousel,
 * the raw image for a single-photo post, or the clip for a video deliverable
 * (`?kind=video&i=N`).
 *
 * Photos are proxied: they are small, and the fetch has to happen server-side
 * because the browser can't fetch firebasestorage URLs cross-origin, which is
 * why the old client-side download silently produced nothing.
 *
 * Clips are NOT proxied. A clip can be 2 GB, and proxying puts browser↔app↔GCS
 * bytes under Cloud Run's request timeout (`--timeout=300` in cloudbuild.yaml,
 * which is the real ceiling here — `maxDuration` is a Vercel convention and is
 * inert on Cloud Run, so setting it would only assert a limit nothing enforces).
 * 2 GB inside 300 s needs about 55 Mbit/s sustained, and a slower client would
 * be cut off mid-stream holding a truncated .mp4. Instead the clip's signed URL
 * is minted with `response-content-disposition` baked in and the browser is
 * redirected to it, so the transfer is browser↔GCS with range and resume
 * intact. The one clip we cannot re-sign — no `meta.gcsPath`, i.e. a webhook
 * clip re-hosted to Firebase Storage — still proxies, because there is no URL
 * of ours to point at.
 *
 * Video used to be missing from this route entirely: it read only
 * `assetImages`, so a bulk-uploaded clip — which has no photo at all — answered
 * "this asset has no images", and both download controls in the UI were gated
 * on the same check, so a clip had no download button anywhere in the product.
 *
 * ── on "I downloaded, but it didn't open" ──
 * Not reproduced; what follows is what the code permitted. This route cannot
 * have been the surface, because before this change it served no clip at all
 * and no control anywhere offered one. What every clip DID have was a
 * `<video src>` pointing straight at the stored 7-day signed URL, and browsers
 * put a Download item on their native video controls — Chrome does. That
 * fetches the `src` directly, and an expired V4 signature answers `403` with an
 * XML `<Error>` body, which is what gets written to disk. The cure for that is
 * the `<video src>` now pointing at `/api/assets/[id]/media`, which re-signs per
 * request; it is not the content-type check below.
 *
 * What the content-type check below is for is this route's own promise: it will
 * not put `Content-Disposition: attachment` on bytes it cannot vouch for. That
 * is a guard against a future dead link, measured from the same 403/XML
 * response shape — not a fix for a click anyone has made.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Staff see everything, a client only its own client's assets, and a locked
  // (future-dated) post refuses for clients — shared with the playback route so
  // the two cannot drift. This is the real gate; the UI helpers are cosmetic.
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
    const name = videos.length > 1 ? `${stem}-${index + 1}` : stem;
    const filename = `${name}.${videoExtFromUrl(videos[index].url)}`;

    // Re-signed from meta.gcsPath per request: the URL stored on the asset is
    // usually expired by the day the clip is shown.
    const source = await resolveAssetVideo(asset, index, { downloadFilename: filename });
    if (!source) {
      return NextResponse.json({ error: "This asset has no video" }, { status: 404 });
    }

    if (source.origin === "signed") {
      // Straight to GCS. The disposition and filename are inside the signature,
      // so the browser saves it under our name even though the redirect is
      // cross-origin and the anchor's `download` attribute is ignored there.
      return new NextResponse(null, {
        status: 302,
        headers: { Location: source.url, "Cache-Control": "private, no-store" },
      });
    }

    // No meta.gcsPath to re-sign from, or signing failed. Proxy it rather than
    // 500 — these are the Firebase-Storage-hosted clips, which are the ones the
    // browser could not fetch cross-origin in the first place.
    const res = await fetchMedia(source.url);
    if (!res.ok || !res.body || !isVideoContentType(res.headers.get("content-type"))) {
      return NextResponse.json({ error: "Could not fetch video" }, { status: 502 });
    }

    const length = res.headers.get("content-length");
    // Streamed, not buffered: a clip is far too large to hold in memory.
    return new NextResponse(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...(length ? { "Content-Length": length } : {}),
        "Cache-Control": "private, no-store",
      },
    });
  }

  // Single photo → stream the raw image. Denylist, not allowlist: an untyped
  // object, or one still carrying the legacy `binary/octet-stream`, is a real
  // photo and must keep working. Only a positive error document is refused.
  if (images.length === 1) {
    const res = await fetchMedia(images[0].url);
    if (!res.ok || isErrorDocumentContentType(res.headers.get("content-type"))) {
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
  const results = await Promise.all(
    images.map(async (img, i) => {
      const name = `${stem}-${i + 1}.${imageExtFromUrl(img.url)}`;
      try {
        const res = await fetchMedia(img.url);
        if (!res.ok || isErrorDocumentContentType(res.headers.get("content-type"))) {
          return { name, ok: false };
        }
        zip.file(name, await res.arrayBuffer());
        return { name, ok: true };
      } catch {
        return { name, ok: false };
      }
    }),
  );

  const missing = results.filter((r) => !r.ok).map((r) => r.name);
  if (missing.length === results.length) {
    return NextResponse.json({ error: "Could not fetch images" }, { status: 502 });
  }

  // A zip that is quietly short a photo is worse than one that says so: the
  // client counts the files against the carousel they approved and has no way
  // to tell a dropped fetch from a post that only ever had four slides.
  if (missing.length > 0) {
    zip.file(
      "MISSING-PHOTOS.txt",
      [
        "This archive is incomplete.",
        "",
        `${missing.length} of ${results.length} photos could not be fetched from storage `
          + `and are not in this zip: ${missing.join(", ")}.`,
        "",
        "Try the download again — if the same photos are still missing, tell your Karos",
        "contact and we'll re-upload them.",
        "",
      ].join("\n"),
    );
  }

  return new NextResponse(await zip.generateAsync({ type: "arraybuffer" }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${stem}.zip"`,
      "Cache-Control": "private, no-store",
      // Machine-readable counterpart to MISSING-PHOTOS.txt, for anyone
      // debugging a "the zip was short" report from the logs.
      ...(missing.length > 0 ? { "X-Karos-Missing-Photos": String(missing.length) } : {}),
    },
  });
}
