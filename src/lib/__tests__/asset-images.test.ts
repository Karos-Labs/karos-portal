import { describe, expect, it } from "vitest";
import { assetImages, assetFileStem, imageExtFromUrl } from "@/lib/asset-images";
import type { Asset } from "@/lib/types";

/** Minimal Asset with only the fields assetImages reads. */
function asset(partial: Partial<Asset>): Asset {
  return {
    id: "a",
    clientId: "c",
    type: "instagram_post",
    title: "Special edition — 2026-07-08",
    content: "",
    status: "draft",
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as Asset;
}

const url = (n: string) =>
  `https://firebasestorage.googleapis.com/v0/b/x/o/${n}.png?alt=media&token=t`;

describe("assetImages", () => {
  it("lab-import posts expose every photo from meta.images (not just the cover)", () => {
    const images = [url("slide-01"), url("slide-02"), url("slide-03"), url("slide-04"), url("slide-05")];
    const out = assetImages(asset({ imageUrl: images[0], meta: { source: "lab-import", images } }));
    expect(out.map((i) => i.url)).toEqual(images);
    expect(out).toHaveLength(5);
  });

  it("agent-service posts use structured meta.slides with headlines", () => {
    const out = assetImages(
      asset({
        imageUrl: url("s1"),
        meta: {
          slides: [
            { imageUrl: url("s1"), headline: "Hook" },
            { imageUrl: url("s2"), headline: "Body" },
          ],
        },
      }),
    );
    expect(out).toEqual([
      { url: url("s1"), caption: "Hook" },
      { url: url("s2"), caption: "Body" },
    ]);
  });

  it("legacy webhook posts reconstruct photos from meta.artifacts, images only", () => {
    const out = assetImages(
      asset({
        meta: {
          artifacts: [
            { name: "caption.txt", url: url("caption"), contentType: "text/plain" },
            { name: "slide-02.png", url: url("b"), contentType: "image/png" },
            { name: "slide-01.png", url: url("a"), contentType: "image/png" },
          ],
        },
      }),
    );
    // Text artifact dropped; images natural-sorted slide-01 before slide-02.
    expect(out.map((i) => i.url)).toEqual([url("a"), url("b")]);
  });

  it("natural-sorts so slide-2 precedes slide-10", () => {
    const files = [
      { name: "slide-10.png", url: url("ten") },
      { name: "slide-2.png", url: url("two") },
      { name: "slide-1.png", url: url("one") },
    ];
    const out = assetImages(asset({ meta: { files } }));
    expect(out.map((i) => i.url)).toEqual([url("one"), url("two"), url("ten")]);
  });

  it("falls back to meta.files when there is no meta.images list", () => {
    const files = [
      { name: "about.txt", relPath: "01/about.txt", url: url("about") },
      { name: "slide-01.png", relPath: "01/slide-01.png", url: url("s1") },
      { name: "slide-02.png", relPath: "01/slide-02.png", url: url("s2") },
    ];
    const out = assetImages(asset({ meta: { source: "lab-import", files } }));
    expect(out.map((i) => i.url)).toEqual([url("s1"), url("s2")]);
  });

  it("dedupes when files and artifacts overlap by url", () => {
    const shared = url("dup");
    const out = assetImages(
      asset({
        meta: {
          files: [{ name: "slide-01.png", url: shared }],
          artifacts: [{ name: "slide-01.png", url: shared, contentType: "image/png" }],
        },
      }),
    );
    expect(out).toHaveLength(1);
  });

  it("single-photo post returns just the cover", () => {
    const out = assetImages(asset({ imageUrl: url("cover") }));
    expect(out).toEqual([{ url: url("cover"), caption: "Special edition — 2026-07-08" }]);
  });

  it("a lone image file is treated as a single cover, not a 1-item carousel", () => {
    const out = assetImages(
      asset({ imageUrl: url("cover"), meta: { files: [{ name: "slide-01.png", url: url("only") }] } }),
    );
    expect(out).toEqual([{ url: url("cover"), caption: "Special edition — 2026-07-08" }]);
  });

  it("no images anywhere → empty", () => {
    expect(assetImages(asset({ imageUrl: null, meta: {} }))).toEqual([]);
  });

  it("prefers structured slides even when meta.images also present", () => {
    const out = assetImages(
      asset({
        meta: {
          slides: [{ imageUrl: url("real"), headline: "H" }],
          images: [url("stale-1"), url("stale-2")],
        },
      }),
    );
    expect(out).toEqual([{ url: url("real"), caption: "H" }]);
  });
});

describe("assetFileStem / imageExtFromUrl", () => {
  it("slugifies a title into a safe filename stem", () => {
    expect(assetFileStem("Special edition — 2026-07-08!")).toBe("special-edition-2026-07-08");
    expect(assetFileStem("")).toBe("post");
  });

  it("reads the extension from a query-string blob URL, defaulting to jpg", () => {
    expect(imageExtFromUrl(url("slide-01"))).toBe("png");
    expect(imageExtFromUrl("https://x/o/a.jpeg?alt=media")).toBe("jpg");
    expect(imageExtFromUrl("https://x/o/noext?alt=media")).toBe("jpg");
  });
});
