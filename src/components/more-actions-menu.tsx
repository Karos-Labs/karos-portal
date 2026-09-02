"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * A page header's secondary actions, behind one trigger (2026-09).
 *
 * WHY IT EXISTS. The client AI agents page opened with three equal-weight
 * buttons in its header — Import lab outputs, Bulk upload clips, Re-plan
 * calendar — plus a "Manage integrations" link. All four are occasional: one is
 * only mounted when the lab bucket is configured at all, and the re-plan
 * control's own docstring calls itself a recovery path for "the rare case where
 * one of those best-effort calls failed". Three buttons of equal weight say
 * "these are the things you do here", and none of them is.
 *
 * ── THE CHILDREN STAY MOUNTED WHEN THIS IS CLOSED ────────────────────────
 *
 * The panel is hidden with `display: none`, never unmounted, and that is
 * load-bearing rather than lazy. Every action in here is a button that opens a
 * MODAL held in that same component's own state: unmounting the trigger would
 * take the open dialog with it, so the reader would press "Import lab outputs"
 * and get nothing. The modals themselves render through `createPortal` to
 * <body>, so they are unaffected by an ancestor being hidden — which is exactly
 * what makes hide-don't-unmount work here.
 *
 * ── AND PICKING AN ITEM DOES NOT CLOSE IT ────────────────────────────────
 *
 * Unusual for a menu, and deliberate, because of what is IN this one. Every
 * item is one of three shapes and none of them wants a close:
 *
 *  • the two modal triggers cover the menu with a dialog anyway, so closing
 *    underneath it only decides where the reader lands when the dialog goes;
 *  • Re-plan calendar REPORTS BACK INTO THE ROW ("Re-planned 3 posts", "Calendar
 *    already in order"). Closing on click hides its own only feedback, which is
 *    a control that silently does something — the exact defect the badge on
 *    `channelsHref` and the old plain-text "Reconnect" were both fixed for;
 *  • "Manage integrations" is a navigation, which unmounts the whole header.
 *
 * So the menu closes on Escape, on an outside click, or on navigation. Nothing
 * needs it to close on selection, and one item is actively worse for it.
 */
export function MoreActionsMenu({
  children,
  label = "More actions",
}: {
  children: React.ReactNode;
  /** The trigger's accessible name. Also its visible text above `sm`. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      // A click that lands inside an open MODAL is not an outside click: the
      // dialog is portalled to <body>, so `contains` on this root says false
      // for every control in it. Without the `[role=dialog]` test the menu
      // would fold shut behind the very dialog it opened, and the reader would
      // come back from that dialog to a closed menu.
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (target.closest("[role='dialog']")) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted transition-colors hover:border-neon/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25",
          open && "border-border-strong text-foreground",
        )}
      >
        <Icon name="Ellipsis" className="h-3.5 w-3.5" />
        {label}
      </button>

      <div
        role="menu"
        aria-label={label}
        // Hidden, not unmounted — see the note above.
        className={cn(
          "absolute right-0 z-40 mt-1.5 w-60 rounded-[var(--radius)] border border-border p-1.5 shadow-[var(--shadow-2)] glass-surface",
          !open && "hidden",
        )}
      >
        <div className="flex flex-col gap-1 [&_button]:w-full [&_button]:justify-start [&_a]:w-full">
          {children}
        </div>
      </div>
    </div>
  );
}
