"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  closeOnBackdrop = true,
  scrollRef,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Set false when a stray click outside would discard typed input. Escape and
   * the ✕ still close — those are deliberate gestures.
   */
  closeOnBackdrop?: boolean;
  /**
   * The one element that scrolls, handed to callers that swap their content in
   * place: the title and description live inside it, so only the caller knows
   * when a swap has left them above the fold.
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);

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

  // No caller focuses a field of its own, so without this the control that
  // opened the dialog keeps focus behind the backdrop and the next Tab walks
  // the page underneath. The panel is the target because it is the one element
  // every caller has, and focus returns to the opener on the way out.
  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const opener = document.activeElement as HTMLElement | null;
    if (panel && !panel.contains(opener)) panel.focus({ preventScroll: true });
    return () => {
      // An opener that unmounted with the dialog simply gets no focus back.
      opener?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        {...(closeOnBackdrop ? { onClick: onClose } : {})}
      />
      <div
        ref={panelRef}
        // Focus target only — a container draws no ring of its own.
        tabIndex={-1}
        className={cn(
          "relative z-10 flex max-h-[min(calc(100dvh-2rem),720px)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface shadow-2xl animate-fade-up focus:outline-none",
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
        <div className="overflow-y-auto p-6" {...(scrollRef ? { ref: scrollRef } : {})}>
          {title && <h2 className="pr-8 text-lg font-semibold">{title}</h2>}
          {description && <p className="mt-1 pr-8 text-sm text-muted">{description}</p>}
          <div className={title ? "mt-4" : ""}>{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
