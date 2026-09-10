"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";

export type LightboxImage = { url: string; caption?: string };

/**
 * Full-screen image viewer. Pages through every picture in an asset with
 * arrow keys / on-screen chevrons and downloads the whole post via a
 * server-side route (which sidesteps the storage host's CORS restrictions).
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  downloadUrl,
}: {
  images: LightboxImage[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** Server route that streams all of the post's images (zip for multi). */
  downloadUrl?: string;
}) {
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

  if (!current) return null;

  // Prefer the server route (works cross-origin); fall back to the raw image.
  const href = downloadUrl ?? current.url;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 p-4">
        <span className="font-mono text-xs text-white/70">
          {count > 1 ? `${index + 1} / ${count}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <a
            href={href}
            download
            className="inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20"
          >
            <Icon name="Download" className="h-3.5 w-3.5" />
            {count > 1 ? `Download all (${count})` : "Download"}
          </a>
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
