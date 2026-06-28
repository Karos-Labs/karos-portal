import "server-only";

import { uploadBytes } from "@/lib/storage";
import type { ContentEngineConfig } from "./types";

/**
 * Real web-image sourcing for the content engine (replaces AI generation).
 *
 * Runs an Apify Google Images scraper actor for the slide's search query,
 * filters the results against the client's sourcing rules (min long-edge,
 * aspect window, blocked domains), validates the chosen result is actually an
 * image (magic bytes), and re-hosts it to Firebase Storage so the asset has a
 * durable URL. Returns null when no candidate passes — callers should treat
 * that as "no image for this slide", never silently ship a wrong one.
 *
 * The actor is swappable via APIFY_IMAGE_ACTOR (default hooli~google-images-scraper);
 * any actor that returns dataset items carrying an image URL + pixel dimensions works.
 * NOTE: scraped web images are arbitrary photos — unlike Pexels they carry no
 * commercial-use guarantee, so attribution credits the source page, not a licensor.
 */

const DEFAULT_ACTOR = "hooli~google-images-scraper";
/** Cap on how long a single slide's scrape may run before we give up and move on. */
const RUN_TIMEOUT_MS = 120_000;

export function imageSourcingConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN);
}

/** Normalized shape we reduce any actor's dataset item down to. */
interface ImageCandidate {
  imageUrl: string;
  width: number;
  height: number;
  /** Page the image was found on (for attribution + blocked-domain checks). */
  sourceUrl: string;
  /** Human-readable source (domain or site name). */
  source: string;
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

function asNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Reduce one raw Apify dataset item to our common shape. Google-image actors
 * vary in field naming, so we accept the usual aliases for each field; an item
 * without a usable image URL + dimensions is dropped (we can't quality-gate it).
 */
function normalizeItem(item: Record<string, unknown>): ImageCandidate | null {
  const imageUrl =
    asStr(item.imageUrl) ?? asStr(item.url) ?? asStr(item.src) ?? asStr(item.image) ?? asStr(item.contentUrl);
  const width = asNum(item.imageWidth) ?? asNum(item.width);
  const height = asNum(item.imageHeight) ?? asNum(item.height);
  if (!imageUrl || !width || !height) return null;
  const sourceUrl = asStr(item.sourceUrl) ?? asStr(item.pageUrl) ?? asStr(item.hostPageUrl) ?? asStr(item.link) ?? imageUrl;
  const source = asStr(item.source) ?? asStr(item.displayLink) ?? hostOf(sourceUrl);
  return { imageUrl, width, height, sourceUrl, source: source || "the web" };
}

export async function sourceSlideImage(args: {
  query: string;
  key: string;
  config: ContentEngineConfig;
}): Promise<SourcedImage | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN is not set");
  const actor = process.env.APIFY_IMAGE_ACTOR || DEFAULT_ACTOR;
  const { query, key, config } = args;

  const s = config.sourcing;
  const minLongEdge = s?.minLongEdge ?? 1080;
  const aspectMin = s?.aspectMin ?? 0.5;
  const aspectMax = s?.aspectMax ?? 2.2;
  const blocked = s?.blockedDomains ?? [];

  // Synchronous run: kick the actor and get its dataset items back in one call.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: [query], maxResultsPerQuery: 25 }),
        signal: ctrl.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Apify run failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);

  const items = (await res.json()) as unknown;
  const raw = Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  const candidates = raw.map(normalizeItem).filter((c): c is ImageCandidate => c !== null);
  const candidate = pickCandidate(candidates, { minLongEdge, aspectMin, aspectMax, blocked });
  if (!candidate) return null;

  const img = await fetch(candidate.imageUrl, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!img || !img.ok) return null;
  if (!(img.headers.get("content-type") ?? "").startsWith("image/")) return null;
  const bytes = Buffer.from(await img.arrayBuffer());
  if (!isImageMagic(bytes)) return null;

  const { url } = await uploadBytes({ bytes, path: `assets/${key}.jpg`, contentType: "image/jpeg" });
  return { url, attribution: `Photo via ${candidate.source}`, sourceUrl: candidate.sourceUrl };
}

/** Exported for unit testing: first candidate passing the client's sourcing filters. */
export function pickCandidate(
  candidates: ImageCandidate[],
  filt: { minLongEdge: number; aspectMin: number; aspectMax: number; blocked: string[] },
): ImageCandidate | null {
  for (const c of candidates) {
    const longEdge = Math.max(c.width, c.height);
    const aspect = c.width / c.height;
    if (longEdge < filt.minLongEdge) continue;
    if (aspect < filt.aspectMin || aspect > filt.aspectMax) continue;
    if (filt.blocked.some((d) => d && (c.imageUrl.includes(d) || c.sourceUrl.includes(d)))) continue;
    return c;
  }
  return null;
}
