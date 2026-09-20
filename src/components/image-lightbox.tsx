"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { getFocusable } from "@/components/modal";

export type LightboxImage = { url: string; caption?: string };

/**
 * Full-screen image viewer. Pages through every picture in an asset with
 * arrow keys / on-screen chevrons and downloads the whole post via a
 * server-side route (which sidesteps the storage host's CORS restrictions).
 *
 * It is a DIALOG, and carries the same four guarantees `Modal` does — role and
 * `aria-modal`, a Tab trap, focus moved in on open and handed back to whatever
 * opened it on close, and a locked body scroll. It had none of them while it
 * was only ever opened from an asset card; the gate-review surface opens it
 * over a form full of textareas and star buttons (see
 * `agent-engine-gate-approval.tsx`), where focus escaping the overlay lands the
 * reviewer in controls they cannot see.
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
  const panelRef = React.useRef<HTMLDivElement>(null);

  const go = React.useCallback(
    (delta: number) => {
      if (count < 2) return;
      onIndexChange((index + delta + count) % count);
    },
    [count, index, onIndexChange],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowRight") {
        go(1);
        return;
      }
      if (e.key === "ArrowLeft") {
        go(-1);
        return;
      }
      if (e.key !== "Tab") return;
      // Same trap as `Modal`'s, on the same `getFocusable` rule: without it Tab
      // walks past the close button onto the page the backdrop covers.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = getFocusable(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [go, onClose]);

  // Focus in on open, back to the opener on close. The opener is read at mount
  // (it is still the active element at that point — the click that opened the
  // viewer left focus on the trigger) and an opener that unmounted with the
  // viewer simply gets no focus back.
  React.useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement as HTMLElement | null;
    if (panel && !panel.contains(opener)) {
      const first = getFocusable(panel)[0];
      (first ?? panel).focus({ preventScroll: true });
    }
    return () => {
      opener?.focus({ preventScroll: true });
    };
  }, []);

  if (!current) return null;

  // Prefer the server route (works cross-origin); fall back to the raw image.
  const href = downloadUrl ?? current.url;

  return createPortal(
    <div
      // Why this attribute: see `Modal`'s own note — a portalled overlay is not
      // in the DOM subtree of whatever opened it, so a surface running an
      // outside-click dismissal reads a click in here as "outside".
      data-overlay-root=""
      // `--focus` is ink in both themes, and the viewer's chrome is
      // permanently dark whichever theme the app is in (as its white/… tints
      // already are), so the shared `.focus-ring` recipe is rebound here rather
      // than each control growing a ring recipe of its own.
      style={{ "--focus": "#ffffff" } as React.CSSProperties}
      className="fixed inset-0 z-50"
    >
      {/* The backdrop is its own element so that a click on it closes the
          viewer while a click on a control or on the picture itself does not —
          one handler on the whole overlay cannot tell those apart. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/85 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        // Focus target only when there is nothing focusable inside; a container
        // draws no ring of its own.
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={current.caption ? `Image viewer · ${current.caption}` : "Image viewer"}
        // `pointer-events-none`, with each control and the picture turning it
        // back on: the dialog is a full-viewport flex column, so without this it
        // blankets the backdrop and "click the dark to close" silently does
        // nothing anywhere. The alternative — one handler testing
        // `e.target === e.currentTarget` — has to be repeated on every layout
        // container and goes stale the moment one is added.
        className="pointer-events-none relative z-10 flex h-full w-full flex-col focus:outline-none"
      >
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="font-mono text-xs text-white/70">
            {count > 1 ? `${index + 1} / ${count}` : ""}
          </span>
          <div className="flex items-center gap-2">
            <a
              href={href}
              download
              className="pointer-events-auto focus-ring inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20"
            >
              <Icon name="Download" className="h-3.5 w-3.5" />
              {count > 1 ? `Download all (${count})` : "Download"}
            </a>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="pointer-events-auto focus-ring rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Icon name="X" className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Image stage */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
          {count > 1 && (
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous"
              className="pointer-events-auto focus-ring absolute left-2 z-10 rounded-full border border-white/20 bg-black/40 p-2 text-white/80 transition-colors hover:bg-black/70 hover:text-white sm:left-4"
            >
              <Icon name="ChevronLeft" className="h-6 w-6" />
            </button>
          )}

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.url}
            alt={current.caption ?? `Image ${index + 1}`}
            className="pointer-events-auto max-h-full max-w-full rounded-lg object-contain"
          />

          {count > 1 && (
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next"
              className="pointer-events-auto focus-ring absolute right-2 z-10 rounded-full border border-white/20 bg-black/40 p-2 text-white/80 transition-colors hover:bg-black/70 hover:text-white sm:right-4"
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
          {/* Pointer events on for the strip as a whole, not just its buttons:
              it is a horizontal scroller, and a scroller that does not take the
              pointer cannot be dragged or wheeled. */}
          {count > 1 && (
            <div className="pointer-events-auto flex justify-center gap-2 overflow-x-auto pb-1">
              {images.map((img, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onIndexChange(i)}
                  aria-label={`Show image ${i + 1} of ${count}`}
                  aria-current={i === index}
                  className={`pointer-events-auto focus-ring h-14 w-11 shrink-0 overflow-hidden rounded border transition-opacity ${
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
      </div>
    </div>,
    document.body,
  );
}
