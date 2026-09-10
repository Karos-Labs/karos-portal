"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Focusable descendants of `container`, in DOM order, skipping disabled ones. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled"),
  );
}

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
  closeOnBackdrop = true,
  scrollRef,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  /** Pinned action bar. Stays put while the body scrolls. */
  footer?: React.ReactNode;
  className?: string;
  /**
   * Set false when a stray click outside would discard typed input. Escape and
   * the ✕ still close - those are deliberate gestures.
   */
  closeOnBackdrop?: boolean;
  /**
   * The one element that scrolls, handed to callers that swap their content in
   * place: only the caller knows when a swap has left the reader mid-document.
   * The title and description sit in the sticky header ABOVE this element
   * (F32's split body), so scrolling it to 0 restores the top of the content
   * without moving the heading.
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Traps Tab/Shift+Tab inside the panel so focus cannot walk out into the
    // page underneath - a dialog with no trap otherwise lets keyboard focus
    // continue past its last control straight onto whatever the backdrop covers.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
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
  // the page underneath. The first focusable element inside is the target -
  // the panel itself (tabIndex -1) is only the fallback for a body with
  // nothing focusable in it - and focus returns to the opener on the way out.
  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const opener = document.activeElement as HTMLElement | null;
    if (panel && !panel.contains(opener)) {
      const first = getFocusable(panel)[0];
      (first ?? panel).focus({ preventScroll: true });
    }
    return () => {
      // An opener that unmounted with the dialog simply gets no focus back.
      opener?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      // A portaled overlay is mounted on document.body, so it is NOT inside the
      // DOM subtree of whatever opened it. Any surface running an outside-click
      // dismissal (the copilot dock's sheet, CD-G9b) therefore reads a click in
      // here as "outside" and closes itself behind the dialog. This attribute is
      // how such a test recognises a click that is still inside the UI the user
      // is working in - an attribute rather than a class name so it survives
      // restyling and covers every overlay that portals through this component.
      data-overlay-root=""
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        {...(closeOnBackdrop ? { onClick: onClose } : {})}
      />
      <div
        ref={panelRef}
        // Focus target only - a container draws no ring of its own.
        tabIndex={-1}
        className={cn(
          // Capped, not uncapped: the body scrolls, so a content-heavy dialog
          // must not stretch to a tall monitor's full height. 1100px clears
          // F32's "Start run scrolls out of sight" on normal displays while
          // staying bounded on very tall ones. focus:outline-none because the
          // panel is only a focus TARGET (tabIndex -1) - a container drawing a
          // ring of its own would ring the whole dialog on open.
          "relative z-10 flex max-h-[min(calc(100dvh-3rem),1100px)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface shadow-2xl animate-fade-up focus:outline-none",
          className,
        )}
        role="dialog"
        aria-modal="true"
      >
        <button
          onClick={onClose}
          className="focus-ring absolute right-4 top-4 z-10 rounded-md text-muted-2 transition-colors hover:text-foreground"
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
        <div
          className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
          {...(scrollRef ? { ref: scrollRef } : {})}
        >
          <div className={title || description ? "mt-4" : "pt-6"}>{children}</div>
        </div>
        {footer && <div className="shrink-0 border-t border-border px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The same four slots as `Modal` — title, description, body, footer — drawn IN
 * THE PAGE instead of over it.
 *
 * WHY THIS EXISTS. An agent's page used to open with one giant button whose
 * only job was to open a dialog holding the fields that agent needs. Albert,
 * 2026-09-10: "a huge ai button and then a pop up once you click it". The
 * fields were always known in advance — `custom-agent-launch.ts` declares every
 * agent's inputs as data — so the button was a gate in front of a form that
 * could simply have been on the page, and the dialog was a second place to look
 * for something the page was already about.
 *
 * SAME PROPS AS `Modal`, INCLUDING THE ONES IT IGNORES, on purpose. The run
 * dialog is ~900 lines of real logic (engine routing, credit quotes, intake
 * readiness, submission) and it draws through `Modal` in three places. Taking
 * an identical interface means the caller chooses a shell with one line —
 * `const Shell = inline ? InlinePanel : Modal` — and none of that logic is
 * rewritten, re-tested or put at risk to move where it paints.
 *
 * What a page does not need from a dialog is dropped rather than imitated: no
 * portal, no backdrop, no focus trap, no body scroll lock, no ✕. A form that is
 * part of the page is closed by scrolling past it. `open: false` still renders
 * nothing, so a caller that toggles it behaves the same in both shells.
 */
export function InlinePanel({
  open = true,
  title,
  description,
  children,
  footer,
  scrollRef,
}: {
  open?: boolean;
  /** Accepted for parity with `Modal`; an in-page panel has nothing to close. */
  onClose?: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * Accepted and IGNORED: the dialog passes `max-w-2xl`/`max-w-3xl`, which is
   * right for a floating panel and wrong in a page column, where the form
   * should take the column's width like every other section on it.
   */
  className?: string;
  /** Accepted for parity with `Modal`. */
  closeOnBackdrop?: boolean;
  /**
   * Still attached, to the body. The dialog scrolls this to the top when it
   * swaps panes; on an element that does not scroll that is a harmless no-op,
   * which is exactly right — the page's own scroll is not this panel's to move.
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  if (!open) return null;
  return (
    <section className="rounded-[var(--radius)] border border-border bg-surface">
      {(title || description) && (
        <div className="px-5 pt-5">
          {title && <h2 className="text-base font-semibold text-foreground">{title}</h2>}
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
      )}
      <div className="px-5 pb-5" {...(scrollRef ? { ref: scrollRef } : {})}>
        <div className={title || description ? "mt-4" : "pt-5"}>{children}</div>
      </div>
      {footer && <div className="border-t border-border px-5 py-4">{footer}</div>}
    </section>
  );
}
