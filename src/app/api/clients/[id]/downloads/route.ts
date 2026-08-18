import { NextResponse } from "next/server";
import JSZip from "jszip";
import { getCurrentUser } from "@/lib/auth";
import { canViewClient } from "@/lib/client-visibility";
import { getClient, listAssets } from "@/lib/data";
import { assetImages, assetVideos, assetFileStem, imageExtFromUrl } from "@/lib/asset-images";
import { agentServiceFetchHeaders } from "@/lib/agent-service/client";
import { isErrorDocumentContentType } from "@/lib/media-type";
import { startOfDayMs } from "@/lib/scheduling";

export const runtime = "nodejs";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(param: string | null): number {
  if (param) {
    const parsed = new Date(`${param}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return startOfDayMs(parsed.getTime());
  }
  return startOfDayMs(Date.now());
}

function uniqueNamer() {
  const used = new Set<string>();
  return (base: string) => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let n = 2;
    let candidate = `${stem}-${n}${ext}`;
    while (used.has(candidate)) candidate = `${stem}-${++n}${ext}`;
    used.add(candidate);
    return candidate;
  };
}

/**
 * Surface 07 (Downloads / Exports). One button, one day of this client's
 * content, one zip — everything generated/scheduled/published for the given
 * calendar day, as the SOW's "day of content" is read here: the day identity
 * already used elsewhere in the codebase (scheduling.ts's `startOfDayMs`,
 * runtime-local — see its docstring on why that is the accepted day
 * definition until a client IANA zone exists).
 *
 * Clips are DELIBERATELY EXCLUDED from the zip's bytes, for the same reason
 * the single-asset download route (`/api/assets/[id]/download`) redirects to
 * a signed URL instead of proxying video: a clip can be gigabytes, and
 * buffering several of them into one in-memory zip on a day with multiple
 * video posts risks the same Cloud Run request-timeout / memory ceiling that
 * route's docstring lays out. A day's videos are named in
 * VIDEOS-NOT-INCLUDED.txt instead, pointing back at their own download route.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not authorized" }, { status: 401 });

  const client = await getClient(id);
  if (!client || !canViewClient(user, client)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const query = new URL(req.url).searchParams;
  const dayStart = parseDay(query.get("date"));
  if (dayStart > startOfDayMs(Date.now())) {
    return NextResponse.json(
      { error: "Cannot download a day that hasn't happened yet" },
      { status: 400 },
    );
  }
  const dayEnd = dayStart + DAY_MS;

  const assets = await listAssets({ clientId: id });
  const dayAssets = assets.filter((a) => {
    const at = a.publishedAt ?? a.scheduledAt ?? a.createdAt;
    return at >= dayStart && at < dayEnd;
  });

  if (dayAssets.length === 0) {
    return NextResponse.json({ error: "No content for that day yet" }, { status: 404 });
  }

  const fetchMedia = (url: string) => {
    const headers = agentServiceFetchHeaders(url);
    return fetch(url, headers ? { headers } : undefined);
  };

  const zip = new JSZip();
  const nameFor = uniqueNamer();
  const missingImages: string[] = [];
  const skippedVideos: string[] = [];

  await Promise.all(
    dayAssets.map(async (asset) => {
      const stem = assetFileStem(asset.title || "post");
      zip.file(nameFor(`${stem}.txt`), asset.content || "");

      const images = assetImages(asset);
      await Promise.all(
        images.map(async (img, i) => {
          const name = nameFor(
            `${stem}${images.length > 1 ? `-${i + 1}` : ""}.${imageExtFromUrl(img.url)}`,
          );
          try {
            const res = await fetchMedia(img.url);
            if (res.ok && !isErrorDocumentContentType(res.headers.get("content-type"))) {
              zip.file(name, await res.arrayBuffer());
            } else {
              missingImages.push(name);
            }
          } catch {
            missingImages.push(name);
          }
        }),
      );

      if (assetVideos(asset).length > 0) {
        skippedVideos.push(`${stem} — download from its own post in the app`);
      }
    }),
  );

  if (missingImages.length > 0) {
    zip.file(
      "MISSING-PHOTOS.txt",
      [`${missingImages.length} photo(s) could not be fetched:`, "", ...missingImages].join("\n"),
    );
  }
  if (skippedVideos.length > 0) {
    zip.file(
      "VIDEOS-NOT-INCLUDED.txt",
      [
        "Video clips are not bundled into this zip — download them individually",
        "from their post so large transfers don't time out.",
        "",
        ...skippedVideos,
      ].join("\n"),
    );
  }

  const dateLabel = new Date(dayStart).toISOString().slice(0, 10);
  const clientLabel = client.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "content";
  return new NextResponse(await zip.generateAsync({ type: "arraybuffer" }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${clientLabel}-${dateLabel}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
