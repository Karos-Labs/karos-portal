import "server-only";

import { uploadBytes } from "@/lib/storage";
import type { ContentEngineConfig } from "./types";

/**
 * Real web-image sourcing for the content engine (replaces AI generation).
 *
 * Pulls a real photograph from Pexels (commercial-use license, no watermark),
 * filters it against the client's sourcing rules (min long-edge, aspect window,
 * blocked domains), validates it's actually an image (magic bytes), and re-hosts
 * it to Firebase Storage so the asset has a durable URL. Returns null when no
 * candidate passes — callers should treat that as "no image for this slide",
 * never silently ship a wrong one.
 */

export function imageSourcingConfigured(): boolean {
  return Boolean(process.env.PEXELS_API_KEY);
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    portrait: string;
    landscape: string;
  };
}

export interface SourcedImage {
  url: string;
  attribution: string;
  sourceUrl: string;
}

/** JPEG / PNG / GIF / WebP / BMP magic-byte sniff (anti-scraping HTML masquerading as an image). */
function isImageMagic(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return true; // WebP
  if (b[0] === 0x42 && b[1] === 0x4d) return true; // BMP
  return false;
}

export async function sourceSlideImage(args: {
  query: string;
  key: string;
  config: ContentEngineConfig;
}): Promise<SourcedImage | null> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) throw new Error("PEXELS_API_KEY is not set");
  const { query, key, config } = args;

  const s = config.sourcing;
  const minLongEdge = s?.minLongEdge ?? 1080;
  const aspectMin = s?.aspectMin ?? 0.5;
  const aspectMax = s?.aspectMax ?? 2.2;
  const blocked = s?.blockedDomains ?? [];
  // Portrait for a taller-than-wide canvas (XO is 3:4); else landscape.
  const orientation = config.canvas && config.canvas.h > config.canvas.w ? "portrait" : "landscape";

  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=${orientation}`,
    { headers: { Authorization: apiKey } },
  );
  if (!res.ok) throw new Error(`Pexels search failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);

  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  const candidate = pickCandidate(data.photos ?? [], { minLongEdge, aspectMin, aspectMax, blocked });
  if (!candidate) return null;

  // Prefer the cropped variant that matches the canvas; fall back to large.
  const pickUrl =
    (orientation === "portrait" ? candidate.src.portrait : candidate.src.landscape) ||
    candidate.src.large2x ||
    candidate.src.large;

  const img = await fetch(pickUrl);
  if (!img.ok) return null;
  if (!(img.headers.get("content-type") ?? "").startsWith("image/")) return null;
  const bytes = Buffer.from(await img.arrayBuffer());
  if (!isImageMagic(bytes)) return null;

  const { url } = await uploadBytes({ bytes, path: `assets/${key}.jpg`, contentType: "image/jpeg" });
  return { url, attribution: `Photo by ${candidate.photographer} on Pexels`, sourceUrl: candidate.url };
}

/** Exported for unit testing: first photo passing the client's sourcing filters. */
export function pickCandidate(
  photos: PexelsPhoto[],
  filt: { minLongEdge: number; aspectMin: number; aspectMax: number; blocked: string[] },
): PexelsPhoto | null {
  for (const p of photos) {
    if (!p || !p.width || !p.height || !p.src?.original) continue;
    const longEdge = Math.max(p.width, p.height);
    const aspect = p.width / p.height;
    if (longEdge < filt.minLongEdge) continue;
    if (aspect < filt.aspectMin || aspect > filt.aspectMax) continue;
    if (filt.blocked.some((d) => d && p.src.original.includes(d))) continue;
    return p;
  }
  return null;
}
