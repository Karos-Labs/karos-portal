"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * The one row chrome Home's two lists share — "Next actions"
 * (home-action-list.tsx) and "Recommended tasks" (home-recommended-tasks.tsx).
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09. The product owner's ruling collapsed both
 * lists onto the same two gestures: "It shouldn't be just Approve or Skip: it
 * should be an X-out or a 'Let's do this' button". Two lists that sit inches
 * apart on the same screen and offer the same pair of gestures must not render
 * them at two sizes, in two orders or with two hover behaviours — so the row is
 * built ONCE here and both widgets pass data into it, rather than each keeping
 * its own copy to drift.
 *
 * THE CONTROLS ARE ALWAYS VISIBLE. The previous "Next actions" row revealed its
 * buttons on `group-hover` with an `[@media(hover:none)]` fallback, which meant
 * a keyboard or touch reader had to discover them. The primary gesture of the
 * row is now one of these two buttons (the row itself is no longer a link), so
 * a hidden control is a hidden feature. Any change here must keep them
 * reachable without a pointer.
 */
export function HomeTaskRow({
  icon,
  title,
  description,
  meta,
  error,
  muted = false,
  trailing,
  dismiss,
  start,
  busy = false,
}: {
  /** Lucide icon name, rendered in the leading disc. Omit for a disc-less row. */
  icon?: string;
  title: string;
  /** Two lines at most — a proposal's rationale, never a second title. */
  description?: string;
  /** The executor/platform chip, above the title. */
  meta?: ReactNode;
  error?: string;
  /** Done / snoozed rows: same chrome, dimmed, usually with no controls. */
  muted?: boolean;
  /** A status word (e.g. "Snoozed") shown where the controls would be. */
  trailing?: ReactNode;
  /** The X. `label` is the accessible name — the button is icon-only. */
  dismiss?: { label: string; onClick: () => void };
  /** "Let's do this" — a Link, because it navigates to the task's inputs. */
  start?: { href: string; label?: string };
  busy?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5 transition-colors hover:border-border-strong",
        muted && "opacity-60",
      )}
    >
      {icon && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3">
          <Icon name={icon} className="h-3.5 w-3.5 text-muted-2" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {meta && <div className="mb-1 flex flex-wrap items-center gap-1.5">{meta}</div>}
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-2">{description}</p>}
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {trailing}
        {dismiss && (
          <button
            type="button"
            aria-label={dismiss.label}
            title={dismiss.label}
            onClick={dismiss.onClick}
            disabled={busy}
            className="rounded p-1.5 text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-40"
          >
            <Icon name="X" className="h-3.5 w-3.5" />
          </button>
        )}
        {start && (
          <Link
            href={start.href}
            className="inline-flex items-center gap-1.5 rounded-md bg-neon px-3 py-1.5 text-xs font-semibold text-accent-ink transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-10px_color-mix(in_srgb,var(--neon)_55%,transparent)]"
          >
            {start.label ?? "Let's do this"}
          </Link>
        )}
      </div>
    </div>
  );
}
