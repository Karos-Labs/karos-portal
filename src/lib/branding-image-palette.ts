import "server-only";

import { inflateSync } from "node:zlib";

/**
 * The colours an image ACTUALLY contains, counted pixel by pixel.
 *
 * ## Why this exists
 *
 * `branding-site-palette.ts` reads what a site DECLARES. That turned out not to
 * be the same question as what it PAINTS. karoslabs.com declares
 * `--primary: #2f6bff` and `--ring: #2f6bff` in `:root`; a sweep of the
 * rendered DOM finds that blue on zero elements. It is a leftover scaffold
 * default, and it is the entire reason that client's brand guidelines said
 * "blue" — a claim no amount of reading CSS can refute, because the CSS really
 * does say it.
 *
 * A rendered screenshot settles it. This decodes one and returns the colours
 * by the area they cover, which is the measurement "is this colour part of the
 * brand" actually needs.
 *
 * ## Scope, deliberately narrow
 *
 * Handles 8-bit truecolour PNG (colour types 2 and 6), non-interlaced — what
 * every headless-browser screenshot API emits. Anything else returns `null`
 * rather than a guess, and every caller treats `null` as "no observations,
 * change nothing". Decoding the long tail of the PNG spec would be a lot of
 * code to support inputs this pipeline never receives.
 *
 * No dependency: `node:zlib` is the only thing a PNG needs that JavaScript does
 * not already have. `sharp` would do this and more, but it is a native module
 * on the Cloud Run image's critical path, and this is ~100 lines.
 */

/** One colour measured in an image, with the share of the image it covers. */
export interface ImageColor {
  /** 6-digit lowercase hex. */
  hex: string;
  /** Fraction of sampled, sufficiently-opaque pixels with this colour, 0–1. */
  share: number;
}

/** PNG's five per-scanline filter types, undone below. */
const enum Filter {
  None = 0,
  Sub = 1,
  Up = 2,
  Average = 3,
  Paeth = 4,
}

/**
 * Channel quantisation, in levels per channel.
 *
 * Antialiased text and gradients smear one design colour across hundreds of
 * near-identical values; counted raw, a flat brand colour loses to its own
 * blur. Bucketing to 16 levels (steps of 17) collapses that back together while
 * keeping colours a designer would call different apart.
 */
const LEVELS = 16;
const STEP = 255 / (LEVELS - 1);

/** Below this alpha a pixel is not really on screen and must not vote. */
const MIN_ALPHA = 128;

/** Cap on sampled pixels. A full-page screenshot is megapixels; the palette is not more accurate for counting all of them. */
const MAX_SAMPLES = 400_000;

function quantize(value: number): number {
  return Math.round(Math.round(value / STEP) * STEP);
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface Header {
  width: number;
  height: number;
  channels: number;
}

/** Reads IHDR and concatenates every IDAT. Returns null for anything outside the supported subset. */
function readChunks(png: Buffer): { header: Header; data: Buffer } | null {
  const SIGNATURE = "89504e470d0a1a0a";
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== SIGNATURE) return null;

  let offset = 8;
  let header: Header | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (offset + 12 + length > png.length) break;

    if (type === "IHDR") {
      const bitDepth = body.readUInt8(8);
      const colorType = body.readUInt8(9);
      const interlace = body.readUInt8(12);
      // 2 = truecolour, 6 = truecolour + alpha. Palette, grayscale, 16-bit and
      // Adam7 interlacing are all real PNG and none of them arrive here.
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) return null;
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), channels: colorType === 6 ? 4 : 3 };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (!header || header.width <= 0 || header.height <= 0 || idat.length === 0) return null;
  return { header, data: Buffer.concat(idat) };
}

/**
 * A PNG's pixel dimensions, or null if it cannot be read.
 *
 * Needed because the two consumers of a screenshot have different limits: this
 * file decodes any size, while Anthropic rejects an image whose longest side
 * exceeds 8000px — which a full-page render of a long marketing site easily
 * does (deel.com/the-pitch-by-deel did).
 */
export function pngDimensions(png: Buffer): { width: number; height: number } | null {
  try {
    const parsed = readChunks(png);
    return parsed ? { width: parsed.header.width, height: parsed.header.height } : null;
  } catch {
    return null;
  }
}

/**
 * The colours a PNG screenshot actually paints, most area first.
 *
 * Returns `[]` for an image this cannot decode or that yields nothing — never
 * throws. Branding is a non-fatal side pipeline; an unreadable screenshot must
 * cost a run nothing.
 */
export function paletteFromPng(png: Buffer, limit = 12): ImageColor[] {
  let parsed: { header: Header; data: Buffer } | null;
  try {
    parsed = readChunks(png);
  } catch {
    return [];
  }
  if (!parsed) return [];

  const { width, height, channels } = parsed.header;
  let raw: Buffer;
  try {
    raw = inflateSync(parsed.data);
  } catch {
    return [];
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return [];

  // Sample every Nth row and column rather than decoding a full-page shot pixel
  // by pixel. Unfiltering still has to walk every row (each depends on the one
  // above), but counting does not.
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)));
  const counts = new Map<string, number>();
  /** bucket -> (exact hex -> how often seen), so a bucket can report a colour that really occurs. */
  const exactByBucket = new Map<string, Map<string, number>>();
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  let total = 0;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    raw.copy(current, 0, rowStart + 1, rowStart + 1 + stride);

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      switch (filter) {
        case Filter.Sub:
          current[i] = (current[i]! + left) & 0xff;
          break;
        case Filter.Up:
          current[i] = (current[i]! + up) & 0xff;
          break;
        case Filter.Average:
          current[i] = (current[i]! + ((left + up) >> 1)) & 0xff;
          break;
        case Filter.Paeth:
          current[i] = (current[i]! + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          break; // Filter.None, and any byte the encoder should never emit.
      }
    }

    if (y % step === 0) {
      for (let x = 0; x < width; x += step) {
        const i = x * channels;
        if (channels === 4 && current[i + 3]! < MIN_ALPHA) continue;
        const bucket = toHex(quantize(current[i]!), quantize(current[i + 1]!), quantize(current[i + 2]!));
        const exact = toHex(current[i]!, current[i + 1]!, current[i + 2]!);
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
        // Quantisation decides which pixels belong TOGETHER; it must never
        // decide what the colour IS. Reporting the bucket centre would emit
        // `#ff6633` for a site whose accent is `#ff6b2c` — a hex that exists
        // nowhere, which is the class of bug this whole pipeline exists to
        // stop. So each bucket also remembers the exact values it saw and
        // reports its most common one.
        const seen = exactByBucket.get(bucket) ?? new Map<string, number>();
        seen.set(exact, (seen.get(exact) ?? 0) + 1);
        exactByBucket.set(bucket, seen);
        total++;
      }
    }

    current.copy(previous);
  }

  if (total === 0) return [];
  const modal = (bucket: string): string => {
    const seen = exactByBucket.get(bucket);
    if (!seen) return bucket;
    let best = bucket;
    let bestCount = -1;
    for (const [hex, count] of seen) {
      if (count > bestCount || (count === bestCount && hex < best)) {
        best = hex;
        bestCount = count;
      }
    }
    return best;
  };

  return [...counts.entries()]
    .map(([bucket, count]) => ({ hex: modal(bucket), share: count / total }))
    .sort((a, b) => b.share - a.share || a.hex.localeCompare(b.hex))
    .slice(0, limit);
}
