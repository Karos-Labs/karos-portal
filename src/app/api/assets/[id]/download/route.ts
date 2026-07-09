import { type NextRequest, NextResponse } from "next/server";
import { getAsset } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import type { Asset } from "@/lib/types";

/**
 * Native download for an asset, chosen by MIME type / requested format:
 *   ?format=text  → the asset copy as a .txt file
 *   ?format=image → the generated visual re-served as a .jpg
 *   ?format=video → the attached video re-served with its own extension
 * With no format we pick the best default: image if there's a visual, else video
 * if there's a video payload, else text. Remote media (Vercel Blob) is proxied so
 * the browser's `download` attribute works (cross-origin downloads are otherwise
 * ignored) and so the file is named/typed sensibly.
 */

function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "asset"
  );
}

/** The video payload URL for an asset, if any (explicit mimeType or a meta field). */
function videoUrl(asset: Asset): string | null {
  const metaUrl = (asset.meta?.videoUrl as string | undefined) ?? (asset.meta?.mediaUrl as string | undefined);
  if (metaUrl && (asset.mimeType?.startsWith("video/") ?? true)) return metaUrl;
  if (asset.mimeType?.startsWith("video/") && asset.imageUrl) return asset.imageUrl;
  return null;
}

function textExport(asset: Asset): string {
  const lines = [asset.title, "", asset.content ?? ""];
  const hashtags = asset.meta?.hashtags as string[] | undefined;
  if (hashtags?.length) lines.push("", hashtags.map((h) => "#" + h).join(" "));
  const cta = asset.meta?.callToAction as string | undefined;
  if (cta) lines.push("", `CTA: ${cta}`);
  return lines.join("\n");
}

async function proxyRemote(url: string, contentType: string, filename: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    return new NextResponse(`Upstream file unavailable (${res.status})`, { status: 502 });
  }
  return new NextResponse(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset) return new NextResponse("Asset not found", { status: 404 });

  // CLIENT_USER may only download their own client's assets.
  if (user.role === "CLIENT_USER" && asset.clientId !== user.clientId) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const video = videoUrl(asset);
  const hasImage = Boolean(asset.imageUrl) && !asset.mimeType?.startsWith("video/");
  const requested = req.nextUrl.searchParams.get("format");
  const format = requested ?? (hasImage ? "image" : video ? "video" : "text");
  const base = slug(asset.title);

  if (format === "image") {
    if (!asset.imageUrl) return new NextResponse("No image on this asset", { status: 404 });
    return proxyRemote(asset.imageUrl, "image/jpeg", `${base}.jpg`);
  }

  if (format === "video") {
    if (!video) return new NextResponse("No video on this asset", { status: 404 });
    const ext = asset.mimeType?.split("/")[1] ?? "mp4";
    return proxyRemote(video, asset.mimeType ?? "video/mp4", `${base}.${ext}`);
  }

  // Default / "other": serve the copy as text.
  return new NextResponse(textExport(asset), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.txt"`,
      "Cache-Control": "private, no-store",
    },
  });
}
