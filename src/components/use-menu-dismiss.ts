"use client";

import { useEffect, useRef } from "react";

/**
 * ESCAPE CLOSES A MENU, AND THE FOCUS COMES BACK (review wave, 2026-09).
 *
 * The three account-zone dropdowns at the foot of both rails — the staff
 * `UserMenu`, the client-context picker beside it, and the `AccountMenu` both
 * shells mount — each closed only on an outside click or a navigation. A
 * keyboard user who opened one had no way to dismiss it without tabbing through
 * every row inside, and when it did close the focus was left on whatever the
 * pointer had dismissed it with, i.e. nowhere near the control they came from.
 *
 * One hook rather than three copies of the same effect: the rule is the same
 * rule in all three places, and the codebase's existing statement of it
 * (`MoreActionsMenu`) is inside a component that cannot be reused here — those
 * three menus own their own trigger markup, their own anchoring and their own
 * open state.
 *
 * `setOpen` is deliberately typed as the `useState` setter the three callers
 * already hold: it is referentially stable, so this effect subscribes once per
 * open rather than on every render of the menu's contents.
 *
 * Returns the ref to put on the TRIGGER. Focus goes back there on Escape and
 * only on Escape: an outside click has already moved the reader's attention
 * somewhere deliberate, and yanking focus back from it would be the louder bug.
 */
export function useMenuDismiss(open: boolean, setOpen: (open: boolean) => void) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Stop here: these menus can sit inside the mobile drawer and the Company
      // sheet, both of which close on Escape themselves. One press should
      // dismiss one layer, the innermost.
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  return triggerRef;
}
