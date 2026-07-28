import { NextResponse } from "next/server";
import JSZip from "jszip";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAsset } from "@/lib/data";
import { assetImages, assetFileStem, imageExtFromUrl } from "@/lib/asset-images";
import { agentServiceFetchHeaders } from "@/lib/agent-service/client";
import { isAssetUnlockedForClient } from "@/lib/post-chain";

export const runtime = "nodejs";

/**
 * Download every image in an asset as a single file — a zip for a multi-photo
 * carousel, or the raw image for a single-photo post. The fetch happens
 * server-side, so it works regardless of the storage host's CORS policy (the
 * browser can't fetch firebasestorage URLs cross-origin, which is why the old
 * client-side download silently produced nothing).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Staff see everything; a client may only download its own client's assets.
  if (!isStaff(user) && user.clientId !== asset.clientId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Future-dated chain posts are withheld from clients until their day arrives
  // (server-local midnight) — same gate as the library's redaction layer.
  if (!isStaff(user) && !isAssetUnlockedForClient(asset, Date.now())) {
    return NextResponse.json(
      // Creation language (§4.1 item 1): "unlocks" tells the caller the file
      // exists and is being withheld. This body reaches a client.
      { error: "This post is created on its scheduled day. It'll be available here that morning." },
      { status: 403 },
    );
  }

  const images = assetImages(asset);
  if (images.length === 0) {
    return NextResponse.json({ error: "This asset has no images" }, { status: 404 });
  }

  const stem = assetFileStem(asset.title || "post");
  const fetchImage = (url: string) => {
    const headers = agentServiceFetchHeaders(url);
    return fetch(url, headers ? { headers } : undefined);
  };

  // Single photo → stream the raw image.
  if (images.length === 1) {
    const res = await fetchImage(images[0].url);
    if (!res.ok) {
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
        const res = await fetchImage(img.url);
        if (!res.ok) return false;
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
