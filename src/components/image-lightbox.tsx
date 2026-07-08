"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";

export type LightboxImage = { url: string; caption?: string };

/** Slugify a caption/title into a safe download filename stem. */
function fileStem(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image"
  );
}

/** Best-guess file extension from a blob URL, defaulting to jpg. */
function extFromUrl(url: string): string {
  const m = url.split("?")[0].match(/\.(png|jpe?g|webp|gif|avif)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

/**
 * Full-screen image viewer. Pages through every picture in an asset with
 * arrow keys / on-screen chevrons and downloads the current image.
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  name,
}: {
  images: LightboxImage[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** Base name for downloaded files (e.g. the asset title). */
  name?: string;
}) {
  const [downloading, setDownloading] = React.useState(false);
  const count = images.length;
  const current = images[index];

  const go = React.useCallback(
    (delta: number) => {
      if (count < 2) return;
      onIndexChange((index + delta + count) % count);
    },
    [count, index, onIndexChange],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [go, onClose]);

  async function handleDownload() {
    if (!current) return;
    const filename = `${fileStem(name ?? current.caption ?? "image")}${
      count > 1 ? `-${index + 1}` : ""
    }.${extFromUrl(current.url)}`;
    setDownloading(true);
    try {
      // Fetch → blob so cross-origin (Vercel Blob) URLs actually download
      // instead of navigating; falls back to a plain link if that fails.
      const res = await fetch(current.url);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      const a = document.createElement("a");
      a.href = current.url;
      a.download = filename;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setDownloading(false);
    }
  }

  if (!current) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 p-4">
        <span className="font-mono text-xs text-white/70">
          {count > 1 ? `${index + 1} / ${count}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50"
          >
            <Icon name={downloading ? "Loader" : "Download"} className={`h-3.5 w-3.5 ${downloading ? "animate-spin" : ""}`} />
            {downloading ? "Saving…" : "Download"}
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Icon name="X" className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Image stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
        {count > 1 && (
          <button
            onClick={() => go(-1)}
            aria-label="Previous"
            className="absolute left-2 z-10 rounded-full border border-white/20 bg-black/40 p-2 text-white/80 transition-colors hover:bg-black/70 hover:text-white sm:left-4"
          >
            <Icon name="ChevronLeft" className="h-6 w-6" />
          </button>
        )}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.url}
          alt={current.caption ?? `Image ${index + 1}`}
          className="max-h-full max-w-full rounded-lg object-contain"
        />

        {count > 1 && (
          <button
            onClick={() => go(1)}
            aria-label="Next"
            className="absolute right-2 z-10 rounded-full border border-white/20 bg-black/40 p-2 text-white/80 transition-colors hover:bg-black/70 hover:text-white sm:right-4"
          >
            <Icon name="ChevronRight" className="h-6 w-6" />
          </button>
        )}
      </div>

      {/* Caption + thumbnail strip */}
      <div className="shrink-0 space-y-3 px-4 pb-4">
        {current.caption && (
          <p className="text-center text-sm text-white/80">{current.caption}</p>
        )}
        {count > 1 && (
          <div className="flex justify-center gap-2 overflow-x-auto pb-1">
            {images.map((img, i) => (
              <button
                key={i}
                onClick={() => onIndexChange(i)}
                className={`h-14 w-11 shrink-0 overflow-hidden rounded border transition-opacity ${
                  i === index ? "border-neon opacity-100" : "border-white/20 opacity-50 hover:opacity-100"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
