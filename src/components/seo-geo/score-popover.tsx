"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * CD-J1 directive 2: a score you can click to see what produced it.
 *
 * The headline on a presence tile is a percentage. The honest denominators - how
 * many questions we asked, how many named you, how many no engine could answer -
 * live in here, one click away, in plain sentences. That inversion is the whole
 * point: "Named in 0 of 12" put the arithmetic in front of the client and the
 * meaning nowhere.
 *
 * Anatomy follows the notification-bell popover (relative anchor, click-away
 * backdrop, absolutely-positioned glass panel) rather than introducing a second
 * popover pattern. Dumb by construction: the trigger and every line are supplied
 * by the server component, so no domain code enters the client bundle through it.
 */
export function ScorePopover({
  value,
  title,
  lines,
  srLabel,
}: {
  /** The headline the client sees and clicks - e.g. "62%". */
  value: string;
  title: string;
  lines: string[];
  /** Accessible name for the trigger, since the visible text is just a number. */
  srLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Escape returns focus to what opened the panel - a keyboard user must not
      // be dropped at the top of the document.
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          /* A REAL TARGET (round 6, WCAG 2.5.8): the trigger was the 16px glyph
             row alone. `min-h-6 py-0.5` gives it 24px without moving the
             figure, and the hover is the quiet-link rule (muted to foreground)
             rather than `hover:text-neon`, which is not a rule anywhere in
             globals.css and spent the accent on a hover over a number. The
             hover lands on the dotted underline (the affordance) rather than on
             the figure, because a score that changes colour under the mouse
             reads as a different score. */
          /* round 6 review (E13): NUMBERS ARE SANS. `stat-number` (sans face,
             tabular numerals) rather than `font-mono` — this figure is the same
             kind of number, at the same size, as Home's KPIs, and globals.css's
             header states the rule the mono face broke here. Size and weight
             are unchanged. */
          "stat-number focus-ring inline-flex min-h-6 items-baseline gap-1 rounded-md py-0.5 text-2xl font-medium text-foreground",
          "underline decoration-muted-3 decoration-dotted decoration-1 underline-offset-4 transition-colors",
          "hover:decoration-foreground",
        )}
      >
        <span className="sr-only">{srLabel}</span>
        <span aria-hidden>{value}</span>
        <Icon name="Info" aria-hidden className="h-3 w-3 shrink-0 self-center text-muted-2" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            id={panelId}
            role="dialog"
            aria-label={title}
            className={cn(
              "absolute left-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)]",
              "rounded-md border border-border glass-surface p-3 text-left shadow-2xl",
            )}
          >
            <p className="mb-1.5 text-xs font-semibold text-foreground">{title}</p>
            <div className="space-y-1.5">
              {lines.map((line, i) => (
                <p key={i} className="text-xs leading-relaxed text-muted">
                  {line}
                </p>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
