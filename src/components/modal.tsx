"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * Dialog shell: a fixed header, a scrolling body, and an optional pinned
 * footer.
 *
 * Title, description, body and actions used to share ONE scroll box under a
 * hard 720px cap, so a long form (the agent run brief, the intake panes) hid
 * its own submit button off screen and left hundreds of pixels of a tall
 * display unused. `footer` is the slot for the primary action: whatever goes
 * in it stays visible however far the body scrolls.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  /** Pinned action bar. Stays put while the body scrolls. */
  footer?: React.ReactNode;
  className?: string;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) {
      document.addEventListener("keydown", onKey);
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = prev;
      };
    }
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      // A portaled overlay is mounted on document.body, so it is NOT inside the
      // DOM subtree of whatever opened it. Any surface running an outside-click
      // dismissal (the copilot dock's sheet, CD-G9b) therefore reads a click in
      // here as "outside" and closes itself behind the dialog. This attribute is
      // how such a test recognises a click that is still inside the UI the user
      // is working in — an attribute rather than a class name so it survives
      // restyling and covers every overlay that portals through this component.
      data-overlay-root=""
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          // Capped, not uncapped: the body scrolls, so a content-heavy dialog
          // must not stretch to a tall monitor's full height. 1100px clears
          // F32's "Start run scrolls out of sight" on normal displays while
          // staying bounded on very tall ones.
          "relative z-10 flex max-h-[min(calc(100dvh-3rem),1100px)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface shadow-2xl animate-fade-up",
          className,
        )}
        role="dialog"
        aria-modal="true"
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 z-10 text-muted-2 transition-colors hover:text-foreground"
          aria-label="Close"
        >
          <Icon name="X" className="h-5 w-5" />
        </button>
        {(title || description) && (
          <div className="shrink-0 px-6 pt-6">
            {title && <h2 className="pr-8 text-lg font-semibold">{title}</h2>}
            {description && <p className="mt-1 pr-8 text-sm text-muted">{description}</p>}
          </div>
        )}
        {/* Spacing is kept identical to the single-box version on purpose: the
            inner wrapper carries the same mt-4 / pt-6 the old body applied, so
            no existing dialog shifts by a pixel from the restructure. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className={title || description ? "mt-4" : "pt-6"}>{children}</div>
        </div>
        {footer && <div className="shrink-0 border-t border-border px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
