"use client";

import * as React from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) {
      document.addEventListener("keydown", onKey);
      // Prevent the page behind the modal from scrolling.
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = prev;
      };
    }
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 md:items-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          // Cap to the viewport so a tall form never clips its header/footer;
          // the body scrolls internally instead.
          "relative z-10 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface shadow-2xl animate-fade-up",
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
        <div className="overflow-y-auto p-6">
          {title && <h2 className="pr-8 text-lg font-semibold">{title}</h2>}
          {description && <p className="mt-1 pr-8 text-sm text-muted">{description}</p>}
          <div className={title ? "mt-4" : ""}>{children}</div>
        </div>
      </div>
    </div>
  );
}
