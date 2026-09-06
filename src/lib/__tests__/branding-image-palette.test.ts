import { vi, describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";

vi.mock("server-only", () => ({}));

const { paletteFromPng } = await import("../branding-image-palette");

/**
 * Builds a non-interlaced 8-bit PNG with the given per-pixel RGB rows, using
 * filter type 0 so the fixture exercises the decode path without depending on
 * an encoder. `filter` overrides the per-row filter byte where a test wants to
 * exercise unfiltering.
 */
function makePng(rows: number[][][], filter = 0): Buffer {
  const height = rows.length;
  const width = rows[0]!.length;
  const stride = width * 3;

  const ihdrBody = Buffer.alloc(13);
  ihdrBody.writeUInt32BE(width, 0);
  ihdrBody.writeUInt32BE(height, 4);
  ihdrBody.writeUInt8(8, 8); // bit depth
  ihdrBody.writeUInt8(2, 9); // colour type: truecolour
  ihdrBody.writeUInt8(0, 12); // interlace: none

  const rawRows: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (const row of rows) {
    const line = Buffer.alloc(stride);
    row.forEach(([r, g, b], x) => {
      line[x * 3] = r!;
      line[x * 3 + 1] = g!;
      line[x * 3 + 2] = b!;
    });
    const encoded = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      // Only "Up" is encoded here; every other fixture uses filter 0.
      encoded[i] = filter === 2 ? (line[i]! - previous[i]! + 256) & 0xff : line[i]!;
    }
    rawRows.push(Buffer.concat([Buffer.from([filter]), encoded]));
    previous = line;
  }

  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    // CRC is not validated by the decoder, so a zero placeholder is honest here.
    return Buffer.concat([length, Buffer.from(type, "ascii"), body, Buffer.alloc(4)]);
  };

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdrBody),
    chunk("IDAT", deflateSync(Buffer.concat(rawRows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CHARCOAL: [number, number, number] = [0x1a, 0x1a, 0x1a];
const ORANGE: [number, number, number] = [0xff, 0x6b, 0x2c];

describe("paletteFromPng", () => {
  it("returns colours ordered by the area they cover", () => {
    // Three quarters charcoal, one quarter orange — the shape of a dark site
    // with a rationed accent.
    const rows = Array.from({ length: 4 }, (_, y) =>
      Array.from({ length: 4 }, (_, x) => (y === 0 && x < 4 ? ORANGE : CHARCOAL) as number[]),
    );
    const palette = paletteFromPng(makePng(rows));

    expect(palette[0]!.hex).toBe("#1a1a1a");
    expect(palette[0]!.share).toBeCloseTo(0.75, 2);
    expect(palette[1]!.hex).toBe("#ff6b2c");
    expect(palette[1]!.share).toBeCloseTo(0.25, 2);
  });

  it("undoes the Up filter rather than reporting filtered bytes as colours", () => {
    const rows = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => CHARCOAL as number[]));
    const palette = paletteFromPng(makePng(rows, 2));
    expect(palette[0]!.hex).toBe("#1a1a1a");
    expect(palette[0]!.share).toBe(1);
  });

  it("collapses antialiasing onto the design colour instead of splitting it", () => {
    // Text rendered on a dark ground smears one colour across dozens of
    // near-identical values. Counted raw, the flat brand colour loses to its
    // own blur and never reaches the palette.
    // A flat run of the real accent plus a fringe of near-misses, which is what
    // antialiased text on a solid ground actually produces.
    const rows = Array.from({ length: 4 }, (_, y) =>
      Array.from({ length: 4 }, (_, x) =>
        (x === 3 ? [0xff - (y + 1), 0x6b + (y % 2), 0x2c - (y % 2)] : ORANGE) as number[],
      ),
    );
    const palette = paletteFromPng(makePng(rows));

    // One bucket, and it reports the colour the site really uses — not the
    // quantisation grid point, and not one of the blur values.
    expect(palette).toHaveLength(1);
    expect(palette[0]!.hex).toBe("#ff6b2c");
    expect(palette[0]!.share).toBe(1);
  });

  it("returns nothing for input it cannot decode, rather than guessing", () => {
    // Every caller reads `[]` as "no observations, change nothing". A wrong
    // palette here would confidently rewrite a client's brand.
    expect(paletteFromPng(Buffer.from("not a png"))).toEqual([]);
    expect(paletteFromPng(Buffer.alloc(0))).toEqual([]);
    // Valid signature, truncated body.
    expect(paletteFromPng(Buffer.from("89504e470d0a1a0a", "hex"))).toEqual([]);
  });

  it("refuses a PNG outside the supported subset instead of misreading it", () => {
    // Colour type 3 (palette) would decode to nonsense under a truecolour
    // reader, and nonsense is worse here than nothing.
    const png = makePng([[CHARCOAL as number[]]]);
    png.writeUInt8(3, 8 + 8 + 9); // IHDR colour type
    expect(paletteFromPng(png)).toEqual([]);
  });
});
