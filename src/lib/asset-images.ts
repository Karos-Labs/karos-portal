import type { Asset } from "@/lib/types";

/** A viewable/downloadable photo in an asset, in slide order. */
export type AssetImage = { url: string; caption?: string };

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

type SlideMeta = { headline?: string; imageUrl?: string | null };
type MetaArtifact = { name?: string; url?: string; contentType?: string };

/**
 * Every photo in an asset, in order. A carousel post exposes its slides in
 * `meta.slides`; posts ingested before that field existed still carry every
 * image in `meta.artifacts` (natural-sorted so slide-2 precedes slide-10); a
 * plain post has just the single cover `imageUrl`. Kept client-safe (no
 * server-only imports) so both the asset card and the download route share it.
 */
export function assetImages(asset: Asset): AssetImage[] {
  const slides = (asset.meta?.slides as SlideMeta[] | undefined)?.filter(Boolean) ?? [];
  if (slides.length > 0) {
    return slides
      .filter((s) => s.imageUrl)
      .map((s, i) => ({ url: s.imageUrl as string, caption: s.headline ?? `Slide ${i + 1}` }));
  }

  const artifactImages = ((asset.meta?.artifacts as MetaArtifact[] | undefined) ?? [])
    .filter(
      (a) => a?.url && (a.contentType?.startsWith("image/") || (a.name && IMAGE_EXT.test(a.name))),
    )
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { numeric: true }));
  if (artifactImages.length > 1) {
    return artifactImages.map((a) => ({ url: a.url as string }));
  }

  if (asset.imageUrl) return [{ url: asset.imageUrl, caption: asset.title }];
  return [];
}

/** Slugify an asset title into a safe download filename stem. */
export function assetFileStem(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "post"
  );
}

/** Best-guess image extension from a URL, defaulting to jpg. */
export function imageExtFromUrl(url: string): string {
  const m = url.split("?")[0].match(/\.(png|jpe?g|webp|gif|avif)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}
