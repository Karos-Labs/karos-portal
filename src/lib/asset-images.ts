import type { Asset } from "@/lib/types";

/** A viewable/downloadable photo in an asset, in slide order. */
export type AssetImage = { url: string; caption?: string };

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

type SlideMeta = { headline?: string; imageUrl?: string | null };
/** A file entry from meta.artifacts (agent-service) or meta.files (lab import). */
type MetaFile = { name?: string; relPath?: string; path?: string; url?: string; contentType?: string };

function isImageFile(f: MetaFile): boolean {
  if (f.contentType?.startsWith("image/")) return true;
  const path = f.name ?? f.relPath ?? f.path ?? "";
  return IMAGE_EXT.test(path);
}

/** Natural-sort key for a file entry (so slide-2 precedes slide-10). */
function fileKey(f: MetaFile): string {
  return f.name ?? f.relPath ?? f.path ?? "";
}

/**
 * Every photo in an asset, in slide order. Handles every ingest shape:
 *   • meta.slides   — content-engine & agent-service carousels (photo + copy)
 *   • meta.images   — lab-imported posts (a flat, ordered list of hosted URLs)
 *   • meta.files /
 *     meta.artifacts — image files from an import / legacy webhook post,
 *                      natural-sorted by filename
 *   • imageUrl      — a plain single-photo post
 * Kept client-safe (no server-only imports) so both the asset card and the
 * download route share exactly one definition of "the post's photos".
 */
export function assetImages(asset: Asset): AssetImage[] {
  const meta = asset.meta ?? {};

  // 1. Structured slides carry a photo (and often a headline) per slide.
  const slidesWithPhotos = ((meta.slides as SlideMeta[] | undefined) ?? [])
    .filter((s) => s?.imageUrl);
  if (slidesWithPhotos.length > 0) {
    return slidesWithPhotos.map((s, i) => ({
      url: s.imageUrl as string,
      caption: s.headline ?? `Slide ${i + 1}`,
    }));
  }

  // 2. Lab imports keep an ordered list of hosted image URLs.
  const images = ((meta.images as unknown[] | undefined) ?? []).filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  if (images.length > 0) {
    return images.map((url, i) => ({ url, caption: `Slide ${i + 1}` }));
  }

  // 3. Otherwise pull image files out of the artifact/file list.
  const files = [
    ...((meta.files as MetaFile[] | undefined) ?? []),
    ...((meta.artifacts as MetaFile[] | undefined) ?? []),
  ];
  const seen = new Set<string>();
  const fileImages = files
    .filter((f) => f?.url && isImageFile(f))
    .sort((a, b) => fileKey(a).localeCompare(fileKey(b), undefined, { numeric: true }))
    .map((f) => f.url as string)
    .filter((url) => (seen.has(url) ? false : seen.add(url)));
  if (fileImages.length > 1) {
    return fileImages.map((url, i) => ({ url, caption: `Slide ${i + 1}` }));
  }

  // 4. Single-photo post — prefer the explicit cover, else the lone file image.
  if (asset.imageUrl) return [{ url: asset.imageUrl, caption: asset.title }];
  if (fileImages.length === 1) return [{ url: fileImages[0], caption: asset.title }];
  return [];
}

/* ── Video deliverables ──────────────────────────────────────────────── */

/** A playable clip attached to an asset. */
export type AssetVideo = { url: string; name?: string };

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;

function isVideoFile(f: MetaFile): boolean {
  if (f.contentType?.startsWith("video/")) return true;
  return VIDEO_EXT.test(f.name ?? f.relPath ?? f.path ?? "");
}

/**
 * Every clip in an asset, in file order — the portal-side half of the video
 * deliverable path (QA F150 / call directive D1). Three sources, in priority:
 *
 *   • asset.videoUrl   — the storage-URL field; clips live in GCS block storage
 *                        and the agent service fetches from there. Populating
 *                        it is the infra half (Tomer); the portal only has to
 *                        render whatever URL lands in it.
 *   • meta.videos      — an ordered list of hosted clip URLs (lab imports).
 *   • meta.files /
 *     meta.artifacts   — video files from a webhook run, natural-sorted.
 *
 * Client-safe (no server-only imports), like assetImages.
 */
export function assetVideos(asset: Asset): AssetVideo[] {
  const meta = asset.meta ?? {};
  const out: AssetVideo[] = [];
  const seen = new Set<string>();
  const push = (url: string, name?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(name ? { url, name } : { url });
  };

  if (asset.videoUrl) push(asset.videoUrl, asset.title);

  for (const url of (meta.videos as unknown[] | undefined) ?? []) {
    if (typeof url === "string") push(url);
  }

  const files = [
    ...((meta.files as MetaFile[] | undefined) ?? []),
    ...((meta.artifacts as MetaFile[] | undefined) ?? []),
  ];
  files
    .filter((f) => f?.url && isVideoFile(f))
    .sort((a, b) => fileKey(a).localeCompare(fileKey(b), undefined, { numeric: true }))
    .forEach((f) => push(f.url as string, f.name ?? f.relPath ?? f.path));

  return out;
}

/* ── LinkedIn reader media ───────────────────────────────────────────── */

/** A media file offered to the LinkedIn per-draft reader. */
export type AssetMediaFile = { name: string; url: string };

const LI_MEDIA_EXT = /\.(png|jpe?g|gif|webp|pdf|mp4|mov|webm)$/i;

/**
 * The run's attachable media for the LinkedIn drafts reader. One definition
 * shared by the asset card and the detail modal — it used to be copy-pasted
 * into both (QA F150 rescope).
 *
 * Only durable re-hosted links qualify: a failed re-host leaves an auth-gated
 * agent-service URL a browser can't open. The service may omit content_type,
 * so extension sniffing is the fallback.
 */
export function assetLiMedia(meta: Record<string, unknown> | undefined): AssetMediaFile[] {
  const artifacts = (meta?.artifacts as MetaFile[] | undefined) ?? [];
  return artifacts
    .filter((a): a is MetaFile & { name: string; url: string } => {
      if (!a?.name || !a.url) return false;
      if (!a.url.includes("firebasestorage.googleapis.com")) return false;
      if (a.contentType) {
        return (
          a.contentType.startsWith("image/") ||
          a.contentType === "application/pdf" ||
          a.contentType.startsWith("video/")
        );
      }
      return LI_MEDIA_EXT.test(a.name);
    })
    .map((a) => ({ name: a.name, url: a.url }));
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
